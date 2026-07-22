const NUMBER = 'number';

const TUTORIAL_CARD_VALUES = [12, -2, 4, 8, 3, 6, 0, 11, 3, 1, 5, 9];

function cardSlot(value, index) {
  return {
    cardId: `tutorial-${index}-${value}`,
    value,
    kind: NUMBER,
    faceUp: false,
    removed: false,
  };
}

function revealSlot(board, slotIndex) {
  return board.map((slot, index) => index === slotIndex ? { ...slot, faceUp: true } : slot);
}

function playableBoardSlots(board) {
  return board
    .map((slot, index) => (slot && !slot.removed ? index : -1))
    .filter((index) => index >= 0);
}

function cardMove(card, faceUp = true) {
  return {
    id: card?.id || card?.cardId,
    value: card?.value,
    kind: card?.kind || NUMBER,
    faceUp,
  };
}

function appendCardMoves(state, moves) {
  const start = state.moveSerial || 0;
  return {
    moveSerial: start + moves.length,
    cardMoves: [
      ...(state.cardMoves || []),
      ...moves.map((move, index) => ({
        ...move,
        id: `tutorial-move-${start + index + 1}`,
      })),
    ],
  };
}

export const TUTORIAL_PHASES = Object.freeze({
  REVEAL: 'reveal',
  TAKE_DISCARD: 'takeDiscard',
  PLACE_DISCARD: 'placeDiscard',
  DRAW_DECK: 'drawDeck',
  DISCARD_DRAWN: 'discardDrawn',
  REVEAL_AFTER_DISCARD: 'revealAfterDiscard',
  DRAW_STAR: 'drawStar',
  PLACE_STAR: 'placeStar',
  CLAIM_ACTION: 'claimAction',
  OPEN_ACTION_HAND: 'openActionHand',
  PLAY_ACTION: 'playAction',
  CHOOSE_ACTION_CARD: 'chooseActionCard',
  PLACE_ACTION_CARD: 'placeActionCard',
  COMPLETE: 'complete',
});

export const TUTORIAL_EVENTS = Object.freeze({
  RESET: 'reset',
  REVEAL_SLOT: 'revealSlot',
  DRAW_DISCARD: 'drawDiscard',
  DRAW_DECK: 'drawDeck',
  PLACE_DRAWN: 'placeDrawn',
  DISCARD_DRAWN: 'discardDrawn',
  CLAIM_ACTION: 'claimAction',
  OPEN_ACTION_HAND: 'openActionHand',
  CLOSE_ACTION_HAND: 'closeActionHand',
  PLAY_ACTION: 'playAction',
  CHOOSE_ACTION_CARD: 'chooseActionCard',
  PLACE_ACTION_CARD: 'placeActionCard',
});

export function createTutorialGame(gameMode = 'classic') {
  const board = TUTORIAL_CARD_VALUES.map(cardSlot);
  return {
    gameMode,
    phase: TUTORIAL_PHASES.REVEAL,
    board,
    revealedCount: 0,
    revealTarget: null,
    drawnCard: null,
    drawnFrom: null,
    discardTop: { id: 'tutorial-discard-3', cardId: 'tutorial-discard-3', value: 3, kind: NUMBER },
    actionCards: [],
    actionChoices: [],
    selectedActionCard: null,
    discardedDrawThreeCards: [],
    moveSerial: 0,
    cardMoves: [],
    resetSerial: 0,
  };
}

