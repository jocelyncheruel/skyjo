import {
  claimStarAction,
  decideDrawnCard,
  drawCard,
  flipInitialCard,
  placeDrawnCard,
  playOwnedAction,
  resolveDefensePrompt,
  resolveActionInput,
  resolveGroupChoice,
  revealHiddenCard,
} from './game.js';
import {
  effectiveRoomVariantSettings,
  GAME_END_MODES,
} from '../shared/roomVariants.js';

const COLUMNS = [
  [0, 4, 8],
  [1, 5, 9],
  [2, 6, 10],
  [3, 7, 11],
];
const ROWS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
];
const UNKNOWN_CARD_EXPECTED_VALUE = 5;
const KEEP_CARD_MINIMUM_GAIN = 0.8;
const EXPERT_DISCARD_GAIN = Object.freeze([
  { maxValue: 1, gain: 0 },
  { maxValue: 2, gain: 1 },
  { maxValue: 3, gain: 2 },
  { maxValue: 5, gain: 3.5 },
  { maxValue: 7, gain: 4 },
  { maxValue: 9, gain: 7 },
  { maxValue: 12, gain: 9 },
]);
const CLASSIC_CARD_COUNTS = Object.freeze({ '-2': 5, '-1': 10, 0: 15 });
const ACTION_CARD_COUNTS = Object.freeze({ '-2': 3, '-1': 7, 0: 11, star: 15 });

function botPlayers(state) {
  return state.order.map((id) => state.playersById[id]).filter((player) => player?.isBot);
}

function hiddenSlots(player) {
  return player.board.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => !slot.removed && !slot.faceUp);
}

function replaceableSlots(player) {
  return player.board.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => !slot.removed);
}

function slotValue(slot) {
  return Number.isFinite(slot?.card?.value) ? slot.card.value : 0;
}

function isStarCard(card) {
  return card?.kind === 'star';
}

function columnForSlot(slotIndex) {
  return COLUMNS.find((column) => column.includes(slotIndex));
}

function estimatedBoardScore(player) {
  const boardScore = player.board.reduce((total, slot) => {
    if (slot.removed) return total;
    return total + (slot.faceUp ? slotValue(slot) : UNKNOWN_CARD_EXPECTED_VALUE);
  }, 0);
  return boardScore + (player.actionCards?.length || 0) * 10 + (player.starBonus || 0);
}

function visibleBoardScore(player) {
  return player.board.reduce((total, slot) => {
    if (slot.removed || !slot.faceUp) return total;
    return total + slotValue(slot);
  }, 0) + (player.actionCards?.length || 0) * 10 + (player.starBonus || 0);
}

function plausibleFinalTurnScore(player) {
  const hiddenCount = hiddenSlots(player).length;
  if (hiddenCount === 0) return estimatedBoardScore(player);
  const visibleScore = visibleBoardScore(player);
  const plausibleIncomingValue = 1;
  const hiddenRevealScore = Math.max(0, hiddenCount - 1) * 2;
  let bestScore = visibleScore + plausibleIncomingValue + hiddenRevealScore;

  for (const { slot, index } of visibleSlots(player)) {
    const column = columnForSlot(index) || [];
    const otherSlots = column
      .filter((slotIndex) => slotIndex !== index)
      .map((slotIndex) => player.board[slotIndex])
      .filter((candidate) => candidate && !candidate.removed);
    let candidateScore = visibleScore - slotValue(slot) + plausibleIncomingValue + hiddenCount * 2;
    const completesLowColumn = otherSlots.length === 2
      && otherSlots.every((candidate) => candidate.faceUp
        && (isStarCard(candidate.card) || slotValue(candidate) === plausibleIncomingValue));
    if (completesLowColumn) {
      candidateScore -= plausibleIncomingValue
        + otherSlots.reduce((sum, candidate) => sum + slotValue(candidate), 0);
    }
    bestScore = Math.min(bestScore, candidateScore);
  }
  return bestScore;
}

function cardMemoryKey(card) {
  if (isStarCard(card)) return 'star';
  return Number.isFinite(card?.value) ? String(card.value) : null;
}

function initialCardCount(gameMode, key) {
  if (!key) return 0;
  const specialCounts = gameMode === 'action' ? ACTION_CARD_COUNTS : CLASSIC_CARD_COUNTS;
  if (Object.prototype.hasOwnProperty.call(specialCounts, key)) return specialCounts[key];
  const value = Number(key);
  if (!Number.isInteger(value) || value < 1 || value > 12) return 0;
  return gameMode === 'action' ? 7 : 10;
}

