import { buildDeck, shuffle } from './deck.js';
import {
  claimStarAction,
  decideActionGameCard,
  discardOwnedAction,
  drawActionGameCard,
  expireDefensePrompt,
  flipInitialActionCard,
  handleActionPlayerLeave,
  nextActionRound,
  placeActionGameCard,
  playOwnedAction,
  publicActionState,
  resolveDefensePrompt,
  resolveActionInput,
  resolveGroupChoice,
  revealActionGameCard,
  startActionGame,
} from './actionGame.js';

const COLUMNS = [
  [0, 4, 8],
  [1, 5, 9],
  [2, 6, 10],
  [3, 7, 11],
];
const ROUND_BREAK_MS = 10_000;
const ROUND_SCORE_PREVIEW_MS = 3_000;
const MAX_CHAT_MESSAGES = 80;
const BOARD_SLOT_COUNT = 12;
export const MAX_PLAYERS_PER_ROOM = 8;

function assertBoardSlotIndex(slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= BOARD_SLOT_COUNT) {
    throw new Error('Emplacement invalide.');
  }
  return slotIndex;
}

function getBoardSlot(player, slotIndex) {
  const index = assertBoardSlotIndex(slotIndex);
  const slot = player?.board?.[index];
  if (!slot) throw new Error('Emplacement invalide.');
  return slot;
}

export function createPlayer(id, name) {
  return {
    id,
    name,
    connected: true,
    board: Array.from({ length: 12 }, () => ({ card: null, faceUp: false, removed: false })),
    totalScore: 0,
    lastRoundScore: null,
    flippedCount: 0,
  };
}

export function newRoomState(roomId) {
  return {
    roomId,
    phase: 'lobby',
    order: [],
    playersById: {},
    creatorId: null,
    gameMode: 'classic',
    deck: [],
    discard: [],
    turnIndex: 0,
    turnStage: null,
    drawnCard: null,
    roundEnderId: null,
    roundNumber: 0,
    completedRounds: 0,
    nextRoundAt: null,
    roundScoresAt: null,
    starterTieNotice: null,
    log: [],
    chatMessages: [],
    chatSerial: 0,
    winnerId: null,
  };
}

function log(state, msg) {
  state.log.push({ t: Date.now(), msg });
  if (state.log.length > 100) state.log.shift();
}

export function addChatMessage(state, playerId, text) {
  const player = state.playersById[playerId];
  if (!player) throw new Error('Joueur introuvable.');

  const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  if (!cleanText) throw new Error('Message vide.');

  state.chatMessages ||= [];
  state.chatSerial = (state.chatSerial || 0) + 1;
  state.chatMessages.push({
    id: `${Date.now()}-${state.chatSerial}`,
    t: Date.now(),
    playerId,
    playerName: player.name,
    text: cleanText,
  });
  if (state.chatMessages.length > MAX_CHAT_MESSAGES) {
    state.chatMessages.splice(0, state.chatMessages.length - MAX_CHAT_MESSAGES);
  }
}

export function addPlayer(state, id, name) {
  if (state.playersById[id]) return;
  if (state.order.length >= MAX_PLAYERS_PER_ROOM) {
    throw new Error(`La salle est complète (${MAX_PLAYERS_PER_ROOM} joueurs max).`);
  }
  state.playersById[id] = createPlayer(id, name);
  state.order.push(id);
  if (!state.creatorId || !state.playersById[state.creatorId]) {
    state.creatorId = id;
  }
}

export function removePlayer(state, id) {
  if (state.playersById[id]) {
    state.playersById[id].connected = false;
  }
}