export function tutorialGameReducer(state, event) {
  if (!event || typeof event.type !== 'string') return state;

  if (event.type === TUTORIAL_EVENTS.RESET) {
    return {
      ...createTutorialGame(event.gameMode || state.gameMode),
      resetSerial: (state.resetSerial || 0) + 1,
    };
  }

  if (state.phase === TUTORIAL_PHASES.REVEAL && event.type === TUTORIAL_EVENTS.REVEAL_SLOT) {
    const requiredSlot = state.revealedCount === 0 ? 0 : 4;
    const slot = state.board[event.slotIndex];
    if (event.slotIndex !== requiredSlot) return state;
    if (!slot || slot.faceUp || slot.removed) return state;
    const board = revealSlot(state.board, event.slotIndex);
    const revealedCount = state.revealedCount + 1;
    return {
      ...state,
      board,
      revealedCount,
      phase: revealedCount === 2 ? TUTORIAL_PHASES.TAKE_DISCARD : state.phase,
    };
  }

  if (state.phase === TUTORIAL_PHASES.TAKE_DISCARD && event.type === TUTORIAL_EVENTS.DRAW_DISCARD) {
    return {
      ...state,
      phase: TUTORIAL_PHASES.PLACE_DISCARD,
      drawnCard: { id: 'tutorial-discard-3', value: 3, kind: NUMBER },
      drawnFrom: 'discard',
      discardTop: { id: 'tutorial-under-discard-9', cardId: 'tutorial-under-discard-9', value: 9, kind: NUMBER },
    };
  }

  if (state.phase === TUTORIAL_PHASES.PLACE_DISCARD
    && event.type === TUTORIAL_EVENTS.PLACE_DRAWN
    && event.slotIndex === 0) {
    const oldCard = state.board[0];
    const board = state.board.map((slot, index) => index === 0 ? {
      ...slot,
      cardId: state.drawnCard.id,
      value: state.drawnCard.value,
      kind: state.drawnCard.kind,
      faceUp: true,
    } : slot);
    const motion = appendCardMoves(state, [{
      type: 'placement',
      playerId: 'tutorial-player',
      slotIndex: 0,
      oldCard: cardMove(oldCard),
      newCard: cardMove(state.drawnCard),
    }]);
    return {
      ...state,
      ...motion,
      board,
      phase: TUTORIAL_PHASES.DRAW_DECK,
      drawnCard: null,
      drawnFrom: null,
      discardTop: { ...cardMove(oldCard), cardId: oldCard.cardId },
    };
  }

  if (state.phase === TUTORIAL_PHASES.DRAW_DECK && event.type === TUTORIAL_EVENTS.DRAW_DECK) {
    return {
      ...state,
      phase: TUTORIAL_PHASES.DISCARD_DRAWN,
      drawnCard: { id: 'tutorial-drawn-10', value: 10, kind: NUMBER },
      drawnFrom: 'deck',
    };
  }

  if (state.phase === TUTORIAL_PHASES.DISCARD_DRAWN && event.type === TUTORIAL_EVENTS.DISCARD_DRAWN) {
    return {
      ...state,
      phase: TUTORIAL_PHASES.REVEAL_AFTER_DISCARD,
      revealTarget: 8,
      drawnCard: null,
      drawnFrom: null,
      discardTop: { ...state.drawnCard, cardId: state.drawnCard.id },
    };
  }

  if (state.phase === TUTORIAL_PHASES.REVEAL_AFTER_DISCARD
    && event.type === TUTORIAL_EVENTS.REVEAL_SLOT
    && event.slotIndex === state.revealTarget) {
    const revealedBoard = revealSlot(state.board, 8);
    const board = state.board.map((slot, index) => [0, 4, 8].includes(index)
      ? { ...slot, faceUp: true, removed: true }
      : slot);
    const groupCards = [0, 4, 8].map((slotIndex) => ({
      playerId: 'tutorial-player',
      slotIndex,
      card: cardMove(revealedBoard[slotIndex]),
    }));
    const motion = appendCardMoves(state, [
      { type: 'reveal', cards: [groupCards[2]] },
      { type: 'clear', cards: groupCards },
    ]);
    return state.gameMode === 'action'
      ? {
        ...state,
        ...motion,
        phase: TUTORIAL_PHASES.DRAW_STAR,
        board,
        revealTarget: null,
      }
      : { ...state, ...motion, phase: TUTORIAL_PHASES.COMPLETE, board, revealTarget: null };
  }

  if (state.phase === TUTORIAL_PHASES.DRAW_STAR
    && event.type === TUTORIAL_EVENTS.DRAW_DECK) {
    return {
      ...state,
      phase: TUTORIAL_PHASES.PLACE_STAR,
      drawnCard: { id: 'tutorial-drawn-star', value: 0, kind: 'star' },
      drawnFrom: 'deck',
    };
  }

  if (state.phase === TUTORIAL_PHASES.PLACE_STAR
    && event.type === TUTORIAL_EVENTS.PLACE_DRAWN
    && playableBoardSlots(state.board).includes(event.slotIndex)) {
    const oldCard = state.board[event.slotIndex];
    const board = state.board.map((slot, index) => index === event.slotIndex ? {
      ...slot,
      cardId: state.drawnCard.id,
      value: state.drawnCard.value,
      kind: state.drawnCard.kind,
      faceUp: true,
    } : slot);
    const motion = appendCardMoves(state, [{
      type: 'placement',
      playerId: 'tutorial-player',
      slotIndex: event.slotIndex,
      oldCard: cardMove(oldCard),
      newCard: cardMove(state.drawnCard),
    }]);
    return {
      ...state,
      ...motion,
      phase: TUTORIAL_PHASES.CLAIM_ACTION,
      board,
      drawnCard: null,
      drawnFrom: null,
      discardTop: { ...cardMove(oldCard), cardId: oldCard.cardId },
      actionChoices: ['swapOwn', 'drawThree', 'peekLine', 'defense'],
    };
  }

  if (state.phase === TUTORIAL_PHASES.CLAIM_ACTION
    && event.type === TUTORIAL_EVENTS.CLAIM_ACTION
    && event.actionType === 'drawThree') {
    return {
      ...state,
      phase: TUTORIAL_PHASES.OPEN_ACTION_HAND,
      actionChoices: [],
      actionCards: [{ id: 'tutorial-action-draw-three', type: 'drawThree', availableAt: 1 }],
    };
  }

  if (state.phase === TUTORIAL_PHASES.OPEN_ACTION_HAND
    && event.type === TUTORIAL_EVENTS.OPEN_ACTION_HAND) {
    return { ...state, phase: TUTORIAL_PHASES.PLAY_ACTION };
  }

  if (state.phase === TUTORIAL_PHASES.PLAY_ACTION
    && event.type === TUTORIAL_EVENTS.CLOSE_ACTION_HAND) {
    return { ...state, phase: TUTORIAL_PHASES.OPEN_ACTION_HAND };
  }

  if (state.phase === TUTORIAL_PHASES.PLAY_ACTION
    && event.type === TUTORIAL_EVENTS.PLAY_ACTION
    && event.actionType === 'drawThree') {
    return {
      ...state,
      phase: TUTORIAL_PHASES.CHOOSE_ACTION_CARD,
      actionChoices: [
        { id: 'tutorial-choice-minus-2', value: -2, kind: NUMBER },
        { id: 'tutorial-choice-5', value: 5, kind: NUMBER },
        { id: 'tutorial-choice-11', value: 11, kind: NUMBER },
      ],
    };
  }

  if (state.phase === TUTORIAL_PHASES.CHOOSE_ACTION_CARD
    && event.type === TUTORIAL_EVENTS.CHOOSE_ACTION_CARD) {
    const selectedActionCard = state.actionChoices.find((card) => card.id === event.cardId);
    if (!selectedActionCard) return state;
    return {
      ...state,
      phase: TUTORIAL_PHASES.PLACE_ACTION_CARD,
      actionChoices: [],
      selectedActionCard,
      discardedDrawThreeCards: state.actionChoices.filter((card) => card.id !== event.cardId),
    };
  }

  if (state.phase === TUTORIAL_PHASES.PLACE_ACTION_CARD
    && event.type === TUTORIAL_EVENTS.PLACE_ACTION_CARD
    && playableBoardSlots(state.board).includes(event.slotIndex)) {
    const oldCard = state.board[event.slotIndex];
    const board = state.board.map((slot, index) => index === event.slotIndex ? {
      ...slot,
      cardId: state.selectedActionCard.id,
      value: state.selectedActionCard.value,
      kind: state.selectedActionCard.kind,
      faceUp: true,
    } : slot);
    const discardedCards = state.discardedDrawThreeCards;
    const discardTop = discardedCards.at(-1) || oldCard;
    const motion = appendCardMoves(state, [{
      type: 'replacement',
      playerId: 'tutorial-player',
      slotIndex: event.slotIndex,
      source: 'deck',
      oldCard: cardMove(oldCard),
      newCard: cardMove(state.selectedActionCard),
      revealOldCard: true,
      discardedCards,
      animateDiscardedCards: false,
    }]);
    return {
      ...state,
      ...motion,
      phase: TUTORIAL_PHASES.COMPLETE,
      board,
      discardTop: { ...cardMove(discardTop), cardId: discardTop.id || discardTop.cardId },
      actionCards: [],
      discardedDrawThreeCards: [],
    };
  }

  return state;
}