function rememberedCardCounts(state) {
  const seenIds = new Set();
  const counts = new Map();
  const remember = (card) => {
    const key = cardMemoryKey(card);
    if (!key || !card?.id || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const card of state.discard || []) remember(card);
  remember(state.drawnCard?.card);
  for (const id of state.order) {
    for (const slot of state.playersById[id]?.board || []) {
      if (slot.faceUp || slot.removed) remember(slot.card);
    }
  }
  return counts;
}

function remainingCardCopies(state) {
  const remembered = rememberedCardCounts(state);
  const keys = ['-2', '-1', '0', ...Array.from({ length: 12 }, (_, index) => String(index + 1)), 'star'];
  return Object.fromEntries(keys.map((key) => [
    key,
    Math.max(0, initialCardCount(state.gameMode, key) - (remembered.get(key) || 0)),
  ]));
}

function discardGiftPenalty(player, card, gameMode) {
  if (!player || !card) return 0;
  const cardValue = slotValue({ card });
  const groups = gameMode === 'action' ? [...COLUMNS, ...ROWS] : COLUMNS;
  let penalty = 0;

  for (const indexes of groups) {
    const slots = indexes.map((index) => player.board[index]);
    if (slots.some((slot) => !slot || slot.removed)) continue;
    const hidden = slots.filter((slot) => !slot.faceUp);
    if (hidden.length !== 1) continue;
    const visible = slots.filter((slot) => slot.faceUp);
    const numericValues = visible
      .filter((slot) => !isStarCard(slot.card))
      .map((slot) => slotValue(slot));
    const completesGroup = isStarCard(card)
      ? numericValues.length <= 1 || numericValues.every((value) => value === numericValues[0])
      : numericValues.every((value) => value === cardValue);
    if (!completesGroup) continue;
    const removedScore = cardValue + visible.reduce((sum, slot) => sum + slotValue(slot), 0);
    const completesAllStarGroup = isStarCard(card)
      && visible.every((slot) => isStarCard(slot.card));
    if (completesAllStarGroup) penalty = Math.max(penalty, 30);
    else if (removedScore > 0) penalty = Math.max(penalty, 24 + removedScore);
  }

  const highestVisible = Math.max(0, ...visibleSlots(player).map(({ slot }) => slotValue(slot)));
  const immediateReplacementGain = Math.max(0, highestVisible - cardValue);
  return Math.max(penalty, Math.min(5, immediateReplacementGain * 0.35));
}

const ACTION_PLAY_PRIORITY = ['extraTurns', 'drawThree', 'removeEach', 'swapPlayers', 'stealAction', 'playDiscard', 'peekLine', 'swapOwn'];

function visibleSlots(player) {
  return player.board.map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => !slot.removed && slot.faceUp);
}

function equivalentCards(first, second) {
  return isStarCard(first) === isStarCard(second)
    && slotValue({ card: first }) === slotValue({ card: second });
}

function bestPlayerSwap(state, playerId) {
  const own = visibleSlots(state.playersById[playerId]);
  const opponents = state.order.filter((id) => id !== playerId)
    .flatMap((id) => visibleSlots(state.playersById[id]).map((entry) => ({ ...entry, playerId: id })));
  let best = null;
  for (const ownEntry of own) {
    for (const opponentEntry of opponents) {
      if (equivalentCards(ownEntry.slot.card, opponentEntry.slot.card)) continue;
      const ownGain = slotValue(ownEntry.slot) - slotValue(opponentEntry.slot);
      const score = ownGain * 2;
      if (score <= 0) continue;
      const candidate = { ownEntry, opponentEntry, score };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  if (!best) return null;
  return {
    first: { playerId, slotIndex: best.ownEntry.index },
    second: { playerId: best.opponentEntry.playerId, slotIndex: best.opponentEntry.index },
  };
}

function bestOwnSwap(player) {
  const available = player.board
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => !slot.removed);
  let best = null;
  for (let firstIndex = 0; firstIndex < available.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < available.length; secondIndex += 1) {
      const first = available[firstIndex];
      const second = available[secondIndex];
      const board = player.board.map((slot) => ({ ...slot }));
      [board[first.index].card, board[second.index].card] = [board[second.index].card, board[first.index].card];
      [board[first.index].faceUp, board[second.index].faceUp] = [board[second.index].faceUp, board[first.index].faceUp];
      const completedValue = [...COLUMNS, ...ROWS].reduce((total, indexes) => {
        const slots = indexes.map((index) => board[index]);
        if (!slots.every((slot) => slot && !slot.removed && slot.faceUp && slot.card)) return total;
        const numericValues = slots.filter((slot) => !isStarCard(slot.card)).map((slot) => slotValue(slot));
        if (numericValues.length > 0 && !numericValues.every((value) => value === numericValues[0])) return total;
        const removedScore = slots.reduce((sum, slot) => sum + slotValue(slot), 0);
        const allStars = slots.every((slot) => isStarCard(slot.card));
        return total + removedScore + (allStars ? (indexes.length === 4 ? 15 : 10) : 0);
      }, 0);
      const harmless = first.slot.faceUp === second.slot.faceUp
        && (!first.slot.faceUp || cardMemoryKey(first.slot.card) === cardMemoryKey(second.slot.card));
      const candidate = { slots: [first.index, second.index], score: completedValue, harmless };
      if (!best
        || candidate.score > best.score
        || candidate.score === best.score && Number(candidate.harmless) > Number(best.harmless)) {
        best = candidate;
      }
    }
  }
  return best;
}

