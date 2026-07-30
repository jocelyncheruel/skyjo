import { useEffect, useState } from 'react';
import Card from './Card.jsx';

const BOARD_COLUMNS = 4;

export function DefensePromptModal({ prompt, players, myId, onResolve }) {
  const [secondsLeft, setSecondsLeft] = useState(5);
  const defender = players.find((player) => player.id === prompt?.targetId);
  const attacker = players.find((player) => player.id === prompt?.actorId);
  const canRespond = !!prompt?.canRespond && prompt.targetId === myId;

  useEffect(() => {
    if (!prompt) return undefined;

    const update = () => {
      setSecondsLeft(Math.max(0, Math.ceil((prompt.expiresAt - Date.now()) / 1000)));
    };

    update();
    const timer = window.setInterval(update, 150);
    return () => window.clearInterval(timer);
  }, [prompt]);

  if (!prompt) return null;

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        className="sj-confirm-modal sj-defense-prompt-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="defense-prompt-title"
      >
        {canRespond ? (
          <>
            <h2 id="defense-prompt-title">Utiliser Défense ?</h2>
            <p>
              {attacker?.name || 'Un joueur'} joue une carte Action contre vous. Vous pouvez la bloquer.
            </p>
          </>
        ) : (
          <>
            <h2 id="defense-prompt-title">Défense possible</h2>
            <p>
              {defender?.name || prompt.targetName || 'Ce joueur'} possède une carte Défense. Attente de sa réponse.
            </p>
          </>
        )}
        <div className="sj-defense-countdown" aria-live="polite">
          <strong>{secondsLeft}</strong>
          <span>secondes</span>
        </div>
        {canRespond && (
          <div className="sj-modal-actions">
            <button type="button" className="sj-btn sj-btn-primary" onClick={() => onResolve(true)}>
              Utiliser Défense
            </button>
            <button type="button" className="sj-btn" onClick={() => onResolve(false)}>
              Ne pas utiliser
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export function StarGroupChoiceModal({ choice, onResolve }) {
  if (!choice) return null;

  const groupLabel = choice.groupType === 'row' ? 'ligne' : 'colonne';

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        className="sj-confirm-modal sj-star-group-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="star-group-title"
      >
        <h2 id="star-group-title">
          Supprimer cette {groupLabel} ?
        </h2>
        <div className={`sj-star-group-snapshot sj-star-group-${choice.groupType}`} aria-label={`Snapshot de la ${groupLabel}`}>
          {choice.cards.map((card) => (
            <Card
              key={card.slotIndex}
              value={card.value}
              kind={card.kind}
              faceUp
              size="pile"
            />
          ))}
        </div>
        <div className="sj-modal-actions">
          <button type="button" className="sj-btn" onClick={() => onResolve(false)}>
            Conserver
          </button>
          <button type="button" className="sj-btn sj-btn-primary" onClick={() => onResolve(true)}>
            Supprimer
          </button>
        </div>
      </section>
    </div>
  );
}

export function PeekLineChoiceModal({ choice, onResolve, onBack }) {
  if (!choice?.options?.length) return null;

  const rowOption = choice.options.find((option) => option.groupType === 'row');
  const columnOption = choice.options.find((option) => option.groupType === 'column');
  const rowIndexes = new Set(rowOption?.indexes || []);
  const columnIndexes = new Set(columnOption?.indexes || []);
  const selectedRow = Math.floor(choice.firstSlotIndex / BOARD_COLUMNS) + 1;
  const selectedColumn = (choice.firstSlotIndex % BOARD_COLUMNS) + 1;

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        className="sj-confirm-modal sj-peek-choice-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="peek-choice-title"
      >
        <h2 id="peek-choice-title">Choisissez une direction</h2>
        <p>
          {choice.isOwnBoard
            ? 'Voici votre plateau.'
            : `Voici le plateau de ${choice.targetPlayerName}.`}{' '}
          La carte dorée est votre point de départ.
        </p>
        <div className="sj-peek-board-snapshot" aria-hidden="true">
          <div className="sj-grid sj-peek-board-grid">
            {choice.boardCards.map((card) => {
              const inRow = rowIndexes.has(card.slotIndex);
              const inColumn = columnIndexes.has(card.slotIndex);
              const selected = card.slotIndex === choice.firstSlotIndex;
              return (
                <Card
                  key={card.slotIndex}
                  value={card.value}
                  kind={card.kind}
                  faceUp={card.faceUp && !card.removed}
                  removed={card.removed}
                  selected={selected}
                  dim={!inRow && !inColumn}
                  size="table"
                />
              );
            })}
            {rowOption && (
              <span
                className={`sj-peek-group-outline sj-peek-row-outline sj-peek-row-outline-${selectedRow}`}
              />
            )}
            {columnOption && (
              <span
                className={`sj-peek-group-outline sj-peek-column-outline sj-peek-column-outline-${selectedColumn}`}
              />
            )}
          </div>
        </div>
        <div className="sj-peek-direction-actions">
          {choice.options.map((option) => {
            const groupLabel = option.groupType === 'row' ? 'Regarder la ligne' : 'Regarder la colonne';
            const hiddenLabel = `${option.hiddenCount} cachée${option.hiddenCount > 1 ? 's' : ''}`;
            return (
              <button
                key={option.groupType}
                type="button"
                className={`sj-peek-direction sj-peek-direction-${option.groupType}`}
                onClick={() => onResolve(option.groupType)}
              >
                <span aria-hidden="true" />
                <strong>{groupLabel}</strong>
                <small>{hiddenLabel}</small>
              </button>
            );
          })}
        </div>
        <div className="sj-modal-actions">
          <button type="button" className="sj-btn" onClick={onBack}>
            Choisir une autre carte
          </button>
        </div>
      </section>
    </div>
  );
}

export function PeekResultModal({ peek, targetPlayer, isOwnBoard, onClose }) {
  if (!peek || !targetPlayer) return null;

  const peekCardsByIndex = new Map(peek.cards.map((card) => [card.slotIndex, card]));
  const viewedIndexes = new Set(peek.indexes);
  const newlyViewedIndexes = new Set(peek.cards
    .filter((card) => !card.removed && !card.wasFaceUp)
    .map((card) => card.slotIndex));
  const referenceIndex = peek.indexes[0];
  const selectedRow = Math.floor(referenceIndex / BOARD_COLUMNS) + 1;
  const selectedColumn = (referenceIndex % BOARD_COLUMNS) + 1;
  const viewedCardCount = newlyViewedIndexes.size;
  const viewedCardsLabel = `${viewedCardCount > 1 ? 'Les cartes regardées sont entourées' : 'La carte regardée est entourée'} en doré.`;
  const groupLabel = peek.groupType === 'row' ? 'Ligne' : peek.groupType === 'column' ? 'Colonne' : 'Carte';
  const title = isOwnBoard
    ? `${groupLabel} regardée sur votre plateau`
    : `${groupLabel} regardée chez ${targetPlayer.name}`;

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="sj-confirm-modal sj-peek-result-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="peek-result-title"
      >
        <div className="sj-peek-result-head">
          <h2 id="peek-result-title">{title}</h2>
          <button
            type="button"
            className="sj-action-hand-modal-close"
            aria-label="Fermer l’aperçu des cartes regardées"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p>
          {isOwnBoard
            ? 'Voici votre plateau.'
            : `Voici le plateau de ${targetPlayer.name}.`}{' '}
          {viewedCardsLabel}
        </p>
        <div
          className="sj-peek-board-snapshot"
          role="img"
          aria-label={isOwnBoard ? 'Aperçu privé de votre plateau' : `Aperçu privé du plateau de ${targetPlayer.name}`}
        >
          <div className="sj-grid sj-peek-board-grid">
            {targetPlayer.board.map((slot, slotIndex) => {
              const privateCard = peekCardsByIndex.get(slotIndex);
              const removed = !!slot.removed;
              return (
                <Card
                  key={slotIndex}
                  value={privateCard?.value ?? slot.value}
                  kind={privateCard?.kind || slot.kind || 'number'}
                  faceUp={!removed && (!!slot.faceUp || (!!privateCard && !privateCard.removed))}
                  removed={removed}
                  selected={newlyViewedIndexes.has(slotIndex)}
                  dim={!viewedIndexes.has(slotIndex)}
                  size="table"
                />
              );
            })}
            {peek.groupType === 'row' && (
              <span
                className={`sj-peek-group-outline sj-peek-row-outline sj-peek-row-outline-${selectedRow}`}
                aria-hidden="true"
              />
            )}
            {peek.groupType === 'column' && (
              <span
                className={`sj-peek-group-outline sj-peek-column-outline sj-peek-column-outline-${selectedColumn}`}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