export function tutorialSelectableSlots(state) {
  if (state.phase === TUTORIAL_PHASES.REVEAL) {
    return [state.revealedCount === 0 ? 0 : 4];
  }
  if (state.phase === TUTORIAL_PHASES.PLACE_DISCARD) return [0];
  if (state.phase === TUTORIAL_PHASES.REVEAL_AFTER_DISCARD) return [state.revealTarget];
  if (state.phase === TUTORIAL_PHASES.PLACE_STAR) return playableBoardSlots(state.board);
  if (state.phase === TUTORIAL_PHASES.PLACE_ACTION_CARD) return playableBoardSlots(state.board);
  return [];
}

export function tutorialProgress(state) {
  const classicStepByPhase = {
    [TUTORIAL_PHASES.REVEAL]: 1,
    [TUTORIAL_PHASES.TAKE_DISCARD]: 2,
    [TUTORIAL_PHASES.PLACE_DISCARD]: 2,
    [TUTORIAL_PHASES.DRAW_DECK]: 3,
    [TUTORIAL_PHASES.DISCARD_DRAWN]: 3,
    [TUTORIAL_PHASES.REVEAL_AFTER_DISCARD]: 4,
  };
  const actionStepByPhase = {
    ...classicStepByPhase,
    [TUTORIAL_PHASES.DRAW_STAR]: 5,
    [TUTORIAL_PHASES.PLACE_STAR]: 5,
    [TUTORIAL_PHASES.CLAIM_ACTION]: 6,
    [TUTORIAL_PHASES.OPEN_ACTION_HAND]: 7,
    [TUTORIAL_PHASES.PLAY_ACTION]: 7,
    [TUTORIAL_PHASES.CHOOSE_ACTION_CARD]: 7,
    [TUTORIAL_PHASES.PLACE_ACTION_CARD]: 7,
  };
  const isActionMode = state.gameMode === 'action';
  const total = isActionMode ? 7 : 4;
  const steps = isActionMode ? actionStepByPhase : classicStepByPhase;
  const current = state.phase === TUTORIAL_PHASES.COMPLETE
    ? total
    : steps[state.phase] || 1;
  return {
    current,
    completed: state.phase === TUTORIAL_PHASES.COMPLETE ? total : Math.max(0, current - 1),
    total,
  };
}