function replayableBotDiscardCard(state, playerId) {
  const player = state.playersById[playerId];
  return [...(state.actionDiscard || [])].reverse()
    .find((candidate) => candidate.type === 'extraTurns'
      || candidate.type === 'defense'
      || candidate.type === 'peekLine' && hiddenSlots(player).length > 0
      || candidate.type === 'drawThree' && state.deck.length + Math.max(0, state.discard.length - 1) >= 3
      || candidate.type === 'removeEach' && state.order.length > 1
      || candidate.type === 'swapOwn' && bestOwnSwap(player)
      || candidate.type === 'swapPlayers' && bestPlayerSwap(state, playerId)
      || candidate.type === 'stealAction' && state.order.some((id) => id !== playerId
        && state.playersById[id]?.actionCards?.length));
}

function playableBotAction(state, playerId) {
  const player = state.playersById[playerId];
  const cards = (player.actionCards || [])
    .filter((card) => !card.temporary && card.availableAt <= state.turnSerial && card.type !== 'defense')
    .sort((a, b) => ACTION_PLAY_PRIORITY.indexOf(a.type) - ACTION_PLAY_PRIORITY.indexOf(b.type));
  return cards.find((card) => {
    if (card.type === 'swapPlayers') return !!bestPlayerSwap(state, playerId);
    if (card.type === 'stealAction') {
      return state.order.some((id) => id !== playerId && state.playersById[id]?.connected
        && state.playersById[id]?.actionCards?.length);
    }
    if (card.type === 'removeEach') return state.order.length > 1;
    if (card.type === 'drawThree') return state.deck.length + Math.max(0, state.discard.length - 1) >= 3;
    if (card.type === 'playDiscard') return !!replayableBotDiscardCard(state, playerId);
    if (card.type === 'peekLine') return hiddenSlots(player).length > 0;
    if (card.type === 'swapOwn') return !!bestOwnSwap(player);
    return card.type === 'extraTurns';
  });
}

