import { ACTION_TYPES, buildActionDeck, buildActionGameDeck } from './actionDeck.js';
import { shuffle } from './deck.js';

const COLUMNS = [[0, 4, 8], [1, 5, 9], [2, 6, 10], [3, 7, 11]];
const ROWS = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]];
const BOARD_SLOT_COUNT = 12;
const ROUND_BREAK_MS = 10_000;
const ROUND_SCORE_PREVIEW_MS = 3_000;
const DEFENSE_PROMPT_MS = 5_000;
const ACTION_PLAY_POPUP_MS = 4_500;
const PEEK_PREVIEW_MS = 12_000;
const TEMP_GRANT_ALL_ACTION_CARDS = false;
const ACTION_MARKET_SIZE = 4;
const ACTION_DECK_SIZE = ACTION_TYPES.length * 3;

function log(state, msg) {
  state.log.push({ t: Date.now(), msg });
  if (state.log.length > 100) state.log.shift();
}

function recordCardMove(state, move) {
  state.cardMoveSerial = (state.cardMoveSerial || 0) + 1;
  state.lastCardMove = {
    id: `${state.roundNumber}:${state.cardMoveSerial}`,
    ...move,
  };
}

function connectedIds(state) {
  return state.order.filter((id) => state.playersById[id]?.connected);
}

function currentPlayerId(state) {
  return state.order[state.turnIndex];
}

function assertBoardSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= BOARD_SLOT_COUNT) {
    throw new Error('Emplacement invalide.');
  }
  return slotIndex;
}

function getOwnPlayer(state, playerId) {
  if (!playerId || !Object.prototype.hasOwnProperty.call(state.playersById, playerId)) return null;
  return state.playersById[playerId];
}

function emptyBoard() {
  return Array.from({ length: 12 }, () => ({ card: null, faceUp: false, removed: false }));
}

function ensureActionFields(state) {
  state.actionDeck ||= [];
  state.actionDiscard ||= [];
  state.actionMarket ||= [];
  state.lastPlayedAction ||= null;
  state.pendingAction ||= null;
  state.pendingStarClaim ||= null;
  state.pendingGroupChoice ||= null;
  state.turnSerial ||= 0;
  state.extraTurns ||= {};
  for (const id of state.order) {
    const player = state.playersById[id];
    player.actionCards ||= [];
    player.starBonus ||= 0;
    player.peek ||= null;
    player.groupChoiceSkips ||= {};
  }

  if (state.gameMode === 'action'
    && state.roundNumber > 0
    && state.actionDiscard.length === 0
    && state.actionDeck.length > 0) {
    seedPlayableActionDiscard(state);
  }

  const pending = state.pendingAction;
  if (pending?.type === 'peekLine' && pending.selection?.peekFirst) {
    const { playerId, slotIndex } = pending.selection.peekFirst;
    const firstSlot = state.playersById[playerId]?.board?.[slotIndex];
    if (!firstSlot || firstSlot.removed || firstSlot.faceUp) {
      pending.selection = null;
    }
  }

  if (pending?.type === 'playDiscard'
    && replayableDiscardCards(state, pending.playerId).length === 0) {
    discardPlayedAction(state, pending.card);
    finishAction(state);
    return;
  }

  if (state.pendingStarClaim && !prepareActionClaimChoices(state)) {
    log(state, 'Aucune carte Action n’est disponible : le bonus Étoile est ignoré.');
    resumeAfterStarClaim(state);
    return;
  }

  const actionIsOrphaned = state.gameMode === 'action'
    && state.phase === 'playing'
    && state.turnStage === 'action'
    && !state.pendingAction
    && !state.pendingStarClaim
    && !state.pendingGroupChoice;
  if (actionIsOrphaned) state.turnStage = 'choose';
}

function grantTemporaryPlayableActionCards(state, playerId) {
  if (!TEMP_GRANT_ALL_ACTION_CARDS) return;
  const player = state.playersById[playerId];
  if (!player) return;

  const existingTypes = new Set(player.actionCards.map((card) => card.type));
  for (const type of ACTION_TYPES) {
    if (existingTypes.has(type)) continue;
    state.temporaryActionCardSerial = (state.temporaryActionCardSerial || 0) + 1;
    player.actionCards.push({
      id: `temp-action-${state.roundNumber}-${playerId}-${type}-${state.temporaryActionCardSerial}`,
      kind: 'action',
      type,
      temporary: true,
      availableAt: -1,
    });
  }
}

function grantTemporaryPlayableActionCardsForAll(state) {
  if (!TEMP_GRANT_ALL_ACTION_CARDS) return;
  for (const id of state.order) {
    grantTemporaryPlayableActionCards(state, id);
  }
}

function refillGameDeck(state) {
  if (state.deck.length > 0) return;
  const top = state.discard.at(-1);
  const rest = state.discard.slice(0, -1);
  if (!top || rest.length === 0) throw new Error('Plus assez de cartes pour reconstituer la pioche.');
  state.deck = shuffle(rest);
  state.discard = [top];
}

function availableGameDrawCount(state) {
  return state.deck.length + Math.max(0, state.discard.length - 1);
}

function availableActionDeckCount(state) {
  return state.actionDeck.length + Math.max(0, state.actionDiscard.length - 1);
}

function tryRefillActionDeck(state) {
  if (state.actionDeck.length > 0) return true;
  const discardTop = state.actionDiscard.at(-1);
  const recyclableCards = state.actionDiscard.slice(0, -1);
  if (recyclableCards.length === 0) return false;
  state.actionDeck = shuffle(recyclableCards);
  state.actionDiscard = discardTop ? [discardTop] : [];
  return state.actionDeck.length > 0;
}

function refillActionDeck(state, { allowDiscardTop = false } = {}) {
  if (tryRefillActionDeck(state)) return;
  if (allowDiscardTop && state.actionDiscard.length > 0) {
    state.actionDeck = shuffle(state.actionDiscard);
    state.actionDiscard = [];
    return;
  }
  throw new Error('La pioche Action est vide.');
}

function refillMarket(state, { strict = true } = {}) {
  while (state.actionMarket.length < ACTION_MARKET_SIZE) {
    if (!tryRefillActionDeck(state)) {
      if (strict) throw new Error('La pioche Action est vide.');
      break;
    }
    state.actionMarket.push(state.actionDeck.pop());
  }
}

function seedPlayableActionDiscard(state, { strict = false } = {}) {
  const discardIndex = state.actionDeck.findLastIndex((card) => (
    state.order.every((playerId) => !actionUnavailableReason(state, playerId, card, { fromDiscard: true }))
  ));
  if (discardIndex < 0) {
    if (strict) throw new Error('Aucune carte Action ne peut initialiser la défausse.');
    return false;
  }
  state.actionDiscard.push(state.actionDeck.splice(discardIndex, 1)[0]);
  return true;
}

function prepareActionClaimChoices(state) {
  refillMarket(state, { strict: false });
  if (state.actionMarket.length > 0 || availableActionDeckCount(state) > 0) return true;

  const lastDiscardedAction = state.actionDiscard.pop();
  if (lastDiscardedAction) {
    state.actionMarket.push(lastDiscardedAction);
    return true;
  }
  return false;
}

function giveActionCard(state, playerId, source, marketIndex) {
  const player = state.playersById[playerId];
  let card;
  if (source === 'market') {
    if (!Number.isInteger(marketIndex) || !state.actionMarket[marketIndex]) {
      throw new Error('Carte Action visible invalide.');
    }
    card = state.actionMarket[marketIndex];
    if (tryRefillActionDeck(state)) {
      state.actionMarket[marketIndex] = state.actionDeck.pop();
    } else {
      state.actionMarket.splice(marketIndex, 1);
    }
  } else if (source === 'deck') {
    refillActionDeck(state);
    card = state.actionDeck.pop();
  } else {
    throw new Error('Source de carte Action invalide.');
  }
  player.actionCards.push({ ...card, availableAt: state.turnSerial + 1 });
  return card;
}

