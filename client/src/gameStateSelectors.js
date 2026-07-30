const BOARD_COLUMNS = 4;
const BOARD_ROWS = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [8, 9, 10, 11],
];
const BOARD_COLUMN_GROUPS = [
  [0, 4, 8],
  [1, 5, 9],
  [2, 6, 10],
  [3, 7, 11],
];

export function getSelectableSlots(state, isMyTurn, me) {
  if (!me) return null;

  if (state.phase === 'initialFlip' && me.flippedCount < 2) {
    return me.board.map((slot, index) => (!slot.faceUp && !slot.removed ? index : -1)).filter((index) => index >= 0);
  }

  if (state.phase !== 'playing' || !isMyTurn) return null;

  if (state.turnStage === 'decide' || state.turnStage === 'place') {
    return me.board.map((slot, index) => (!slot.removed ? index : -1)).filter((index) => index >= 0);
  }

  if (state.turnStage === 'reveal') {
    return me.board.map((slot, index) => (!slot.faceUp && !slot.removed ? index : -1)).filter((index) => index >= 0);
  }

  return null;
}

export function getBoardActionMode(state) {
  if (state.phase === 'initialFlip' || state.turnStage === 'reveal') return 'reveal';
  if (state.turnStage === 'decide' || state.turnStage === 'place') return 'place';
  return null;
}

export function getPeekLineCandidates(player, first) {
  if (!player) return [];

  if (!first) {
    return player.board
      .map((slot, index) => (!slot.removed && !slot.faceUp ? index : -1))
      .filter((index) => index >= 0);
  }
  return [];
}

export function getPeekLineOptions(player, firstSlotIndex) {
  if (!player || !Number.isInteger(firstSlotIndex)) return [];
  const firstSlot = player.board[firstSlotIndex];
  if (!firstSlot || firstSlot.removed || firstSlot.faceUp) return [];

  const groups = [
    { groupType: 'row', indexes: BOARD_ROWS[Math.floor(firstSlotIndex / BOARD_COLUMNS)] },
    { groupType: 'column', indexes: BOARD_COLUMN_GROUPS[firstSlotIndex % BOARD_COLUMNS] },
  ];

  return groups.flatMap(({ groupType, indexes }) => {
    const hasOtherCard = indexes.some((index) => (
      index !== firstSlotIndex && !player.board[index]?.removed
    ));
    if (!hasOtherCard) return [];

    const cards = indexes.map((slotIndex) => {
      const slot = player.board[slotIndex];
      return {
        slotIndex,
        value: slot?.value ?? null,
        kind: slot?.kind || 'number',
        faceUp: !!slot?.faceUp,
        removed: !!slot?.removed,
        selected: slotIndex === firstSlotIndex,
      };
    });
    return [{
      groupType,
      indexes,
      cards,
      hiddenCount: cards.filter((card) => !card.removed && !card.faceUp).length,
    }];
  });
}