function startRoundIfReady(state) {
  const connectedIds = state.order.filter(id => state.playersById[id].connected);
  if (connectedIds.length < 2) return false;
  if (!connectedIds.every(id => state.playersById[id].flippedCount >= 2)) return false;

  const sums = connectedIds.map((id) => {
    const player = state.playersById[id];
    const sum = player.board
      .filter(slot => slot.faceUp && !slot.removed)
      .reduce((total, slot) => total + slot.card.value, 0);
    return { id, sum };
  });
  const bestSum = Math.max(...sums.map(({ sum }) => sum));
  const tiedIds = sums.filter(({ sum }) => sum === bestSum).map(({ id }) => id);
  const bestId = tiedIds[0];

  state.turnIndex = state.order.indexOf(bestId);
  state.phase = 'playing';
  state.turnStage = 'draw';
  if (tiedIds.length > 1) {
    const tiedNames = tiedIds.map((id) => state.playersById[id].name).join(', ');
    const message = `Égalité pour commencer la manche entre ${tiedNames} (${bestSum}). ${state.playersById[bestId].name} commence.`;
    state.starterTieNotice = {
      id: `starter-tie-${state.roundNumber}-${Date.now()}`,
      message,
    };
    log(state, message);
  } else {
    state.starterTieNotice = null;
    log(state, `${state.playersById[bestId].name} commence la manche.`);
  }
  return true;
}

export function leavePlayer(state, id) {
  const player = state.playersById[id];
  const leavingIndex = state.order.indexOf(id);
  if (!player || leavingIndex < 0) return;

  const wasCurrentPlayer = state.order[state.turnIndex] === id;
  if (wasCurrentPlayer && state.drawnCard?.card) {
    state.discard.push(state.drawnCard.card);
    state.drawnCard = null;
  }

  if (state.gameMode === 'action') {
    handleActionPlayerLeave(state, id);
  }

  state.order.splice(leavingIndex, 1);
  delete state.playersById[id];
  log(state, `${player.name} a quitté la salle.`);

  if (state.creatorId === id) {
    state.creatorId = state.order[0] || null;
    if (state.creatorId) {
      log(state, `${state.playersById[state.creatorId].name} devient le créateur de la salle.`);
    }
  }

  if (state.roundEnderId === id) state.roundEnderId = null;
  if (state.winnerId === id) state.winnerId = null;

  if (state.order.length === 0) {
    state.phase = 'lobby';
    state.turnIndex = 0;
    state.turnStage = null;
    state.drawnCard = null;
    return;
  }

  if (leavingIndex < state.turnIndex) {
    state.turnIndex -= 1;
  } else if (wasCurrentPlayer) {
    state.turnIndex %= state.order.length;
    state.drawnCard = null;
    if (state.phase === 'playing') {
      state.turnStage = state.gameMode === 'action' ? 'choose' : 'draw';
    }
  }

  if (state.phase === 'lobby') return;

  if (state.order.length === 1) {
    state.phase = 'gameEnd';
    state.winnerId = state.order[0];
    state.turnIndex = 0;
    state.turnStage = null;
    state.drawnCard = null;
    log(state, `${state.playersById[state.winnerId].name} gagne par abandon.`);
    return;
  }

  if (state.phase === 'initialFlip') {
    startRoundIfReady(state);
  }
}

function ensureCreator(state) {
  if (!state.creatorId || !state.playersById[state.creatorId]) {
    state.creatorId = state.order.find(id => state.playersById[id]) || null;
  }
  return state.creatorId;
}

function assertCreator(state, playerId) {
  if (ensureCreator(state) !== playerId) {
    throw new Error('Seul le créateur de la salle peut effectuer cette action.');
  }
}

export function setGameMode(state, playerId, gameMode) {
  assertCreator(state, playerId);
  if (state.phase !== 'lobby') throw new Error('Le mode ne peut être modifié que dans la file d’attente.');
  if (!['classic', 'action'].includes(gameMode)) throw new Error('Mode de jeu invalide.');
  state.gameMode = gameMode;
  log(state, `Mode sélectionné : ${gameMode === 'action' ? 'Skyjo Action' : 'Skyjo Classique'}.`);
}