function beginStarClaim(state, playerId, resume) {
  state.pendingStarClaim = { playerId, resume };
  state.turnStage = 'starClaim';
  if (!prepareActionClaimChoices(state)) {
    log(state, 'Aucune carte Action n’est disponible : le bonus Étoile est ignoré.');
    resumeAfterStarClaim(state);
  }
}

function resumeAfterStarClaim(state) {
  const resume = state.pendingStarClaim?.resume;
  state.pendingStarClaim = null;
  if (resume === 'advance') advanceTurn(state);
  else if (resume === 'finishAction') finishAction(state);
  else if (resume === 'initial') {
    state.turnStage = null;
    startRoundIfReady(state);
  } else {
    state.turnStage = resume || 'choose';
  }
}

function isStar(card) {
  return card?.kind === 'star';
}

function groupMatches(slots) {
  if (!slots.every((slot) => slot.faceUp && !slot.removed && slot.card)) return false;
  const numbers = slots.filter((slot) => !isStar(slot.card)).map((slot) => slot.card.value);
  return numbers.length === 0 || numbers.every((value) => value === numbers[0]);
}

function groupSignature(slots) {
  return slots
    .map((slot) => `${slot.card?.id || '?'}:${slot.card?.kind || 'number'}:${slot.card?.value ?? '?'}`)
    .join('|');
}

function groupChoiceKey(groupType, groupIndex) {
  return `${groupType}:${groupIndex}`;
}

function groupSnapshot(indexes, slots) {
  return indexes.map((slotIndex, index) => {
    const card = slots[index].card;
    return {
      slotIndex,
      value: card?.value ?? null,
      kind: card?.kind || 'number',
    };
  });
}

function removeCompletedGroup(state, player, indexes, starBonus) {
  const slots = indexes.map((index) => player.board[index]);
  const allStars = slots.every((slot) => isStar(slot.card));
  const cards = slots.map((slot) => slot.card).filter(Boolean);
  const starCards = cards.filter(isStar);
  const nonStarCards = cards.filter((card) => !isStar(card));
  const discardOrder = allStars
    ? cards
    : [...starCards, ...nonStarCards];

  state.discard.push(...discardOrder);
  for (const slot of slots) {
    slot.card = null;
    slot.removed = true;
  }
  if (allStars) player.starBonus += starBonus;
  log(state, `${player.name} réalise un Skyjo.`);
}

function actionTargetsAfterActor(state, actorId) {
  const actorIndex = state.order.indexOf(actorId);
  if (actorIndex < 0) return connectedIds(state).filter((id) => id !== actorId);

  const ordered = [];
  for (let offset = 1; offset < state.order.length; offset += 1) {
    const id = state.order[(actorIndex + offset) % state.order.length];
    if (id !== actorId && state.playersById[id]?.connected) ordered.push(id);
  }
  return ordered;
}

function beginGroupChoice(state, player, groupType, groupIndex, indexes, slots, starBonus, resume) {
  const signature = groupSignature(slots);
  const key = groupChoiceKey(groupType, groupIndex);
  state.pendingGroupChoice = {
    id: `group-choice-${Date.now()}-${player.id}-${key}`,
    playerId: player.id,
    playerName: player.name,
    groupType,
    groupIndex,
    key,
    signature,
    indexes,
    cards: groupSnapshot(indexes, slots),
    allStars: slots.every((slot) => isStar(slot.card)),
    starBonus,
    resume,
  };
  state.turnStage = 'groupChoice';
}

function clearCompletedGroups(state, player, resume = { type: 'none' }, { promptStarGroups = true } = {}) {
  if (state.pendingGroupChoice) return true;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [groupType, groups, starBonus] of [['column', COLUMNS, -10], ['row', ROWS, -15]]) {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const indexes = groups[groupIndex];
        const slots = indexes.map((index) => player.board[index]);
        if (!groupMatches(slots)) continue;
        const hasStar = slots.some((slot) => isStar(slot.card));
        if (hasStar && promptStarGroups) {
          const key = groupChoiceKey(groupType, groupIndex);
          const signature = groupSignature(slots);
          if (player.groupChoiceSkips?.[key] === signature) continue;
          beginGroupChoice(state, player, groupType, groupIndex, indexes, slots, starBonus, resume);
          return true;
        }
        removeCompletedGroup(state, player, indexes, starBonus);
        changed = true;
      }
    }
  }
  return false;
}

function finishPendingAction(state) {
  const pending = state.pendingAction;
  if (!pending) return;
  discardPlayedAction(state, pending.card);
  finishAction(state);
}

function continueActionRoundEnd(state, playerIds = state.order) {
  const ids = playerIds.length ? playerIds : state.order;
  for (const id of ids) {
    const player = state.playersById[id];
    if (!player) continue;
    if (clearCompletedGroups(state, player, { type: 'completeActionRoundEnd', playerIds: ids })) return;
  }
  completeActionRoundEnd(state);
}

function continueAfterGroupChoice(state, resume = { type: 'none' }) {
  if (resume.type === 'advance') {
    advanceTurn(state);
    return;
  }

  if (resume.type === 'starClaim') {
    beginStarClaim(state, resume.playerId, resume.claimResume || 'advance');
    return;
  }

  if (resume.type === 'initial') {
    if (resume.star) beginStarClaim(state, resume.playerId, 'initial');
    else {
      state.turnStage = null;
      startRoundIfReady(state);
    }
    return;
  }

  if (resume.type === 'removeEachAfterTarget') {
    const pending = state.pendingAction;
    if (!pending) return;
    if (resume.replacementIsStar) {
      if (pending.remaining.length === 0) {
        discardPlayedAction(state, pending.card);
      }
      beginStarClaim(state, resume.targetId, pending.remaining.length === 0 ? 'finishAction' : 'action');
    } else {
      finishRemoveEachIfComplete(state, pending);
    }
    return;
  }

  if (resume.type === 'pendingActionAfterResolve') {
    const pending = state.pendingAction;
    if (!pending) return;
    if (resume.claimedStar) {
      discardPlayedAction(state, pending.card);
      state.pendingAction = null;
      beginStarClaim(state, resume.starPlayerId, 'advance');
    } else {
      finishPendingAction(state);
    }
    return;
  }

  if (resume.type === 'clearPlayersThenFinishAction') {
    const ids = resume.playerIds || [];
    const nextIds = [];
    for (const id of ids) {
      if (!nextIds.includes(id)) nextIds.push(id);
    }
    for (const id of nextIds) {
      const player = state.playersById[id];
      if (!player) continue;
      if (clearCompletedGroups(state, player, resume)) return;
    }
    finishPendingAction(state);
    return;
  }

  if (resume.type === 'completeActionRoundEnd') {
    continueActionRoundEnd(state, resume.playerIds || state.order);
    return;
  }

  state.turnStage = resume.turnStage || (state.phase === 'playing' ? 'choose' : null);
}

function boardFinished(player) {
  return player.board.every((slot) => slot.removed || slot.faceUp);
}

function revealRemainingCards(player) {
  const revealed = [];
  player.board.forEach((slot, slotIndex) => {
    if (!slot.removed && !slot.faceUp) {
      revealed.push({ playerId: player.id, slotIndex, card: slot.card });
      slot.faceUp = true;
    }
  });
  return revealed;
}

function startRoundIfReady(state) {
  const ids = state.order.filter((id) => state.playersById[id]);
  if (ids.length < 2 || !ids.every((id) => state.playersById[id].flippedCount >= 2)) return false;
  let starterId = state.actionNextStarterId;
  let starterLogMessage = null;
  if (!starterId || !ids.includes(starterId)) {
    const sums = ids.map((id) => {
      const sum = state.playersById[id].board
        .filter((slot) => slot.faceUp && !slot.removed)
        .reduce((total, slot) => total + (slot.card?.value || 0), 0);
      return { id, sum };
    });
    const best = Math.max(...sums.map(({ sum }) => sum));
    const tiedIds = sums.filter(({ sum }) => sum === best).map(({ id }) => id);
    starterId = tiedIds[0];
    if (tiedIds.length > 1) {
      const tiedNames = tiedIds.map((id) => state.playersById[id].name).join(', ');
      starterLogMessage = `Égalité pour commencer la manche Action entre ${tiedNames} (${best}). ${state.playersById[starterId].name} commence.`;
    }
  }
  state.turnIndex = state.order.indexOf(starterId);
  state.phase = 'playing';
  state.turnStage = 'choose';
  state.turnSerial += 1;
  if (starterLogMessage) {
    state.starterTieNotice = {
      id: `starter-tie-${state.roundNumber}-${Date.now()}`,
      message: starterLogMessage,
    };
  } else {
    state.starterTieNotice = null;
  }
  log(state, starterLogMessage || `${state.playersById[starterId].name} commence la manche Action.`);
  return true;
}

