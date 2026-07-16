import React from 'react';
import Card from './Card.jsx';

export default function PlayerBoard({
  player,
  isMe,
  onSlotClick,
  selectableSlots,
  selectedSlots,
  isActive,
  size,
  actionMode,
  actionPopup,
  actionCardCount = null,
  onActionCardsClick,
  suppressRevealAnimation = false,
}) {
  const cardSize = size || 'table';
  const selectableSet = new Set(selectableSlots || []);
  const selectedSet = new Set(selectedSlots || []);
  const hasVisibleTotalScore = Number.isFinite(player.totalScore);
  const totalValue = hasVisibleTotalScore ? player.totalScore : '-';
  const hasActionCardCount = Number.isInteger(actionCardCount);
  const boardClasses = [
    'sj-board',
    isMe ? 'sj-board-me' : 'sj-board-opp',
    isActive ? 'sj-board-active' : '',
    actionMode ? `sj-board-mode-${actionMode}` : '',
  ].filter(Boolean);

  return (
    <section className={boardClasses.join(' ')}>
      {actionPopup && (
        <div key={actionPopup.id} className="sj-board-action-popup" aria-live="polite">
          <div className="sj-board-action-popup-card">
            <span
              className={`sj-board-action-popup-art sj-action-art-${actionPopup.artType || 'drawThree'}`}
              aria-hidden="true"
            />
            <span className="sj-board-action-popup-copy">
              <strong>{actionPopup.title}</strong>
            </span>
          </div>
        </div>
      )}
      <div
        className="sj-total-score-badge"
        aria-label={hasVisibleTotalScore ? `Total ${player.totalScore}` : 'Total non calculé'}
      >
        <strong>{totalValue}</strong>
      </div>
      <header className="sj-board-header">
        <div className="sj-player-main">
          <span className={`sj-player-dot ${player.connected ? 'sj-player-dot-online' : 'sj-player-dot-offline'}`} />
          <span className="sj-player-name" title={player.name}>{player.name}</span>
          {hasActionCardCount && onActionCardsClick && (
            <button
              type="button"
              className="sj-action-count-badge"
              title={`${actionCardCount} carte${actionCardCount > 1 ? 's' : ''} Action`}
              aria-label={`${actionCardCount} carte${actionCardCount > 1 ? 's' : ''} Action`}
              onClick={onActionCardsClick}
            >
              <span className="sj-action-count-icon" aria-hidden="true" />
              <strong>{actionCardCount}</strong>
            </button>
          )}
          {hasActionCardCount && !onActionCardsClick && (
            <span
              className="sj-action-count-badge"
              title={`${actionCardCount} carte${actionCardCount > 1 ? 's' : ''} Action`}
              aria-label={`${actionCardCount} carte${actionCardCount > 1 ? 's' : ''} Action`}
            >
              <span className="sj-action-count-icon" aria-hidden="true" />
              <strong>{actionCardCount}</strong>
            </span>
          )}
          {player.lastRoundScore !== null && player.lastRoundScore !== undefined && (
            <span className="sj-last-round-inline">+{player.lastRoundScore}</span>
          )}
        </div>
      </header>

      <div className="sj-grid">
        {player.board.map((slot, index) => {
          const selectable = selectableSet.has(index);
          const cardIdentity = slot.cardId || (slot.faceUp ? `${slot.kind || 'empty'}-${slot.value ?? 'empty'}` : 'hidden');
          const cardKey = slot.removed
            ? `slot-${index}-removed`
            : `slot-${index}-${slot.faceUp ? 'up' : 'down'}-${cardIdentity}`;

          return (
            <Card
              key={cardKey}
              value={slot.value}
              kind={slot.kind}
              faceUp={slot.faceUp}
              removed={slot.removed}
              size={cardSize}
              highlighted={selectable}
              selected={selectedSet.has(index)}
              onClick={selectable ? () => onSlotClick(index) : undefined}
              suppressRevealAnimation={suppressRevealAnimation}
            />
          );
        })}
      </div>
    </section>
  );
}