export function evaluateBotTurnStrategy(state, playerId) {
  const player = state.playersById[playerId];
  const opponents = state.order
    .filter((id) => id !== playerId)
    .map((id) => state.playersById[id])
    .filter(Boolean);
  const nextPlayerId = state.order[(state.turnIndex + 1) % state.order.length];
  const hasOwnExtraTurn = state.gameMode === 'action'
    && !state.roundEnderId
    && (state.extraTurns?.[playerId] || 0) > 0;
  const nextPlayerCanUseDiscard = !hasOwnExtraTurn
    && nextPlayerId !== playerId
    && (!state.roundEnderId || nextPlayerId !== state.roundEnderId);
  const discardRecipient = nextPlayerCanUseDiscard ? state.playersById[nextPlayerId] : null;
  const discardGiftPenalties = Object.fromEntries(player.board
    .filter((slot) => slot.faceUp && !slot.removed && slot.card)
    .map((slot) => {
      const key = cardMemoryKey(slot.card);
      return [key, discardGiftPenalty(discardRecipient, slot.card, state.gameMode)];
    })
    .filter(([key]) => key));
  const projectedRoundScore = estimatedBoardScore(player);
  const playerPlausibleFinalTurnScore = plausibleFinalTurnScore(player);
  const opponentStates = opponents.map((opponent) => ({
    id: opponent.id,
    hiddenCount: hiddenSlots(opponent).length,
    projectedRoundScore: estimatedBoardScore(opponent),
    plausibleFinalTurnScore: plausibleFinalTurnScore(opponent),
    totalScore: opponent.totalScore || 0,
  }));
  const bestOpponentRoundScore = Math.min(...opponentStates
    .map(({ projectedRoundScore: score }) => score));
  const bestOpponentClosingRoundScore = Math.min(...opponentStates
    .map(({ plausibleFinalTurnScore: score }) => score));
  const opponentsNearFinish = opponentStates.filter(({ hiddenCount }) => hiddenCount <= 2).length;
  const closestOpponentHidden = Math.min(...opponentStates.map(({ hiddenCount }) => hiddenCount));
  const alreadyInLastTurns = !!state.roundEnderId;
  const projectedLead = bestOpponentRoundScore - projectedRoundScore;
  const playerHidden = hiddenSlots(player).length;
  const uncertaintyMargin = Math.min(10, 2
    + Math.sqrt(Math.max(0, playerHidden + closestOpponentHidden))
    + Math.max(0, opponents.length - 1));
  const safelyAhead = projectedLead >= uncertaintyMargin;
  const opponentHasFinished = closestOpponentHidden === 0;
  const mustReact = closestOpponentHidden <= 1 && projectedLead >= -2;
  const mustBreakFinalCardStandoff = playerHidden === 1
    && opponentStates.every(({ hiddenCount }) => hiddenCount <= 1)
    && playerPlausibleFinalTurnScore <= bestOpponentClosingRoundScore;
  const variant = effectiveRoomVariantSettings(state.roomSettings);
  const minimumProjectedRound = Math.min(projectedRoundScore, bestOpponentRoundScore);
  const prospectiveRoundEnderId = state.roundEnderId || playerId;
  const opponentProjectedTotals = opponentStates.map((opponent) => ({
    ...opponent,
    projectedTotal: opponent.totalScore + (
      prospectiveRoundEnderId === opponent.id
        && opponent.projectedRoundScore > minimumProjectedRound
        && opponent.projectedRoundScore > 0
        ? opponent.projectedRoundScore * 2
        : opponent.projectedRoundScore
    ),
    plausibleFinalTurnTotal: opponent.totalScore + opponent.plausibleFinalTurnScore,
  }));
  const botCouldDoubleAfterFinalTurn = prospectiveRoundEnderId === playerId
    && projectedRoundScore > bestOpponentClosingRoundScore
    && projectedRoundScore > 0;
  const botScoredRound = botCouldDoubleAfterFinalTurn ? projectedRoundScore * 2 : projectedRoundScore;
  const botProjectedTotal = (player.totalScore || 0) + botScoredRound;
  const roundWillEndGame = variant.gameEndMode === GAME_END_MODES.ROUND_COUNT
    && (state.completedRounds || 0) + 1 >= variant.roundLimit;
  const gameWouldEnd = variant.gameEndMode === GAME_END_MODES.ROUND_COUNT
    ? roundWillEndGame
    : [botProjectedTotal, ...opponentProjectedTotals.map(({ projectedTotal }) => projectedTotal)]
      .some((score) => score >= variant.scoreTarget);
  const bestOpponentProjectedTotal = Math.min(...opponentProjectedTotals
    .map(({ projectedTotal }) => projectedTotal));
  const bestOpponentClosingTotal = Math.min(...opponentProjectedTotals
    .map(({ plausibleFinalTurnTotal }) => plausibleFinalTurnTotal));
  const botWouldWinGame = botProjectedTotal <= bestOpponentProjectedTotal;
  const botWouldSurviveFinalTurn = botProjectedTotal <= bestOpponentClosingTotal;
  const canForceWinningEnd = gameWouldEnd && botWouldWinGame && botWouldSurviveFinalTurn;
  const wouldForceLosingEnd = gameWouldEnd && (!botWouldWinGame || !botWouldSurviveFinalTurn);
  const doublePenaltyRisk = botCouldDoubleAfterFinalTurn
    && projectedRoundScore - bestOpponentClosingRoundScore > 1;
  const winningMargin = bestOpponentProjectedTotal - botProjectedTotal;
  const securelyCrossingOpponent = variant.gameEndMode === GAME_END_MODES.SCORE_TARGET
    && opponentProjectedTotals.some((opponent) => {
      const conservativeTotal = opponent.projectedTotal - opponent.hiddenCount * 3;
      return conservativeTotal >= variant.scoreTarget;
    });
  const delayWinningFinish = !alreadyInLastTurns
    && playerHidden === 1
    && closestOpponentHidden > 1
    && canForceWinningEnd
    && securelyCrossingOpponent
    && winningMargin >= 8;
  const closeBoard = alreadyInLastTurns
    || mustBreakFinalCardStandoff
    || !delayWinningFinish && (
      canForceWinningEnd
      || !wouldForceLosingEnd && !doublePenaltyRisk
        && (opponentHasFinished || safelyAhead || mustReact)
    );
  const delayBonus = delayWinningFinish
    ? Math.min(10, 7 + winningMargin / 12)
    : closeBoard
    ? 0
    : wouldForceLosingEnd || doublePenaltyRisk
      ? 10
      : Math.min(8, Math.max(2.5, 3 + Math.max(0, -projectedLead) / 5));
  return {
    closeBoard,
    alreadyInLastTurns,
    projectedLead,
    projectedRoundScore,
    playerPlausibleFinalTurnScore,
    bestOpponentRoundScore,
    bestOpponentClosingRoundScore,
    playerTotalScore: player.totalScore || 0,
    opponentProjectedTotals,
    opponentsNearFinish,
    mustBreakFinalCardStandoff,
    closestOpponentHidden,
    uncertaintyMargin,
    delayBonus,
    variant,
    gameWouldEnd,
    roundWillEndGame,
    canForceWinningEnd,
    botWouldSurviveFinalTurn,
    bestOpponentClosingTotal,
    delayWinningFinish,
    maxWinningDelayCost: delayWinningFinish ? Math.min(3, Math.max(1, winningMargin / 10)) : 0,
    winningMargin,
    securelyCrossingOpponent,
    wouldForceLosingEnd,
    doublePenaltyRisk,
    remainingCopies: remainingCardCopies(state),
    discardGiftPenalties,
    deckCount: state.deck?.length || 0,
  };
}