function dealRound(state) {
  ensureActionFields(state);
  state.deck = buildActionGameDeck();
  state.discard = [];
  state.actionDeck = buildActionDeck();
  state.actionDiscard = [];
  state.actionMarket = [];
  refillMarket(state);
  state.pendingAction = null;
  state.pendingStarClaim = null;
  state.pendingGroupChoice = null;
  state.roundEnderId = null;
  state.roundNumber += 1;
  state.extraTurns = {};
  for (const id of state.order) {
    const player = state.playersById[id];
    player.board = emptyBoard();
    player.flippedCount = 0;
    player.lastRoundScore = null;
    player.actionCards = [];
    player.starBonus = 0;
    player.peek = null;
    player.groupChoiceSkips = {};
    for (const slot of player.board) slot.card = state.deck.pop();
  }
  state.discard.push(state.deck.pop());
  seedPlayableActionDiscard(state, { strict: true });
  state.phase = 'initialFlip';
  state.turnStage = null;
  state.drawnCard = null;
  state.lastCardMove = null;
  state.nextRoundAt = null;
  state.roundScoresAt = null;
  state.starterTieNotice = null;
  grantTemporaryPlayableActionCardsForAll(state);
  log(state, `Manche Action ${state.roundNumber} : retournez 2 cartes.`);
}

export function startActionGame(state) {
  for (const id of state.order) state.playersById[id].totalScore = 0;
  state.completedRounds = 0;
  state.winnerId = null;
  state.actionNextStarterId = null;
  state.turnSerial = 0;
  dealRound(state);
}

export function flipInitialActionCard(state, playerId, slotIndex) {
  if (state.phase !== 'initialFlip') throw new Error('Pas la phase de retournement initial.');
  if (state.pendingStarClaim) throw new Error('Une carte Étoile doit d’abord être résolue.');
  const player = state.playersById[playerId];
  const slot = validateSlot(state, playerId, slotIndex);
  if (!slot || slot.faceUp || slot.removed || player.flippedCount >= 2) throw new Error('Carte invalide.');
  slot.faceUp = true;
  player.flippedCount += 1;
  const star = isStar(slot.card);
  if (clearCompletedGroups(state, player, { type: 'initial', playerId, star })) return;
  if (star) beginStarClaim(state, playerId, 'initial');
  else startRoundIfReady(state);
}

function advanceTurn(state) {
  const finishingId = currentPlayerId(state);
  const player = state.playersById[finishingId];
  const isFinalTurn = !!state.roundEnderId && finishingId !== state.roundEnderId;
  const finishedBoard = boardFinished(player);
  if (!state.roundEnderId && finishedBoard) {
    state.roundEnderId = finishingId;
    state.actionNextStarterId = finishingId;
    log(state, `${player.name} termine son plateau. Dernier tour.`);
  }
  if (finishedBoard) {
    state.extraTurns[finishingId] = 0;
  } else if ((state.extraTurns[finishingId] || 0) > 0) {
    state.extraTurns[finishingId] -= 1;
    state.turnStage = 'choose';
    state.drawnCard = null;
    state.turnSerial += 1;
    return;
  }
  const revealedBeforeRoundEnd = isFinalTurn ? revealRemainingCards(player) : [];
  const next = (state.turnIndex + 1) % state.order.length;
  if (state.roundEnderId && state.order[next] === state.roundEnderId) {
    endActionRound(state, revealedBeforeRoundEnd);
    return;
  }
  state.turnIndex = next;
  state.turnStage = 'choose';
  state.drawnCard = null;
  state.turnSerial += 1;
}

export function drawActionGameCard(state, playerId, source) {
  if (state.phase !== 'playing' || currentPlayerId(state) !== playerId || state.turnStage !== 'choose') {
    throw new Error('Action impossible.');
  }
  if (!['deck', 'discard'].includes(source)) throw new Error('Source de pioche invalide.');
  state.lastCardMove = null;
  if (source === 'discard') {
    if (!state.discard.length) throw new Error('Défausse vide.');
    state.drawnCard = { card: state.discard.pop(), from: 'discard' };
    state.turnStage = 'place';
  } else {
    refillGameDeck(state);
    state.drawnCard = { card: state.deck.pop(), from: 'deck' };
    state.turnStage = 'decide';
  }
  state.starterTieNotice = null;
}

export function decideActionGameCard(state, playerId, keep) {
  if (currentPlayerId(state) !== playerId || state.turnStage !== 'decide') throw new Error('Action impossible.');
  if (typeof keep !== 'boolean') throw new Error('Choix invalide.');
  if (keep) state.turnStage = 'place';
  else {
    state.discard.push(state.drawnCard.card);
    state.drawnCard = null;
    if (boardFinished(state.playersById[playerId])) advanceTurn(state);
    else state.turnStage = 'reveal';
  }
}

export function placeActionGameCard(state, playerId, slotIndex) {
  if (currentPlayerId(state) !== playerId || !['decide', 'place'].includes(state.turnStage)) throw new Error('Action impossible.');
  const player = state.playersById[playerId];
  const slot = validateSlot(state, playerId, slotIndex);
  if (!slot || slot.removed) throw new Error('Emplacement invalide.');
  const oldCard = slot.card;
  const oldFaceUp = slot.faceUp;
  const newCard = state.drawnCard.card;
  const source = state.drawnCard.from;
  slot.card = newCard;
  slot.faceUp = true;
  state.drawnCard = null;
  recordCardMove(state, {
    type: 'placement',
    playerId,
    slotIndex,
    source,
    newCard,
    oldCard,
    oldFaceUp,
    revealOldCard: true,
  });
  if (oldCard) state.discard.push(oldCard);
  if (clearCompletedGroups(state, player, isStar(newCard)
    ? { type: 'starClaim', playerId, claimResume: 'advance' }
    : { type: 'advance' })) return;
  if (isStar(newCard)) beginStarClaim(state, playerId, 'advance');
  else advanceTurn(state);
}

export function revealActionGameCard(state, playerId, slotIndex) {
  if (currentPlayerId(state) !== playerId || state.turnStage !== 'reveal') throw new Error('Action impossible.');
  const player = state.playersById[playerId];
  const slot = validateSlot(state, playerId, slotIndex);
  if (!slot || slot.faceUp || slot.removed) throw new Error('Carte invalide.');
  recordCardMove(state, {
    type: 'reveal',
    cards: [{ playerId, slotIndex, card: slot.card }],
  });
  slot.faceUp = true;
  if (clearCompletedGroups(state, player, isStar(slot.card)
    ? { type: 'starClaim', playerId, claimResume: 'advance' }
    : { type: 'advance' })) return;
  if (isStar(slot.card)) beginStarClaim(state, playerId, 'advance');
  else advanceTurn(state);
}

export function claimStarAction(state, playerId, source, marketIndex) {
  ensureActionFields(state);
  if (state.pendingStarClaim?.playerId !== playerId) throw new Error('Aucune carte Étoile à résoudre.');
  if (source === 'deck' && availableActionDeckCount(state) === 0) {
    throw new Error('La pioche Action est vide. Choisissez une carte visible.');
  }
  giveActionCard(state, playerId, source, marketIndex);
  resumeAfterStarClaim(state);
}

function findDefenseIndex(player, { includeTemporary = true } = {}) {
  return player?.actionCards?.findIndex((card) =>
    card.type === 'defense' && (includeTemporary || !card.temporary)) ?? -1;
}