function dealNewRound(state) {
  state.deck = shuffle(buildDeck());
  state.discard = [];
  state.roundEnderId = null;
  state.roundNumber += 1;
  for (const pid of state.order) {
    const p = state.playersById[pid];
    p.board = Array.from({ length: 12 }, () => ({ card: state.deck.pop(), faceUp: false, removed: false }));
    p.flippedCount = 0;
    p.lastRoundScore = null;
  }
  state.discard.push(state.deck.pop());
  state.phase = 'initialFlip';
  state.turnStage = null;
  state.drawnCard = null;
  state.nextRoundAt = null;
  state.roundScoresAt = null;
  state.starterTieNotice = null;
  log(state, `Manche ${state.roundNumber} : retournez 2 cartes.`);
}

export function startGame(state, playerId) {
  assertCreator(state, playerId);
  if (state.phase !== 'lobby' && state.phase !== 'gameEnd') {
    throw new Error('Une partie est déjà en cours.');
  }
  if (state.order.length > MAX_PLAYERS_PER_ROOM) {
    throw new Error(`Une partie est limitée à ${MAX_PLAYERS_PER_ROOM} joueurs.`);
  }
  if (state.order.filter(id => state.playersById[id].connected).length < 2) {
    throw new Error('Il faut au moins 2 joueurs.');
  }
  for (const pid of state.order) state.playersById[pid].totalScore = 0;
  state.completedRounds = 0;
  state.winnerId = null;
  if (state.gameMode === 'action') {
    startActionGame(state);
    return;
  }
  dealNewRound(state);
}

export function flipInitialCard(state, playerId, slotIndex) {
  if (state.gameMode === 'action') return flipInitialActionCard(state, playerId, slotIndex);
  if (state.phase !== 'initialFlip') throw new Error('Pas la phase de retournement initial.');
  const p = state.playersById[playerId];
  if (!p) throw new Error('Joueur inconnu.');
  const slot = getBoardSlot(p, slotIndex);
  if (!slot || slot.faceUp || slot.removed) throw new Error('Carte invalide.');
  if (p.flippedCount >= 2) throw new Error('Déjà 2 cartes retournées.');
  slot.faceUp = true;
  p.flippedCount += 1;

  startRoundIfReady(state);
}

function currentPlayerId(state) {
  return state.order[state.turnIndex];
}

function checkAndClearColumns(state, player) {
  for (const col of COLUMNS) {
    const slots = col.map(i => player.board[i]);
    if (slots.every(s => s.faceUp && !s.removed)) {
      const values = slots.map(s => s.card.value);
      if (values[0] === values[1] && values[1] === values[2]) {
        for (const s of slots) {
          state.discard.push(s.card);
          s.removed = true;
          s.card = null;
        }
        log(state, `${player.name} a complété une colonne identique !`);
      }
    }
  }
}

function boardFinished(player) {
  return player.board.every(s => s.removed || s.faceUp);
}

function refillDeckIfNeeded(state) {
  if (state.deck.length > 0) return;

  const discardTop = state.discard[state.discard.length - 1];
  const cardsBelowTop = state.discard.slice(0, -1);
  if (!discardTop || cardsBelowTop.length === 0) {
    throw new Error('Plus assez de cartes pour reconstituer la pioche.');
  }

  state.deck = shuffle(cardsBelowTop);
  state.discard = [discardTop];
  log(state, 'La pioche est vide : les cartes sous la défausse sont mélangées.');
}

function advanceTurn(state) {
  const finishingId = currentPlayerId(state);
  const finishingPlayer = state.playersById[finishingId];

  if (!state.roundEnderId && boardFinished(finishingPlayer)) {
    state.roundEnderId = finishingId;
    log(state, `${finishingPlayer.name} a terminé son tableau ! Dernier tour pour les autres.`);
  }

  const next = (state.turnIndex + 1) % state.order.length;

  if (state.roundEnderId && state.order[next] === state.roundEnderId) {
    endRound(state);
    return;
  }

  state.turnIndex = next;
  state.turnStage = 'draw';
  state.drawnCard = null;
}

