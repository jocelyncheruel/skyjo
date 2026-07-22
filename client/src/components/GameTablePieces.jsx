import React, { useEffect, useRef } from 'react';
import { ACTION_ART_URLS, ACTION_LABELS } from '../gameGuide.js';
import Card from './Card.jsx';

export function PileButton({
  ariaLabel,
  enabled,
  active,
  tone = 'default',
  drawnCard,
  drawnFrom,
  drawnPulse = false,
  onClick,
  children,
}) {
  return (
    <button
      type="button"
      className={`sj-pile-button sj-pile-${tone} ${active ? 'sj-pile-active' : ''} ${drawnCard ? 'sj-pile-has-drawn' : ''}`}
      disabled={!enabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
      {drawnCard && (
        <span className={`sj-drawn-card-overlay sj-drawn-from-${drawnFrom}`}>
          <Card
            value={drawnCard.value}
            kind={drawnCard.kind}
            faceUp={!drawnCard.hidden}
            size="pile"
            pulse={drawnPulse && drawnFrom === 'deck'}
            tone={tone === 'danger' ? 'danger' : undefined}
            animateFlip={drawnFrom === 'deck' && !drawnCard.hidden}
          />
        </span>
      )}
    </button>
  );
}

export function ActionTile({ card, onClick, disabled = false, compact = false, interactive = true }) {
  const artType = Object.hasOwn(ACTION_ART_URLS, card.type) ? card.type : 'drawThree';
  const className = `sj-action-card ${compact ? 'sj-action-card-compact' : ''} ${!interactive ? 'sj-action-card-static' : ''}`.trim();
  const content = (
    <>
      <span
        className={`sj-action-card-art sj-action-art-${artType}`}
        aria-hidden="true"
      />
      <span className="sj-action-card-copy">
        <strong>{ACTION_LABELS[card.type] || 'Carte Action'}</strong>
      </span>
    </>
  );

  if (!interactive) {
    return (
      <div
        className={className}
        role="img"
        aria-label={ACTION_LABELS[card.type] || 'Carte Action'}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={onClick}
      aria-label={ACTION_LABELS[card.type] || 'Carte Action'}
      title={disabled ? card.unavailableReason : undefined}
    >
      {content}
    </button>
  );
}

export function ActionDrawModal({
  open,
  market = [],
  canDrawDeck = true,
  showDeck = canDrawDeck,
  deckUnavailableReason,
  onSelect,
  onClose,
  title = 'Choisir une carte Action',
  titleId = 'action-draw-title',
  overlayClassName = '',
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    modalRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  return (
    <div className={`sj-modal-overlay ${overlayClassName} sj-fade-in`.trim()}>
      <section
        ref={modalRef}
        className="sj-action-draw-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sj-action-draw-modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
          </div>
          {onClose && (
            <button
              type="button"
              className="sj-action-hand-modal-close"
              aria-label="Fermer la pioche Action"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
        <div className="sj-action-hand-modal-scroll">
          <div className="sj-action-hand-modal-grid sj-action-draw-modal-grid" aria-label="Cartes Action disponibles">
            {showDeck && (
              <div className="sj-action-hand-modal-item">
                <button
                  type="button"
                  className="sj-action-deck"
                  disabled={!canDrawDeck}
                  title={!canDrawDeck ? deckUnavailableReason : undefined}
                  onClick={() => onSelect({ source: 'deck' })}
                >
                  <span>Face cachée</span>
                  <strong>Pioche Action</strong>
                </button>
              </div>
            )}
            {market.map((card, index) => (
              <div key={card.id} className="sj-action-hand-modal-item">
                <ActionTile
                  card={card}
                  disabled={Boolean(card.unavailableReason)}
                  onClick={() => onSelect({ source: 'market', marketIndex: index })}
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function ActionHandDock({ cards, onClick }) {
  const visibleCards = cards.slice(0, 7);

  if (cards.length === 0) return null;

  return (
    <button
      type="button"
      className={`sj-action-hand-dock sj-action-hand-dock-${visibleCards.length}`}
      aria-label={`Ouvrir vos ${cards.length} carte${cards.length > 1 ? 's' : ''} Action`}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {visibleCards.map((card, index) => (
        <span
          key={card.id}
          className={`sj-action-hand-tab sj-action-hand-tab-${index}`}
          aria-hidden="true"
        />
      ))}
      <strong className="sj-action-hand-count">{cards.length}</strong>
    </button>
  );
}