function discardPlayedAction(state, card) {
  state.actionDiscard.push(card);
}

function discardActionCardUnderTop(state, card) {
  if (!card) return;
  if (state.actionDiscard.length === 0) {
    state.actionDiscard.push(card);
    return;
  }
  state.actionDiscard.splice(state.actionDiscard.length - 1, 0, card);
}

function discardGameCardUnderTop(state, card) {
  if (!card) return;
  if (state.discard.length === 0) {
    state.discard.push(card);
    return;
  }
  state.discard.splice(state.discard.length - 1, 0, card);
}

function finishAction(state) {
  const actorId = state.pendingAction?.playerId;
  state.pendingAction = null;
  grantTemporaryPlayableActionCardsForAll(state);
  if (actorId && currentPlayerId(state) !== actorId) {
    const actorIndex = state.order.indexOf(actorId);
    if (actorIndex >= 0) state.turnIndex = actorIndex;
  }
  advanceTurn(state);
}

function finishRemoveEachIfComplete(state, pending) {
  if (pending.remaining.length !== 0) return false;
  discardPlayedAction(state, pending.card);
  finishAction(state);
  return true;
}

function resolveRemoveEachTarget(state, pending, targetId, { slotIndex, actionCardId }) {
  const target = state.playersById[targetId];
  if (!target) throw new Error('Joueur cible invalide.');

  let replacementIsStar = false;
  if (Number.isInteger(slotIndex)) {
    const slot = validateSlot(state, targetId, slotIndex);
    const oldCard = slot.card;
    const oldFaceUp = slot.faceUp;
    discardGameCardUnderTop(state, slot.card);
    refillGameDeck(state);
    slot.card = state.deck.pop();
    replacementIsStar = isStar(slot.card);
    slot.faceUp = true;
    recordCardMove(state, {
      type: 'replacement',
      reason: 'removeEach',
      playerId: targetId,
      slotIndex,
      source: 'deck',
      newCard: slot.card,
      oldCard,
      oldFaceUp,
      revealOldCard: false,
    });
  } else if (actionCardId) {
    const actionIndex = target.actionCards.findIndex((card) => card.id === actionCardId);
    if (actionIndex < 0) throw new Error('Carte Action invalide.');
    const removedAction = target.actionCards.splice(actionIndex, 1)[0];
    discardActionCardUnderTop(state, removedAction);
    refillActionDeck(state, { allowDiscardTop: true });
    const replacement = state.actionDeck.pop();
    target.actionCards.push({ ...replacement, availableAt: state.turnSerial + 1 });
  } else {
    throw new Error('Carte à retirer invalide.');
  }

  pending.remaining = pending.remaining.filter((id) => id !== targetId);
  const resume = { type: 'removeEachAfterTarget', targetId, replacementIsStar };
  if (Number.isInteger(slotIndex) && clearCompletedGroups(state, target, resume)) return;
  continueAfterGroupChoice(state, resume);
}

function beginDefensePrompt(state, pending, targetId, details = {}) {
  const target = state.playersById[targetId];
  pending.defensePrompt = {
    id: `defense-${Date.now()}-${targetId}-${details.slotIndex ?? 'action'}`,
    type: pending.type,
    actorId: pending.playerId,
    targetId,
    targetName: target?.name || 'Joueur',
    ...details,
    expiresAt: Date.now() + DEFENSE_PROMPT_MS,
  };
  log(state, `${target?.name || 'Joueur'} possède une défense et doit choisir.`);
}

function completeStealAction(state, pending, targetId, cardId) {
  const actorId = pending.playerId;
  const target = state.playersById[targetId];
  if (!target || target.id === actorId || !target.connected) throw new Error('Joueur invalide.');
  const index = target.actionCards.findIndex((card) => card.id === cardId);
  if (index < 0) throw new Error('Carte Action invalide.');
  const stolen = target.actionCards[index];
  assertActionCanBegin(state, actorId, stolen);
  discardPlayedAction(state, pending.card);
  target.actionCards.splice(index, 1);
  executeNestedAction(state, actorId, stolen);
}

function findNextSwapDefenseTarget(state, pending, first, second) {
  const checked = new Set(pending.defenseChecked || []);
  const targets = [...new Set([first.playerId, second.playerId])];
  return targets.find((targetId) =>
    targetId !== pending.playerId
    && !checked.has(targetId)
    && findDefenseIndex(state.playersById[targetId]) >= 0);
}

function maybeBeginSwapDefensePrompt(state, pending, first, second) {
  const targetId = findNextSwapDefenseTarget(state, pending, first, second);
  if (!targetId) return false;
  pending.defenseChecked = [...new Set([...(pending.defenseChecked || []), targetId])];
  beginDefensePrompt(state, pending, targetId, { first, second });
  return true;
}

function completeSwapPlayersAction(state, pending, first, second) {
  if (!first || !second || first.playerId === second.playerId && first.slotIndex === second.slotIndex) {
    throw new Error('Choisissez deux cartes distinctes.');
  }
  const a = validateSlot(state, first.playerId, first.slotIndex);
  const b = validateSlot(state, second.playerId, second.slotIndex);
  if (maybeBeginSwapDefensePrompt(state, pending, first, second)) return;
  recordCardMove(state, {
    type: 'swap',
    moves: [
      {
        fromPlayerId: first.playerId,
        fromSlotIndex: first.slotIndex,
        toPlayerId: second.playerId,
        toSlotIndex: second.slotIndex,
        card: a.card,
        faceUp: a.faceUp,
      },
      {
        fromPlayerId: second.playerId,
        fromSlotIndex: second.slotIndex,
        toPlayerId: first.playerId,
        toSlotIndex: first.slotIndex,
        card: b.card,
        faceUp: b.faceUp,
      },
    ],
  });
  [a.card, b.card] = [b.card, a.card];
  [a.faceUp, b.faceUp] = [b.faceUp, a.faceUp];
  const resume = { type: 'clearPlayersThenFinishAction', playerIds: [first.playerId, second.playerId] };
  if (clearCompletedGroups(state, state.playersById[first.playerId], resume)) return;
  if (clearCompletedGroups(state, state.playersById[second.playerId], resume)) return;
  finishPendingAction(state);
}

function resolveDefensePromptCore(state, useDefense, { expired = false } = {}) {
  const pending = state.pendingAction;
  const prompt = pending?.defensePrompt;
  if (!pending || !prompt) throw new Error('Aucune défense à résoudre.');

  const target = state.playersById[prompt.targetId];
  const canStillUseDefense = !expired && Date.now() <= prompt.expiresAt;
  pending.defensePrompt = null;

  if (useDefense && canStillUseDefense) {
    const defenseIndex = findDefenseIndex(target);
    if (defenseIndex >= 0) {
      const defenseCard = target.actionCards.splice(defenseIndex, 1)[0];
      recordPlayedAction(state, target.id, defenseCard);
      state.actionDiscard.push(defenseCard);
      log(state, `${target.name} bloque l'attaque avec sa défense.`);
      if (pending.type === 'removeEach') {
        pending.remaining = pending.remaining.filter((id) => id !== prompt.targetId);
        finishRemoveEachIfComplete(state, pending);
      } else {
        discardPlayedAction(state, pending.card);
        finishAction(state);
      }
      return;
    }
  }

  if (pending.type === 'removeEach') {
    resolveRemoveEachTarget(state, pending, prompt.targetId, Number.isInteger(prompt.slotIndex)
      ? { slotIndex: prompt.slotIndex }
      : { actionCardId: prompt.actionCardId });
  } else if (pending.type === 'stealAction') {
    completeStealAction(state, pending, prompt.targetId, prompt.cardId);
  } else if (pending.type === 'swapPlayers') {
    completeSwapPlayersAction(state, pending, prompt.first, prompt.second);
  } else {
    discardPlayedAction(state, pending.card);
    finishAction(state);
  }
}