export function drawCard(state, playerId, source) {
  if (state.gameMode === 'action') return drawActionGameCard(state, playerId, source);
  if (state.phase !== 'playing') throw new Error('Pas en phase de jeu.');
  if (currentPlayerId(state) !== playerId) throw new Error("Ce n'est pas votre tour.");
  if (state.turnStage !== 'draw') throw new Error('Action impossible.');
  if (!['deck', 'discard'].includes(source)) throw new Error('Source de pioche invalide.');

  if (source === 'discard') {
    if (state.discard.length === 0) throw new Error('Défausse vide.');
    state.drawnCard = { card: state.discard.pop(), from: 'discard' };
    state.turnStage = 'place';
  } else {
    refillDeckIfNeeded(state);
    state.drawnCard = { card: state.deck.pop(), from: 'deck' };
    state.turnStage = 'decide';
  }
  state.starterTieNotice = null;
}

export function decideDrawnCard(state, playerId, keep) {
  if (state.gameMode === 'action') return decideActionGameCard(state, playerId, keep);
  if (currentPlayerId(state) !== playerId) throw new Error("Ce n'est pas votre tour.");
  if (state.turnStage !== 'decide') throw new Error('Action impossible.');
  if (typeof keep !== 'boolean') throw new Error('Choix invalide.');
  if (keep) {
    state.turnStage = 'place';
  } else {
    state.discard.push(state.drawnCard.card);
    state.drawnCard = null;
    state.turnStage = 'reveal';
  }
}

export function keepDrawnAndPlace(state, playerId, slotIndex) {
  if (state.gameMode === 'action') return placeActionGameCard(state, playerId, slotIndex);
  if (currentPlayerId(state) !== playerId) throw new Error("Ce n'est pas votre tour.");
  if (state.turnStage !== 'decide') throw new Error('Action impossible.');
  state.turnStage = 'place';
  placeDrawnCard(state, playerId, slotIndex);
}

export function placeDrawnCard(state, playerId, slotIndex) {
  if (state.gameMode === 'action') return placeActionGameCard(state, playerId, slotIndex);
  if (currentPlayerId(state) !== playerId) throw new Error("Ce n'est pas votre tour.");
  if (state.turnStage !== 'place') throw new Error('Action impossible.');
  const p = state.playersById[playerId];
  const slot = getBoardSlot(p, slotIndex);
  if (!slot || slot.removed) throw new Error('Emplacement invalide.');

  const oldCard = slot.card;
  slot.card = state.drawnCard.card;
  slot.faceUp = true;
  state.drawnCard = null;

  if (oldCard) state.discard.push(oldCard);
  checkAndClearColumns(state, p);
  advanceTurn(state);
}

export function revealHiddenCard(state, playerId, slotIndex) {
  if (state.gameMode === 'action') return revealActionGameCard(state, playerId, slotIndex);
  if (currentPlayerId(state) !== playerId) throw new Error("Ce n'est pas votre tour.");
  if (state.turnStage !== 'reveal') throw new Error('Action impossible.');
  const p = state.playersById[playerId];
  const slot = getBoardSlot(p, slotIndex);
  if (!slot || slot.faceUp || slot.removed) throw new Error('Carte invalide.');
  slot.faceUp = true;
  checkAndClearColumns(state, p);
  advanceTurn(state);
}

function boardScore(player) {
  return player.board.reduce((sum, s) => {
    if (s.removed) return sum;
    return sum + (s.card ? s.card.value : 0);
  }, 0);
}

