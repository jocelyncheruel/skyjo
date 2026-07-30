import { useEffect, useRef, useState } from 'react';
import Card from './Card.jsx';
import { ActionTile } from './GameTablePieces.jsx';

export function ActionHandModal({
  open,
  cards,
  turnSerial,
  isMyTurn,
  turnStage,
  lastTurnLocked = false,
  onClose,
  onPlay,
  onDiscard,
}) {
  const modalRef = useRef(null);
  const scrollAreaRef = useRef(null);
  const [showScrollIndicator, setShowScrollIndicator] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    modalRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return undefined;

    const updateScrollIndicator = () => {
      const hasOverflow = scrollArea.scrollHeight > scrollArea.clientHeight + 2;
      const isAtBottom = scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - 8;
      setShowScrollIndicator(hasOverflow && !isAtBottom);
    };

    const animationFrame = window.requestAnimationFrame(updateScrollIndicator);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateScrollIndicator);
    resizeObserver?.observe(scrollArea);
    window.addEventListener('resize', updateScrollIndicator);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateScrollIndicator);
    };
  }, [open, cards.length]);

  if (!open) return null;

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-hand-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="action-hand-title">Cartes Action</h2>
          </div>
          <button
            type="button"
            className="sj-action-hand-modal-close"
            aria-label="Fermer votre main de cartes Action"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div
          ref={scrollAreaRef}
          className="sj-action-hand-modal-scroll"
          onScroll={(event) => {
            const scrollArea = event.currentTarget;
            const isAtBottom = scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - 8;
            setShowScrollIndicator(scrollArea.scrollHeight > scrollArea.clientHeight + 2 && !isAtBottom);
          }}
        >
          <div
            className={`sj-action-hand-modal-grid sj-action-hand-modal-grid-${Math.min(cards.length, 3)}`}
          >
            {cards.map((card) => {
              const playable = !card.preview
                && isMyTurn
                && turnStage === 'choose'
                && !lastTurnLocked
                && card.availableAt <= turnSerial
                && !card.unavailableReason;
              const discardable = !card.preview
                && isMyTurn
                && turnStage === 'choose'
                && !lastTurnLocked
                && card.availableAt <= turnSerial;

              return (
                <div key={card.id} className={`sj-action-hand-modal-item ${playable ? 'sj-action-hand-modal-item-playable' : ''}`}>
                  <ActionTile
                    card={card}
                    disabled={!playable}
                    onClick={() => onPlay(card.id)}
                  />
                  {!card.preview && (
                    <button
                      type="button"
                      className="sj-action-hand-discard"
                      disabled={!discardable}
                      onClick={() => onDiscard(card.id)}
                    >
                      Défausser
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {showScrollIndicator && (
          <div className="sj-action-hand-scroll-indicator" aria-hidden="true">
            <span>Voir les autres cartes</span>
            <strong>↓</strong>
          </div>
        )}
      </section>
    </div>
  );
}

export function PlayerActionCardsModal({
  open,
  player,
  cards = [],
  onClose,
  selectable = false,
  onSelect,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    modalRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || !player) return null;

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-action-player-cards-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-action-cards-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="player-action-cards-title">
              {selectable ? 'Choisir une carte Action chez ' : 'Cartes Action de '}
              <span className="sj-action-modal-title-name">{player.name}</span>
            </h2>
          </div>
          <button
            type="button"
            className="sj-action-hand-modal-close"
            aria-label="Fermer les cartes Action du joueur"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {cards.length > 0 ? (
          <div className="sj-action-hand-modal-scroll">
            <div
              className={`sj-action-hand-modal-grid sj-action-player-cards-grid sj-action-hand-modal-grid-${Math.min(cards.length, 3)}`}
            >
              {cards.map((card) => (
                <div key={card.id} className="sj-action-hand-modal-item">
                  <ActionTile
                    card={card}
                    interactive={selectable}
                    onClick={selectable ? () => onSelect(card.id) : undefined}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="sj-action-player-cards-empty">Aucune carte Action.</p>
        )}
      </section>
    </div>
  );
}

export function StealActionPlayerModal({
  open,
  players,
  playersAction,
  myId,
  onSelect,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  if (!open) return null;

  const targets = players
    .filter((player) => player.id !== myId && player.connected)
    .map((player) => ({
      player,
      cards: playersAction?.[player.id]?.actionCards || [],
    }));

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-action-steal-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="steal-action-player-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="steal-action-player-title">Choisir un joueur</h2>
          </div>
        </div>
        <div className="sj-action-steal-player-grid">
          {targets.map(({ player, cards }) => (
            <button
              key={player.id}
              type="button"
              className="sj-action-steal-player"
              disabled={cards.length === 0}
              onClick={() => onSelect(player.id)}
            >
              <strong>{player.name}</strong>
              <span>
                {cards.length} carte{cards.length > 1 ? 's' : ''} disponible{cards.length > 1 ? 's' : ''}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function StealActionCardModal({
  open,
  target,
  cards,
  canChangeTarget = true,
  onBack,
  onSelect,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  if (!open) return null;

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-action-steal-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="steal-action-card-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="steal-action-card-title">
              Choisir une carte à voler
              {target && (
                <>
                  {' '}chez <strong className="sj-action-modal-title-name">{target.name}</strong>
                </>
              )}
            </h2>
          </div>
          {canChangeTarget && (
            <button type="button" className="sj-btn" onClick={onBack}>
              Changer
            </button>
          )}
        </div>
        <div className="sj-action-hand-modal-scroll">
          <div
            className={`sj-action-hand-modal-grid sj-action-steal-card-grid sj-action-hand-modal-grid-${Math.min(cards.length, 3)}`}
          >
            {cards.map((card) => (
              <div key={card.id} className="sj-action-hand-modal-item">
                <ActionTile
                  card={card}
                  onClick={() => onSelect(card.id)}
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function DrawThreeActionModal({
  open,
  cards = [],
  canRevealHidden = true,
  onSelect,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  if (!open) return null;

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-action-draw-three-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="draw-three-action-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="draw-three-action-title">Piocher trois cartes</h2>
          </div>
        </div>
        <div className="sj-action-draw-three-grid">
          {cards.map((card, index) => (
            <button
              key={card.id}
              type="button"
              className="sj-action-draw-three-choice"
              aria-label={`Choisir la carte ${index + 1}`}
              onClick={() => onSelect(index)}
            >
              <Card value={card.value} kind={card.kind} faceUp size="pile" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="sj-btn sj-action-draw-three-none"
          disabled={!canRevealHidden}
          onClick={() => onSelect(null)}
        >
          {canRevealHidden ? 'Aucune' : 'Aucune carte cachée'}
        </button>
      </section>
    </div>
  );
}

export function PlayDiscardActionModal({
  open,
  cards = [],
  onSelect,
}) {
  const modalRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    return undefined;
  }, [open]);

  if (!open) return null;

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        ref={modalRef}
        className="sj-action-hand-modal sj-action-play-discard-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="play-discard-action-title"
        tabIndex={-1}
      >
        <div className="sj-action-hand-modal-head">
          <div>
            <h2 id="play-discard-action-title">Jouer une Action défaussée</h2>
          </div>
        </div>
        {cards.length > 0 ? (
          <div className="sj-action-hand-modal-scroll">
            <div
              className={`sj-action-hand-modal-grid sj-action-steal-card-grid sj-action-hand-modal-grid-${Math.min(cards.length, 3)}`}
            >
              {cards.map((card) => (
                <div key={card.id} className="sj-action-hand-modal-item">
                  <ActionTile
                    card={card}
                    onClick={() => onSelect(card.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="sj-action-play-discard-empty">Aucune carte Action défaussée.</p>
        )}
      </section>
    </div>
  );
}