function finishOutcomeUtility(strategy, projectedRoundDelta) {
  if (!Number.isFinite(strategy.projectedRoundScore)
    || !Number.isFinite(strategy.bestOpponentRoundScore)) {
    return strategy.closeBoard ? 5 : -10;
  }
  const projectedRound = strategy.projectedRoundScore + projectedRoundDelta;
  const opponentRoundBenchmark = strategy.alreadyInLastTurns
    ? strategy.bestOpponentRoundScore
    : strategy.bestOpponentClosingRoundScore ?? strategy.bestOpponentRoundScore;
  const doubled = !strategy.alreadyInLastTurns
    && projectedRound > opponentRoundBenchmark
    && projectedRound > 0;
  const scoredRound = doubled ? projectedRound * 2 : projectedRound;
  const projectedTotal = (strategy.playerTotalScore || 0) + scoredRound;
  const expectedOpponentTotals = strategy.opponentProjectedTotals
    ?.map(({ projectedTotal }) => projectedTotal) || [];
  const opponentTotals = strategy.opponentProjectedTotals?.map((opponent) => (
    strategy.alreadyInLastTurns
      ? opponent.projectedTotal
      : opponent.plausibleFinalTurnTotal ?? opponent.projectedTotal
  )) || [];
  const gameWouldEnd = strategy.variant?.gameEndMode === GAME_END_MODES.ROUND_COUNT
    ? strategy.roundWillEndGame
    : [projectedTotal, ...expectedOpponentTotals]
      .some((score) => score >= strategy.variant?.scoreTarget);
  const winsProjectedGame = opponentTotals.length === 0
    || projectedTotal <= Math.min(...opponentTotals);
  if (gameWouldEnd) {
    if (!winsProjectedGame) return -28;
    return strategy.delayWinningFinish ? -4 : 18;
  }
  if (doubled) return -Math.min(18, 7 + Math.max(0, projectedRound - opponentRoundBenchmark));
  return strategy.closeBoard ? 5 : -10;
}

function candidateScore(player, slotIndex, card, strategy) {
  const target = player.board[slotIndex];
  const cardValue = slotValue({ card });
  const replacedValue = target.faceUp ? slotValue(target) : UNKNOWN_CARD_EXPECTED_VALUE;
  let score = replacedValue - cardValue;
  let completesColumn = false;
  let buildsVisiblePair = false;
  const column = columnForSlot(slotIndex) || [];
  const others = column
    .filter((index) => index !== slotIndex)
    .map((index) => player.board[index])
    .filter((slot) => slot && !slot.removed);
  const visibleStars = others.filter((slot) => slot.faceUp && isStarCard(slot.card)).length;
  const visibleNumbers = others.filter((slot) => slot.faceUp && !isStarCard(slot.card));
  const completesNumericPairWithStar = isStarCard(card)
    && visibleNumbers.length === 2
    && slotValue(visibleNumbers[0]) === slotValue(visibleNumbers[1]);
  const visibleMatches = others.filter((slot) => slot.faceUp
    && !isStarCard(slot.card)
    && !isStarCard(card)
    && slotValue(slot) === cardValue).length;
  const hiddenOthers = others.filter((slot) => !slot.faceUp).length;
  const matchingColumnSum = cardValue + others.reduce((sum, slot) => sum + slotValue(slot), 0);
  let completedColumnRoundDelta = 0;

  if (others.length === 2 && visibleStars === 2 && isStarCard(card)) {
    score += 40;
    completesColumn = true;
    completedColumnRoundDelta = -(replacedValue + others.reduce((sum, slot) => sum + slotValue(slot), 0)) - 10;
  } else if (others.length === 2 && completesNumericPairWithStar) {
    score += 30;
    completesColumn = true;
    completedColumnRoundDelta = -(replacedValue + others.reduce((sum, slot) => sum + slotValue(slot), 0));
  } else if (others.length === 2 && visibleStars === 2) {
    score -= 30;
  } else if (others.length === 2 && visibleMatches + visibleStars === 2) {
    if (matchingColumnSum > 0) {
      score += 30;
      completesColumn = true;
      completedColumnRoundDelta = -(replacedValue + others.reduce((sum, slot) => sum + slotValue(slot), 0));
    } else {
      score -= 30 + Math.abs(matchingColumnSum);
    }
  } else if (visibleMatches + visibleStars === 1 && hiddenOthers === 1) {
    const remainingMatches = strategy.remainingCopies?.[cardMemoryKey(card)] || 0;
    const availableCards = Math.max(1, strategy.deckCount || 1);
    const matchProbability = Math.min(1, remainingMatches / availableCards);
    const potentialRemoval = Math.max(0, cardValue) * 3;
    const learnedPotential = matchProbability * potentialRemoval;
    score += cardValue <= 1
      ? 0.35
      : cardValue <= 4
        ? 2.25
      : cardValue <= 7
        ? Math.min(3, 0.75 + learnedPotential)
        : Math.min(4, learnedPotential);
    buildsVisiblePair = !target.faceUp && !isStarCard(card) && visibleMatches === 1;
  } else if (!isStarCard(card)
    && visibleStars === 0
    && visibleMatches === 1
    && hiddenOthers === 0) {
    const unmatchedSlot = others.find((slot) => slotValue(slot) !== cardValue);
    const unmatchedValue = slotValue(unmatchedSlot);
    const remainingMatches = strategy.remainingCopies?.[cardMemoryKey(card)] || 0;
    const availability = Math.min(1, remainingMatches / 3);
    if (cardValue > 0 && unmatchedValue > cardValue && availability > 0) {
      score += Math.min(5, 1.5 + (unmatchedValue - cardValue) * 0.75) * availability;
      buildsVisiblePair = true;
    }
  }

  if (target.faceUp) {
    const oldValue = slotValue(target);
    const matchingOldCards = others.filter((slot) => slot.faceUp && slotValue(slot) === oldValue).length;
    if (matchingOldCards === 1 && hiddenOthers === 1) {
      score -= oldValue <= 4 ? 1.5 : 0.35;
    }
    score -= strategy.discardGiftPenalties?.[cardMemoryKey(target.card)] || 0;
  }

  const hiddenCount = hiddenSlots(player).length;
  const isHiddenTarget = !target.faceUp;
  const pacePressure = Math.max(0, 3 - (strategy.closestOpponentHidden ?? 3));
  const visibleReplacementTempoCost = target.faceUp && hiddenCount > 1
    ? Math.max(0, (hiddenCount >= 8 ? 2.5 : hiddenCount >= 5 ? 1.5 : 0.5) - pacePressure)
    : 0;
  score -= visibleReplacementTempoCost;
  if (isHiddenTarget && hiddenCount > 1) {
    score += hiddenCount >= 8 ? 1.4 : hiddenCount >= 5 ? 0.8 : 0.35;
  }
  if (buildsVisiblePair && hiddenCount >= 6 && cardValue >= 7) {
    const remainingMatches = strategy.remainingCopies?.[cardMemoryKey(card)] || 0;
    const availability = Math.min(1, remainingMatches / 3);
    score += Math.min(8, cardValue - 2) * availability;
  }

  const materialScore = score;
  const isLastHiddenCard = isHiddenTarget && hiddenCount === 1;
  if (isLastHiddenCard) {
    const baseRoundDelta = cardValue - replacedValue;
    const outcomeUtility = finishOutcomeUtility(
      strategy,
      completesColumn ? completedColumnRoundDelta : baseRoundDelta,
    );
    score += strategy.alreadyInLastTurns
      ? outcomeUtility - finishOutcomeUtility(strategy, 0)
      : outcomeUtility;
  } else if (target.faceUp && hiddenCount === 1 && !strategy.closeBoard) {
    score += strategy.delayBonus;
  }

  return {
    index: slotIndex,
    score,
    materialScore,
    completesColumn,
    buildsVisiblePair,
    finishesBoard: isLastHiddenCard,
    replacesVisible: target.faceUp,
    visibleReplacementTempoCost,
    discardGiftPenalty: target.faceUp
      ? strategy.discardGiftPenalties?.[cardMemoryKey(target.card)] || 0
      : 0,
    immediateGain: replacedValue - cardValue,
  };
}