function recordPlayedAction(state, playerId, card) {
  const player = state.playersById[playerId];
  if (!player || !card) return;
  state.actionPlaySerial = (state.actionPlaySerial || 0) + 1;
  state.lastPlayedAction = {
    id: `action-play-${Date.now()}-${state.actionPlaySerial}`,
    t: Date.now(),
    playerId,
    playerName: player.name,
    card: {
      id: card.id,
      type: card.type,
    },
  };
}

function beginActionEffect(state, playerId, card) {
  recordPlayedAction(state, playerId, card);
  if (card.type === 'extraTurns') {
    state.extraTurns[playerId] = (state.extraTurns[playerId] || 0) + 2;
    discardPlayedAction(state, card);
    finishAction(state);
    return;
  }
  if (card.type === 'defense') {
    state.extraTurns[playerId] = (state.extraTurns[playerId] || 0) + 1;
    discardPlayedAction(state, card);
    finishAction(state);
    return;
  }
  if (card.type === 'playDiscard') {
    const playableCards = replayableDiscardCards(state, playerId);
    if (playableCards.length === 1) {
      const selected = playableCards[0];
      discardPlayedAction(state, card);
      state.actionDiscard.splice(
        state.actionDiscard.findIndex((discardedCard) => discardedCard.id === selected.id),
        1,
      );
      executeNestedAction(state, playerId, selected);
      return;
    }
  }
  if (card.type === 'stealAction' && !state.order.some((id) => id !== playerId && state.playersById[id].actionCards.length)) {
    discardPlayedAction(state, card);
    finishAction(state);
    return;
  }
  if (card.type === 'drawThree') {
    const cards = [];
    for (let i = 0; i < 3; i += 1) {
      refillGameDeck(state);
      cards.push(state.deck.pop());
    }
    state.pendingAction = { playerId, card, type: card.type, drawn: cards };
  } else if (card.type === 'removeEach') {
    const remaining = actionTargetsAfterActor(state, playerId);
    if (remaining.length === 0) {
      discardPlayedAction(state, card);
      finishAction(state);
      return;
    }
    state.pendingAction = { playerId, card, type: card.type, remaining };
  } else {
    state.pendingAction = { playerId, card, type: card.type };
  }
  state.turnStage = 'action';
}

function actionUnavailableReason(state, playerId, card, { fromDiscard = false } = {}) {
  if (!card || !ACTION_TYPES.includes(card.type)) return 'Carte Action invalide.';

  if (fromDiscard && card.type === 'playDiscard') {
    return 'Cette carte ne peut pas rejouer une autre Action défaussée.';
  }

  if (card.type === 'drawThree' && availableGameDrawCount(state) < 3) {
    return 'Plus assez de cartes dans la pioche.';
  }

  if (card.type === 'swapOwn') {
    const availableSlots = state.playersById[playerId]?.board
      ?.filter((slot) => !slot.removed).length || 0;
    if (availableSlots < 2) return 'Il faut au moins deux cartes sur votre plateau.';
  }

  if (card.type === 'swapPlayers') {
    const availableSlots = state.order.reduce((count, id) => (
      count + (state.playersById[id]?.board?.filter((slot) => !slot.removed).length || 0)
    ), 0);
    if (availableSlots < 2) return 'Il faut au moins deux cartes disponibles sur les plateaux.';
  }

  if (card.type === 'peekLine') {
    const hasHiddenCard = state.order.some((id) => state.playersById[id]?.board
      ?.some((slot) => !slot.removed && !slot.faceUp));
    if (!hasHiddenCard) return 'Aucune carte cachée ne peut être regardée.';
  }

  if (card.type === 'removeEach') {
    const targets = actionTargetsAfterActor(state, playerId);
    if (targets.length === 0) return 'Aucun autre joueur ne peut être ciblé.';
    const hasBlockedTarget = targets.some((id) => {
      const target = state.playersById[id];
      return !target?.board?.some((slot) => !slot.removed) && !target?.actionCards?.length;
    });
    if (hasBlockedTarget) return 'Un joueur ne possède aucune carte pouvant être retirée.';
  }

  if (card.type === 'stealAction') {
    const hasTarget = state.order.some((id) =>
      id !== playerId
      && state.playersById[id]?.connected
      && state.playersById[id]?.actionCards?.length);
    if (!hasTarget) return 'Aucun autre joueur ne possède de carte Action.';
  }

  if (card.type === 'playDiscard' && replayableDiscardCards(state, playerId).length === 0) {
    return 'Aucune carte Action défaussée ne peut être jouée.';
  }

  return null;
}

function replayableDiscardCards(state, playerId) {
  const seenTypes = new Set();
  const cards = [];
  for (let index = state.actionDiscard.length - 1; index >= 0; index -= 1) {
    const card = state.actionDiscard[index];
    if (seenTypes.has(card.type)
      || actionUnavailableReason(state, playerId, card, { fromDiscard: true })) continue;
    seenTypes.add(card.type);
    cards.push(card);
  }
  return cards;
}

function assertActionCanBegin(state, playerId, card, options) {
  const reason = actionUnavailableReason(state, playerId, card, options);
  if (reason) throw new Error(reason);
}

export function playOwnedAction(state, playerId, cardId) {
  ensureActionFields(state);
  grantTemporaryPlayableActionCardsForAll(state);
  if (state.phase !== 'playing' || currentPlayerId(state) !== playerId || state.turnStage !== 'choose') {
    throw new Error('Action impossible.');
  }
  if (state.roundEnderId) {
    throw new Error('Les cartes Action ne peuvent pas être jouées pendant le dernier tour.');
  }
  const player = state.playersById[playerId];
  const index = player.actionCards.findIndex((card) => card.id === cardId);
  if (index < 0) throw new Error('Carte Action invalide.');
  const card = player.actionCards[index];
  if (!card || card.availableAt > state.turnSerial) throw new Error('Cette carte ne peut être jouée qu’au prochain tour.');
  assertActionCanBegin(state, playerId, card);
  state.starterTieNotice = null;
  player.actionCards.splice(index, 1);
  beginActionEffect(state, playerId, card);
  grantTemporaryPlayableActionCardsForAll(state);
}

export function discardOwnedAction(state, playerId, cardId) {
  ensureActionFields(state);
  grantTemporaryPlayableActionCardsForAll(state);
  if (state.phase !== 'playing' || currentPlayerId(state) !== playerId || state.turnStage !== 'choose') {
    throw new Error('Action impossible.');
  }
  if (state.roundEnderId) {
    throw new Error('Les cartes Action ne peuvent pas être défaussées pendant le dernier tour.');
  }

  const player = state.playersById[playerId];
  const index = player.actionCards.findIndex((card) => card.id === cardId);
  if (index < 0) throw new Error('Carte Action invalide.');
  const card = player.actionCards[index];
  if (!card || card.availableAt > state.turnSerial) throw new Error('Cette carte ne peut être défaussée qu’au prochain tour.');

  player.actionCards.splice(index, 1);
  discardPlayedAction(state, card);
  state.starterTieNotice = null;
  advanceTurn(state);
}

function validateSlot(state, playerId, slotIndex) {
  const player = getOwnPlayer(state, playerId);
  const index = assertBoardSlotIndex(slotIndex);
  const slot = player?.board?.[index];
  if (!slot || slot.removed) throw new Error('Emplacement invalide.');
  return slot;
}

function peekGroupIndexes(firstIndex, groupType) {
  if (groupType === 'row') return ROWS[Math.floor(firstIndex / 4)];
  if (groupType === 'column') return COLUMNS[firstIndex % 4];
  if (groupType === 'single') return [firstIndex];
  throw new Error('Choix de ligne ou colonne invalide.');
}

function peekGroupHasOtherCard(player, firstIndex, groupType) {
  return peekGroupIndexes(firstIndex, groupType)
    .some((index) => index !== firstIndex && !player.board[index]?.removed);
}

function automaticPeekGroupType(player, firstIndex) {
  const informativeGroups = ['row', 'column'].filter((groupType) => (
    peekGroupIndexes(firstIndex, groupType).some((index) => {
      const slot = player.board[index];
      return index !== firstIndex && slot && !slot.removed && !slot.faceUp;
    })
  ));
  if (informativeGroups.length === 0) return 'single';
  if (informativeGroups.length === 1) return informativeGroups[0];
  return null;
}