function endRound(state) {
  for (const id of state.order) {
    const p = state.playersById[id];
    for (const s of p.board) {
      if (!s.removed) s.faceUp = true;
    }
  }
  for (const id of state.order) {
    checkAndClearColumns(state, state.playersById[id]);
  }
  const scores = {};
  for (const id of state.order) {
    scores[id] = boardScore(state.playersById[id]);
  }
  const minScore = Math.min(...Object.values(scores));
  const enderId = state.roundEnderId;
  for (const id of state.order) {
    let s = scores[id];
    if (id === enderId && s > minScore && s > 0) {
      s = s * 2;
    }
    state.playersById[id].lastRoundScore = s;
    state.playersById[id].totalScore += s;
  }
  state.completedRounds = (state.completedRounds || 0) + 1;
  state.phase = 'roundEnd';
  state.roundScoresAt = Date.now() + ROUND_SCORE_PREVIEW_MS;
  state.nextRoundAt = state.roundScoresAt + ROUND_BREAK_MS;
  log(state, `Fin de la manche ${state.roundNumber}.`);

  const reached100 = state.order.filter(id => state.playersById[id].totalScore >= 100);
  if (reached100.length > 0) {
    let winnerId = state.order[0];
    for (const id of state.order) {
      if (state.playersById[id].totalScore < state.playersById[winnerId].totalScore) winnerId = id;
    }
    state.phase = 'gameEnd';
    state.winnerId = winnerId;
    state.nextRoundAt = null;
    log(state, `Partie terminée ! ${state.playersById[winnerId].name} gagne.`);
  }
}

export function nextRound(state) {
  if (state.gameMode === 'action') return nextActionRound(state);
  if (state.phase !== 'roundEnd') throw new Error('Pas de manche à démarrer.');
  dealNewRound(state);
}

export function publicState(state, forPlayerId) {
  const creatorId = ensureCreator(state);
  const completedRounds = state.completedRounds ?? (
    state.phase === 'roundEnd' || state.phase === 'gameEnd' || state.order.some(id => state.playersById[id]?.lastRoundScore !== null)
      ? 1
      : 0
  );

  return {
    roomId: state.roomId,
    gameMode: state.gameMode || 'classic',
    creatorId,
    phase: state.phase,
    order: state.order,
    turnIndex: state.turnIndex,
    turnStage: state.turnStage,
    currentPlayerId: state.phase === 'playing' ? state.order[state.turnIndex] || null : null,
    roundEnderId: state.roundEnderId,
    roundNumber: state.roundNumber,
    completedRounds,
    nextRoundAt: state.nextRoundAt || null,
    roundScoresAt: state.roundScoresAt || null,
    starterTieNotice: state.starterTieNotice || null,
    discardTop: state.discard[state.discard.length - 1] || null,
    deckCount: state.deck.length,
    drawnCard: state.drawnCard
      ? {
        from: state.drawnCard.from,
        card: state.drawnCard.card,
      }
      : null,
    winnerId: state.winnerId,
    log: state.log.slice(-20),
    chatMessages: (state.chatMessages || []).slice(-MAX_CHAT_MESSAGES),
    players: state.order.map(id => {
      const p = state.playersById[id];
      return {
        id: p.id,
        name: p.name,
        connected: p.connected,
        totalScore: p.totalScore,
        hasTotalScore: completedRounds > 0,
        lastRoundScore: p.lastRoundScore,
        flippedCount: p.flippedCount,
        board: p.board.map(s => ({
          cardId: s.faceUp || s.removed ? (s.card?.id || null) : null,
          faceUp: s.faceUp,
          removed: s.removed,
          value: s.faceUp || s.removed ? (s.card ? s.card.value : null) : null,
          kind: s.faceUp || s.removed ? (s.card?.kind || 'number') : null,
        })),
      };
    }),
    ...(state.gameMode === 'action' ? publicActionState(state, forPlayerId) : {}),
  };
}

export {
  claimStarAction,
  discardOwnedAction,
  expireDefensePrompt,
  playOwnedAction,
  resolveDefensePrompt,
  resolveActionInput,
  resolveGroupChoice,
};