export function shouldRemoveGroupChoice(choice, player) {
  if (choice.allStars) return false;
  const cards = choice.cards || [];
  const stars = cards.filter((card) => card.kind === 'star').length;
  const numericSum = cards
    .filter((card) => card.kind !== 'star')
    .reduce((sum, card) => sum + (Number.isFinite(card.value) ? card.value : 0), 0);
  if (stars >= 2) {
    return hiddenSlots(player).length === 0 && numericSum > 0;
  }
  return numericSum > 0;
}

export function evaluateBotCardChoice(player, card, strategy = { closeBoard: true, delayBonus: 0 }) {
  const candidates = replaceableSlots(player)
    .map(({ index }) => candidateScore(player, index, card, strategy))
    .sort((a, b) => (
      Number(b.completesColumn) - Number(a.completesColumn)
      || b.score - a.score
      || a.index - b.index
    ));
  const best = candidates[0] || { index: undefined, score: -Infinity, completesColumn: false };
  const cardValue = slotValue({ card });
  const hiddenCount = hiddenSlots(player).length;
  let minimumGain = KEEP_CARD_MINIMUM_GAIN;
  if (hiddenCount >= 8) {
    if (cardValue >= 9) minimumGain = 6.5;
    else if (cardValue >= 6) minimumGain = 5;
    else if (cardValue >= 4) minimumGain = 4;
    else if (cardValue >= 2) minimumGain = 1.3;
    else minimumGain = 0;
  } else if (hiddenCount >= 5) {
    if (cardValue >= 9) minimumGain = 5;
    else if (cardValue >= 6) minimumGain = 3.5;
    else if (cardValue >= 4) minimumGain = 2;
    else if (cardValue <= 1) minimumGain = 0;
  } else if (hiddenCount >= 2) {
    if (cardValue >= 9) minimumGain = 4.5;
    else if (cardValue >= 7) minimumGain = 3;
    else if (cardValue >= 5) minimumGain = 1.5;
    else if (cardValue <= 1) minimumGain = 0;
  }
  const strategicDelayReplacement = strategy.delayWinningFinish
    && best.replacesVisible
    && best.immediateGain >= -(strategy.maxWinningDelayCost || 0);
  return {
    ...best,
    keep: best.completesColumn || strategicDelayReplacement || best.score >= minimumGain,
  };
}