function executeNestedAction(state, actorId, card) {
  beginActionEffect(state, actorId, card);
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') throw new Error('Sélection invalide.');
  return {
    playerId: target.playerId,
    slotIndex: assertBoardSlotIndex(target.slotIndex),
  };
}

function storeActionDraft(state, pending, playerId, draft) {
  if (!draft || typeof draft !== 'object') throw new Error('Sélection invalide.');
  const actorId = pending.playerId;

  if (pending.type === 'swapOwn') {
    const slotIndex = Array.isArray(draft.slots) ? draft.slots[0] : draft.slotIndex;
    validateSlot(state, actorId, slotIndex);
    pending.selection = { slots: [slotIndex] };
    return;
  }

  if (pending.type === 'drawThree') {
    if (!Object.prototype.hasOwnProperty.call(draft, 'choiceIndex')) throw new Error('Sélection invalide.');
    if (draft.choiceIndex === null) {
      if (boardFinished(state.playersById[actorId])) {
        throw new Error('Vous n’avez plus de carte cachée à retourner.');
      }
      pending.selection = { choiceIndex: null };
      return;
    }
    if (!Number.isInteger(draft.choiceIndex) || !pending.drawn?.[draft.choiceIndex]) {
      throw new Error('Carte choisie invalide.');
    }
    pending.selection = { choiceIndex: draft.choiceIndex };
    return;
  }

  if (pending.type === 'peekLine') {
    if (draft.peekFirst === null) {
      pending.selection = null;
      return;
    }
    const first = normalizeTarget(draft.peekFirst || draft.first || draft.target);
    const firstSlot = validateSlot(state, first.playerId, first.slotIndex);
    if (firstSlot.faceUp) throw new Error('Choisissez une carte cachée comme point de départ.');
    pending.selection = { peekFirst: first };
    return;
  }

  if (pending.type === 'swapPlayers') {
    const first = normalizeTarget(Array.isArray(draft.targets) ? draft.targets[0] : draft.first || draft.target);
    validateSlot(state, first.playerId, first.slotIndex);
    pending.selection = { targets: [first] };
    return;
  }

  if (pending.type === 'stealAction') {
    const hasStealTarget = Object.prototype.hasOwnProperty.call(draft, 'stealTargetId');
    const hasTargetPlayer = Object.prototype.hasOwnProperty.call(draft, 'targetPlayerId');
    if (!hasStealTarget && !hasTargetPlayer) throw new Error('Joueur cible invalide.');

    const targetId = hasStealTarget ? draft.stealTargetId : draft.targetPlayerId;
    if (targetId === null) {
      pending.selection = {};
      return;
    }

    const target = state.playersById[targetId];
    if (!target || target.id === actorId || !target.connected) throw new Error('Joueur cible invalide.');
    if (!target.actionCards?.length) throw new Error('Ce joueur n’a pas de carte Action à voler.');
    pending.selection = { stealTargetId: target.id };
    return;
  }

  throw new Error('Cette action ne possède pas de sélection intermédiaire.');
}