function placementSlot(player, card, strategy) {
  return evaluateBotCardChoice(player, card, strategy).index;
}

function shouldTakeDiscard(player, card, strategy) {
  const choice = evaluateBotCardChoice(player, card, strategy);
  const cardValue = slotValue({ card });
  const requiredMaterialGain = EXPERT_DISCARD_GAIN
    .find(({ maxValue }) => cardValue <= maxValue)?.gain ?? Infinity;
  const strategicPair = choice.buildsVisiblePair
    && hiddenSlots(player).length >= 6
    && (strategy.remainingCopies?.[cardMemoryKey(card)] || 0) >= 3
    && choice.immediateGain >= -5;
  if (hiddenSlots(player).length === 1
    && cardValue >= 4
    && !strategy.closeBoard
    && !choice.completesColumn
    && choice.materialScore < Math.max(4, requiredMaterialGain)) {
    return false;
  }
  return choice.keep && (
    choice.completesColumn
    || strategicPair
    || choice.materialScore >= requiredMaterialGain
  );
}

export function chooseBotDrawSource(player, discardCard, strategy = { closeBoard: true, delayBonus: 0 }) {
  return discardCard && shouldTakeDiscard(player, discardCard, strategy) ? 'discard' : 'deck';
}

function strategicHiddenSlot(player, { initial = false } = {}) {
  const candidates = hiddenSlots(player).map(({ index }) => {
    const others = (columnForSlot(index) || [])
      .filter((otherIndex) => otherIndex !== index)
      .map((otherIndex) => player.board[otherIndex])
      .filter((slot) => slot && !slot.removed);
    const visible = others.filter((slot) => slot.faceUp);
    const visiblePair = visible.length === 2 && slotValue(visible[0]) === slotValue(visible[1]);
    const lowVisibleValue = visible.length
      ? Math.min(...visible.map((slot) => slotValue(slot)))
      : UNKNOWN_CARD_EXPECTED_VALUE;
    return {
      index,
      score: (visiblePair ? 10 : 0)
        + visible.length * 2
        + Math.max(0, 5 - lowVisibleValue)
        + (initial && visible.length === 1 ? 3 : 0),
    };
  });
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0];
}

function resolveDrawThree(state, pending) {
  const player = state.playersById[pending.playerId];
  const strategy = evaluateBotTurnStrategy(state, player.id);
  const choices = (pending.drawn || []).map((card, choiceIndex) => ({
    choiceIndex,
    card,
    placement: evaluateBotCardChoice(player, card, strategy),
  })).sort((a, b) => Number(b.placement.completesColumn) - Number(a.placement.completesColumn)
    || b.placement.score - a.placement.score);
  const best = choices[0];
  if (best?.placement.keep && Number.isInteger(best.placement.index)) {
    resolveActionInput(state, player.id, { choiceIndex: best.choiceIndex, slotIndex: best.placement.index });
  } else {
    const target = strategicHiddenSlot(player);
    if (!target) return false;
    resolveActionInput(state, player.id, { choiceIndex: null, revealSlot: target.index });
  }
  return true;
}

function resolveRemoveEach(state, pending) {
  const targetId = pending.remaining?.[0];
  const target = state.playersById[targetId];
  if (!target) return false;
  const visible = visibleSlots(target).sort((a, b) => slotValue(a.slot) - slotValue(b.slot));
  const hidden = hiddenSlots(target);
  const slotIndex = visible[0]?.index ?? hidden[0]?.index;
  if (!Number.isInteger(slotIndex)) return false;
  resolveActionInput(state, pending.playerId, { targetPlayerId: targetId, slotIndex });
  return true;
}

function resolveStealAction(state, pending) {
  const priorities = ACTION_PLAY_PRIORITY.filter((type) => type !== 'stealAction');
  const targets = state.order.filter((id) => id !== pending.playerId && state.playersById[id]?.connected)
    .flatMap((id) => (state.playersById[id].actionCards || []).map((card) => ({ targetPlayerId: id, card })))
    .sort((a, b) => priorities.indexOf(a.card.type) - priorities.indexOf(b.card.type));
  const best = targets[0];
  if (!best) return false;
  resolveActionInput(state, pending.playerId, { targetPlayerId: best.targetPlayerId, cardId: best.card.id });
  return true;
}

function resolvePeekLine(state, pending) {
  const player = state.playersById[pending.playerId];
  const target = strategicHiddenSlot(player);
  if (!target) return false;
  const hiddenCount = hiddenSlots(player).length;
  const columnHasOther = (columnForSlot(target.index) || [])
    .some((index) => index !== target.index && !player.board[index]?.removed);
  const rowHasOther = (ROWS.find((row) => row.includes(target.index)) || [])
    .some((index) => index !== target.index && !player.board[index]?.removed);
  resolveActionInput(state, player.id, {
    targetPlayerId: player.id,
    firstSlotIndex: target.index,
    groupType: hiddenCount === 1 ? 'single' : columnHasOther ? 'column' : rowHasOther ? 'row' : 'single',
  });
  return true;
}

function resolvePlayDiscard(state, pending) {
  const card = replayableBotDiscardCard(state, pending.playerId);
  if (!card) return false;
  resolveActionInput(state, pending.playerId, { cardId: card.id });
  return true;
}

function resolvePendingBotAction(state) {
  const pending = state.pendingAction;
  if (!pending || !state.playersById[pending.playerId]?.isBot || pending.defensePrompt) return false;
  if (pending.type === 'drawThree') return resolveDrawThree(state, pending);
  if (pending.type === 'removeEach') return resolveRemoveEach(state, pending);
  if (pending.type === 'swapOwn') {
    const swap = bestOwnSwap(state.playersById[pending.playerId]);
    if (!swap) return false;
    resolveActionInput(state, pending.playerId, { slots: swap.slots });
    return true;
  }
  if (pending.type === 'swapPlayers') {
    const swap = bestPlayerSwap(state, pending.playerId);
    if (!swap) return false;
    resolveActionInput(state, pending.playerId, swap);
    return true;
  }
  if (pending.type === 'stealAction') return resolveStealAction(state, pending);
  if (pending.type === 'peekLine') return resolvePeekLine(state, pending);
  if (pending.type === 'playDiscard') return resolvePlayDiscard(state, pending);
  return false;
}

function resolveBotPrompt(state) {
  const defense = state.pendingAction?.defensePrompt;
  if (defense && state.playersById[defense.targetId]?.isBot) {
    resolveDefensePrompt(state, defense.targetId, true);
    return true;
  }
  const starClaim = [state.pendingStarClaim, ...(state.pendingInitialStarClaims || [])]
    .find((claim) => state.playersById[claim?.playerId]?.isBot);
  if (starClaim) {
    const priorities = ['extraTurns', 'drawThree', 'removeEach', 'swapPlayers', 'stealAction', 'playDiscard', 'defense', 'peekLine', 'swapOwn'];
    const marketIndex = (state.actionMarket || [])
      .map((card, index) => ({ index, priority: priorities.indexOf(card.type) }))
      .sort((a, b) => (a.priority < 0 ? Infinity : a.priority) - (b.priority < 0 ? Infinity : b.priority))[0]?.index;
    const hasMarketCard = Number.isInteger(marketIndex);
    claimStarAction(state, starClaim.playerId, hasMarketCard ? 'market' : 'deck', marketIndex);
    return true;
  }
  const groupChoice = [...(state.pendingGroupChoices || []), state.pendingGroupChoice]
    .find((choice) => state.playersById[choice?.playerId]?.isBot);
  if (groupChoice) {
    const player = state.playersById[groupChoice.playerId];
    resolveGroupChoice(state, groupChoice.playerId, shouldRemoveGroupChoice(groupChoice, player));
    return true;
  }
  return resolvePendingBotAction(state);
}

export function performBotStep(state) {
  if (resolveBotPrompt(state)) return true;
  if (state.phase === 'initialFlip') {
    const players = botPlayers(state).filter((candidate) => candidate.flippedCount < 2);
    let changed = false;
    for (const player of players) {
      if (state.phase !== 'initialFlip') break;
      const target = strategicHiddenSlot(player, { initial: true });
      if (!target) continue;
      flipInitialCard(state, player.id, target.index);
      changed = true;
    }
    return changed;
  }
  if (state.phase !== 'playing') return false;
  const playerId = state.order[state.turnIndex];
  const player = state.playersById[playerId];
  if (!player?.isBot || state.pendingAction) return false;
  const strategy = evaluateBotTurnStrategy(state, playerId);
  if (state.gameMode === 'action' && state.turnStage === 'choose' && !state.roundEnderId) {
    const action = playableBotAction(state, playerId);
    if (action) {
      playOwnedAction(state, playerId, action.id);
      return true;
    }
  }
  if (['draw', 'choose'].includes(state.turnStage)) {
    const discard = state.discard[state.discard.length - 1];
    drawCard(state, playerId, chooseBotDrawSource(player, discard, strategy));
    return true;
  }
  if (state.turnStage === 'decide') {
    const choice = evaluateBotCardChoice(player, state.drawnCard?.card, strategy);
    decideDrawnCard(state, playerId, choice.keep);
    return true;
  }
  if (state.turnStage === 'place') {
    const target = placementSlot(player, state.drawnCard?.card, strategy);
    if (target === undefined) return false;
    placeDrawnCard(state, playerId, target);
    return true;
  }
  if (state.turnStage === 'reveal') {
    const target = strategicHiddenSlot(player);
    if (!target) return false;
    revealHiddenCard(state, playerId, target.index);
    return true;
  }
  return false;
}