export function resolveActionInput(state, playerId, payload = {}) {
  ensureActionFields(state);
  grantTemporaryPlayableActionCardsForAll(state);
  const pending = state.pendingAction;
  if (!pending) throw new Error('Aucune action à résoudre.');
  if (state.pendingStarClaim) throw new Error('Une carte Étoile doit d’abord être résolue.');
  const actorId = pending.playerId;
  const actor = state.playersById[actorId];

  if (payload.draft) {
    if (playerId !== actorId) throw new Error('Ce choix ne vous appartient pas.');
    storeActionDraft(state, pending, playerId, payload.draft);
    if (pending.type === 'peekLine' && pending.selection?.peekFirst) {
      const first = pending.selection.peekFirst;
      const target = state.playersById[first.playerId];
      const groupType = automaticPeekGroupType(target, first.slotIndex);
      if (groupType) {
        resolveActionInput(state, playerId, {
          targetPlayerId: first.playerId,
          firstSlotIndex: first.slotIndex,
          groupType,
        });
      }
    }
    return;
  }

  if (pending.type === 'removeEach') {
    if (playerId !== actorId) throw new Error('Ce choix ne vous appartient pas.');
    if (pending.defensePrompt) throw new Error('Une défense est en attente.');
    const targetId = payload.targetPlayerId;
    const expectedTargetId = pending.remaining[0];
    if (!targetId || targetId !== expectedTargetId || targetId === actorId || !pending.remaining.includes(targetId)) {
      throw new Error('Joueur cible invalide.');
    }
    const target = state.playersById[targetId];
    const hasSlotTarget = Number.isInteger(payload.slotIndex);
    const hasActionTarget = typeof payload.actionCardId === 'string' && payload.actionCardId.length > 0;
    if (hasSlotTarget === hasActionTarget) throw new Error('Carte à retirer invalide.');
    if (hasSlotTarget) validateSlot(state, targetId, payload.slotIndex);
    if (hasActionTarget && !target?.actionCards?.some((card) => card.id === payload.actionCardId)) {
      throw new Error('Carte Action invalide.');
    }
    if (findDefenseIndex(state.playersById[targetId]) >= 0) {
      beginDefensePrompt(state, pending, targetId, hasSlotTarget
        ? { slotIndex: payload.slotIndex }
        : { actionCardId: payload.actionCardId });
      return;
    }
    resolveRemoveEachTarget(state, pending, targetId, hasSlotTarget
      ? { slotIndex: payload.slotIndex }
      : { actionCardId: payload.actionCardId });
    return;
  }

  if (playerId !== actorId) throw new Error('Ce choix ne vous appartient pas.');

  if (pending.type === 'swapOwn') {
    const slots = payload.slots || (
      Number.isInteger(payload.slotIndex) && pending.selection?.slots?.length === 1
        ? [pending.selection.slots[0], payload.slotIndex]
        : []
    );
    const [a, b] = slots;
    const first = validateSlot(state, actorId, a);
    const second = validateSlot(state, actorId, b);
    if (a === b) throw new Error('Choisissez deux cartes distinctes.');
    recordCardMove(state, {
      type: 'swap',
      moves: [
        {
          fromPlayerId: actorId,
          fromSlotIndex: a,
          toPlayerId: actorId,
          toSlotIndex: b,
          card: first.card,
          faceUp: first.faceUp,
        },
        {
          fromPlayerId: actorId,
          fromSlotIndex: b,
          toPlayerId: actorId,
          toSlotIndex: a,
          card: second.card,
          faceUp: second.faceUp,
        },
      ],
    });
    [first.card, second.card] = [second.card, first.card];
    [first.faceUp, second.faceUp] = [second.faceUp, first.faceUp];
    if (clearCompletedGroups(state, actor, { type: 'pendingActionAfterResolve', claimedStar: false })) return;
  } else if (pending.type === 'drawThree') {
    let claimedStar = false;
    const hasPayloadChoice = Object.prototype.hasOwnProperty.call(payload, 'choiceIndex');
    const hasStoredChoice = Object.prototype.hasOwnProperty.call(pending.selection || {}, 'choiceIndex');
    if (!hasPayloadChoice && !hasStoredChoice) throw new Error('Choisissez d’abord une option.');
    const choiceIndex = hasPayloadChoice ? payload.choiceIndex : pending.selection.choiceIndex;
    if (choiceIndex === null) {
      const slot = validateSlot(state, actorId, payload.revealSlot ?? payload.slotIndex);
      if (slot.faceUp) throw new Error('Choisissez une carte cachée.');
      const revealSlotIndex = payload.revealSlot ?? payload.slotIndex;
      recordCardMove(state, {
        type: 'reveal',
        cards: [{ playerId: actorId, slotIndex: revealSlotIndex, card: slot.card }],
      });
      slot.faceUp = true;
      claimedStar = isStar(slot.card);
      state.discard.push(...pending.drawn);
    } else {
      const chosen = pending.drawn[choiceIndex];
      if (!chosen) throw new Error('Carte choisie invalide.');
      const slot = validateSlot(state, actorId, payload.slotIndex);
      const oldCard = slot.card;
      const oldFaceUp = slot.faceUp;
      if (slot.card) state.discard.push(slot.card);
      slot.card = chosen;
      slot.faceUp = true;
      recordCardMove(state, {
        type: 'replacement',
        reason: 'drawThree',
        playerId: actorId,
        slotIndex: payload.slotIndex,
        source: 'deck',
        newCard: chosen,
        oldCard,
        oldFaceUp,
        revealOldCard: true,
      });
      claimedStar = isStar(chosen);
      pending.drawn.filter((_, index) => index !== choiceIndex).forEach((card) => state.discard.push(card));
    }
    if (clearCompletedGroups(state, actor, { type: 'pendingActionAfterResolve', claimedStar, starPlayerId: actorId })) return;
    if (claimedStar) {
      discardPlayedAction(state, pending.card);
      state.pendingAction = null;
      beginStarClaim(state, actorId, 'advance');
      return;
    }
  } else if (pending.type === 'peekLine') {
    const storedFirst = pending.selection?.peekFirst;
    const targetPlayerId = payload.targetPlayerId || storedFirst?.playerId;
    const target = state.playersById[targetPlayerId];
    if (!target) throw new Error('Joueur invalide.');
    const firstIndex = payload.firstSlotIndex ?? storedFirst?.slotIndex;
    const firstSlot = validateSlot(state, target.id, firstIndex);
    if (firstSlot.faceUp) throw new Error('Choisissez une carte cachée comme point de départ.');
    let groupType = payload.groupType;
    let indexes;
    let isLastHidden = false;
    if (groupType) {
      indexes = peekGroupIndexes(firstIndex, groupType);
      if (groupType === 'single') {
        const hiddenIndexes = target.board
          .map((slot, index) => (!slot.removed && !slot.faceUp ? index : -1))
          .filter((index) => index >= 0);
        isLastHidden = hiddenIndexes.length === 1 && hiddenIndexes[0] === firstIndex;
        if (automaticPeekGroupType(target, firstIndex) !== 'single') {
          throw new Error('Cette carte doit être regardée avec sa ligne ou sa colonne.');
        }
      } else if (!peekGroupHasOtherCard(target, firstIndex, groupType)) {
        throw new Error(`Cette ${groupType === 'row' ? 'ligne' : 'colonne'} ne contient qu’une carte.`);
      }
    } else {
      const secondIndex = payload.secondSlotIndex;
      validateSlot(state, target.id, secondIndex);
      if (firstIndex === secondIndex) throw new Error('Choisissez deux cartes distinctes.');
      const sameRow = Math.floor(firstIndex / 4) === Math.floor(secondIndex / 4);
      const sameColumn = firstIndex % 4 === secondIndex % 4;
      if (!sameRow && !sameColumn) throw new Error('Choisissez deux cartes sur une même ligne ou colonne.');
      groupType = sameRow ? 'row' : 'column';
      indexes = peekGroupIndexes(firstIndex, groupType);
    }
    state.peekSerial = (state.peekSerial || 0) + 1;
    actor.peek = {
      id: `peek-${Date.now()}-${state.peekSerial}`,
      targetPlayerId: target.id,
      targetPlayerName: target.name,
      groupType,
      isLastHidden,
      indexes,
      cards: indexes.map((index) => {
        const slot = target.board[index];
        return {
          slotIndex: index,
          removed: !!slot?.removed,
          wasFaceUp: !!slot?.faceUp,
          value: slot?.card?.value ?? null,
          kind: slot?.card?.kind || 'number',
        };
      }),
      expiresAt: Date.now() + PEEK_PREVIEW_MS,
    };
  } else if (pending.type === 'playDiscard') {
    const index = state.actionDiscard.findIndex((card) => card.id === payload.cardId);
    if (index < 0) throw new Error('Carte Action défaussée invalide.');
    const selected = state.actionDiscard[index];
    assertActionCanBegin(state, actorId, selected, { fromDiscard: true });
    discardPlayedAction(state, pending.card);
    state.actionDiscard.splice(index, 1);
    executeNestedAction(state, actorId, selected);
    return;
  } else if (pending.type === 'stealAction') {
    const targetId = payload.targetPlayerId || pending.selection?.stealTargetId;
    const target = state.playersById[targetId];
    if (!target || target.id === actorId || !target.connected) throw new Error('Joueur invalide.');
    const cardId = payload.cardId || (target.actionCards.length === 1 ? target.actionCards[0].id : null);
    if (!target.actionCards.some((card) => card.id === cardId)) throw new Error('Carte Action invalide.');
    if (findDefenseIndex(target) >= 0) {
      beginDefensePrompt(state, pending, target.id, { cardId });
      return;
    }
    completeStealAction(state, pending, target.id, cardId);
    return;
  } else if (pending.type === 'swapPlayers') {
    const first = payload.first || pending.selection?.targets?.[0];
    const second = payload.second;
    completeSwapPlayersAction(state, pending, first, second);
    return;
  } else {
    throw new Error('Action inconnue.');
  }

  discardPlayedAction(state, pending.card);
  finishAction(state);
}

function boardScore(player) {
  const visibleStarGroupBonus = [
    [COLUMNS, -10],
    [ROWS, -15],
  ].reduce((bonus, [groups, groupBonus]) => {
    for (const indexes of groups) {
      const slots = indexes.map((index) => player.board[index]);
      if (slots.every((slot) => !slot.removed && isStar(slot.card))) {
        bonus += groupBonus;
      }
    }
    return bonus;
  }, 0);

  return player.board.reduce((sum, slot) => sum + (slot.removed ? 0 : slot.card?.value || 0), 0)
    + player.actionCards.length * 10
    + (player.starBonus || 0)
    + visibleStarGroupBonus;
}

function completeActionRoundEnd(state) {
  for (const id of state.order) {
    const player = state.playersById[id];
    if (player && clearCompletedGroups(state, player, { type: 'completeActionRoundEnd', playerIds: state.order })) return;
  }
  const scores = Object.fromEntries(state.order.map((id) => [id, boardScore(state.playersById[id])]));
  const minScore = Math.min(...Object.values(scores));
  const enderId = state.roundEnderId;
  for (const id of state.order) {
    let score = scores[id];
    if (id === enderId && score > minScore && score > 0) {
      score *= 2;
    }
    const player = state.playersById[id];
    player.lastRoundScore = score;
    player.totalScore += score;
  }
  state.completedRounds = (state.completedRounds || 0) + 1;
  state.phase = 'roundEnd';
  state.turnStage = null;
  state.roundScoresAt = Date.now() + ROUND_SCORE_PREVIEW_MS;
  state.nextRoundAt = state.roundScoresAt + ROUND_BREAK_MS;
  const reached100 = state.order.some((id) => state.playersById[id].totalScore >= 100);
  if (reached100) {
    state.winnerId = state.order.reduce((best, id) =>
      state.playersById[id].totalScore < state.playersById[best].totalScore ? id : best, state.order[0]);
    state.phase = 'gameEnd';
    state.nextRoundAt = null;
  }
}

function endActionRound(state, revealedBeforeRoundEnd = []) {
  const revealed = [...revealedBeforeRoundEnd];
  for (const id of state.order) {
    revealed.push(...revealRemainingCards(state.playersById[id]));
  }
  if (revealed.length > 0) recordCardMove(state, { type: 'reveal', cards: revealed });
  continueActionRoundEnd(state, [...state.order]);
}

export function nextActionRound(state) {
  if (state.phase !== 'roundEnd') throw new Error('Pas de manche à démarrer.');
  dealRound(state);
}

export function resolveDefensePrompt(state, playerId, useDefense) {
  ensureActionFields(state);
  const prompt = state.pendingAction?.defensePrompt;
  if (!prompt) throw new Error('Aucune défense à résoudre.');
  if (prompt.targetId !== playerId) throw new Error('Cette défense ne vous appartient pas.');
  if (typeof useDefense !== 'boolean') throw new Error('Choix invalide.');
  resolveDefensePromptCore(state, !!useDefense);
  grantTemporaryPlayableActionCardsForAll(state);
}

export function expireDefensePrompt(state) {
  ensureActionFields(state);
  if (!state.pendingAction?.defensePrompt) return false;
  if (state.pendingAction.defensePrompt.expiresAt > Date.now()) return false;
  resolveDefensePromptCore(state, false, { expired: true });
  grantTemporaryPlayableActionCardsForAll(state);
  return true;
}

export function resolveGroupChoice(state, playerId, remove) {
  ensureActionFields(state);
  const choice = state.pendingGroupChoice;
  if (!choice) throw new Error('Aucun groupe à résoudre.');
  if (choice.playerId !== playerId) throw new Error('Ce choix ne vous appartient pas.');
  if (typeof remove !== 'boolean') throw new Error('Choix invalide.');

  const player = state.playersById[playerId];
  const slots = choice.indexes.map((index) => player?.board[index]);
  const stillValid = !!player
    && slots.every((slot) => slot && !slot.removed && slot.faceUp && slot.card)
    && groupSignature(slots) === choice.signature;
  const resume = choice.resume || { type: 'none' };
  state.pendingGroupChoice = null;

  if (stillValid && remove) {
    removeCompletedGroup(state, player, choice.indexes, choice.starBonus);
  } else if (stillValid) {
    player.groupChoiceSkips ||= {};
    player.groupChoiceSkips[choice.key] = choice.signature;
    log(state, `${player.name} conserve sa ${choice.groupType === 'row' ? 'ligne' : 'colonne'} avec étoile.`);
  }

  if (player && clearCompletedGroups(state, player, resume)) return;
  continueAfterGroupChoice(state, resume);
}

export function handleActionPlayerLeave(state, playerId) {
  ensureActionFields(state);

  const leavingPlayer = state.playersById[playerId];
  if (leavingPlayer?.actionCards?.length) {
    state.actionDiscard.push(...leavingPlayer.actionCards.filter((card) => !card.temporary));
    leavingPlayer.actionCards = [];
  }

  if (state.pendingStarClaim?.playerId === playerId) {
    state.pendingStarClaim = null;
    if (state.turnStage === 'starClaim') {
      state.turnStage = state.phase === 'playing' ? 'choose' : null;
    }
  }

  if (state.pendingGroupChoice?.playerId === playerId) {
    const resume = state.pendingGroupChoice.resume || { type: 'none' };
    state.pendingGroupChoice = null;
    continueAfterGroupChoice(state, resume);
  }

  const pending = state.pendingAction;
  if (!pending) return;

  if (pending.defensePrompt
    && (pending.defensePrompt.actorId === playerId || pending.defensePrompt.targetId === playerId)) {
    pending.defensePrompt = null;
  }

  if (pending.playerId === playerId) {
    if (pending.card) discardPlayedAction(state, pending.card);
    state.pendingAction = null;
    if (state.phase === 'playing') state.turnStage = 'choose';
    return;
  }

  if (Array.isArray(pending.remaining)) {
    pending.remaining = pending.remaining.filter((id) => id !== playerId);
    if (pending.type === 'removeEach' && pending.remaining.length === 0) {
      discardPlayedAction(state, pending.card);
      finishAction(state);
      return;
    }
  }

  if (pending.selection?.peekFirst?.playerId === playerId) {
    pending.selection = null;
  }

  if (pending.selection?.targets?.some((target) => target.playerId === playerId)) {
    pending.selection = null;
  }

  if (pending.selection?.stealTargetId === playerId) {
    pending.selection = null;
  }
}

export function publicActionState(state, forPlayerId) {
  ensureActionFields(state);
  const currentId = state.phase === 'playing' ? currentPlayerId(state) : null;
  const pending = state.pendingAction;
  const ownPeek = state.playersById[forPlayerId]?.peek;
  const visibleOwnPeek = ownPeek?.expiresAt > Date.now() ? ownPeek : null;
  const actionPausedForStarClaim = !!state.pendingStarClaim;
  const actionPausedForGroupChoice = !!state.pendingGroupChoice;
  const defensePrompt = pending?.defensePrompt || null;
  const actionPausedForDefense = !!defensePrompt;
  const canSeeDefensePrompt = defensePrompt
    && (defensePrompt.actorId === forPlayerId || defensePrompt.targetId === forPlayerId);
  const playableDiscardCardIds = pending?.type === 'playDiscard' && pending.playerId === forPlayerId
    ? replayableDiscardCards(state, pending.playerId).map((card) => card.id)
    : undefined;
  return {
    actionMarket: state.actionMarket,
    actionDiscard: state.actionDiscard,
    canDrawActionDeck: availableActionDeckCount(state) > 0,
    lastPlayedAction: state.lastPlayedAction && Date.now() - state.lastPlayedAction.t <= ACTION_PLAY_POPUP_MS
      ? state.lastPlayedAction
      : null,
    pendingStarClaim: state.pendingStarClaim?.playerId === forPlayerId,
    pendingGroupChoice: state.pendingGroupChoice?.playerId === forPlayerId
      ? {
        id: state.pendingGroupChoice.id,
        playerId: state.pendingGroupChoice.playerId,
        playerName: state.pendingGroupChoice.playerName,
        groupType: state.pendingGroupChoice.groupType,
        indexes: state.pendingGroupChoice.indexes,
        cards: state.pendingGroupChoice.cards,
        allStars: state.pendingGroupChoice.allStars,
        starBonus: state.pendingGroupChoice.starBonus,
      }
      : null,
    pendingAction: pending ? {
      type: pending.type,
      actorId: pending.playerId,
      mustRespond: pending.type === 'removeEach'
        ? !actionPausedForStarClaim && !actionPausedForGroupChoice && !actionPausedForDefense && pending.playerId === forPlayerId
        : !actionPausedForStarClaim && !actionPausedForGroupChoice && !actionPausedForDefense && pending.playerId === forPlayerId,
      remaining: pending.playerId === forPlayerId ? pending.remaining : undefined,
      currentTargetId: pending.playerId === forPlayerId && pending.type === 'removeEach'
        ? pending.remaining?.[0]
        : undefined,
      drawn: pending.playerId === forPlayerId ? pending.drawn : undefined,
      selection: pending.playerId === forPlayerId ? pending.selection : undefined,
      playableDiscardCardIds,
      defensePrompt: canSeeDefensePrompt ? {
        id: defensePrompt.id,
        type: defensePrompt.type,
        actorId: defensePrompt.actorId,
        targetId: defensePrompt.targetId,
        targetName: defensePrompt.targetName,
        expiresAt: defensePrompt.expiresAt,
        canRespond: defensePrompt.targetId === forPlayerId,
      } : undefined,
    } : null,
    turnSerial: state.turnSerial,
    playersAction: Object.fromEntries(state.order.map((id) => {
      const player = state.playersById[id];
      return [id, {
        actionCards: player.actionCards.map((card) => {
          if (id !== forPlayerId) return card;
          const unavailableReason = actionUnavailableReason(state, id, card);
          return unavailableReason ? { ...card, unavailableReason } : card;
        }),
        peek: id === forPlayerId ? visibleOwnPeek : null,
      }];
    })),
    currentPlayerId: currentId,
  };
}

export function assertActionCardIntegrity(state) {
  if (state.gameMode !== 'action' || state.roundNumber < 1) return;

  const cards = [
    ...(state.actionDeck || []),
    ...(state.actionMarket || []),
    ...(state.actionDiscard || []),
    ...Object.values(state.playersById || {}).flatMap((player) => player.actionCards || []),
    ...(state.pendingAction?.card ? [state.pendingAction.card] : []),
  ].filter((card) => !card.temporary);

  const ids = cards.map((card) => card?.id);
  const uniqueIds = new Set(ids);
  const validIds = ids.every((id) => /^action-(?:[0-9]|1[0-9]|2[0-6])$/.test(id || ''));
  if (cards.length !== ACTION_DECK_SIZE || uniqueIds.size !== cards.length || !validIds) {
    throw new Error('État des cartes Action incohérent.');
  }
}
