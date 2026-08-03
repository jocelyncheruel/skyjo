import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, LogIn, QrCode, X } from 'lucide-react';
import Card from './Card.jsx';
import CardMotionLayer from './CardMotionLayer.jsx';
import { GameGuideButton } from './GameGuide.jsx';
import { PileButton } from './GameTablePieces.jsx';
import PlayerBoard from './PlayerBoard.jsx';
import { ACTION_ART_URLS, ACTION_LABELS } from '../gameGuide.js';
import { calculateAdaptiveBoardLayout, layoutClassNames } from '../responsiveLayout.js';
import { roomVariantLabel } from '../../../shared/roomVariants.js';

function PreviewBoard({
  player,
  active = false,
  primary = false,
  actionCardCount = null,
  actionPopup = null,
}) {
  return (
    <div className="sj-public-preview-board-slot">
      <PlayerBoard
        player={player}
        isMe={primary}
        isActive={active}
        size="table"
        selectableSlots={[]}
        selectedSlots={[]}
        actionCardCount={actionCardCount}
        actionPopup={actionPopup}
      />
    </div>
  );
}

function LobbyPreview({ room, viewport, scale }) {
  const players = room?.players || [];

  return (
    <div className="sj-public-preview-stage-clip">
      <div
        className="sj-app-shell sj-lobby-room sj-public-preview-stage"
        inert=""
        aria-hidden="true"
        style={{
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
          transform: `scale(${scale})`,
        }}
      >
        <section className="sj-lobby-card sj-fade-in">
          <div className="sj-room-head">
            <span>Salle</span>
            <span className="sj-room-copy-wrap">
              <span className="sj-room-code-copy">
                <button type="button" className="sj-room-copy">{room?.roomId}</button>
              </span>
              <button
                type="button"
                className="sj-room-qr-trigger"
                aria-label="Afficher le QR code d’invitation"
                title="Afficher le QR code d’invitation"
              >
                <QrCode aria-hidden="true" size={20} />
              </button>
            </span>
          </div>
          <p className={`sj-room-visibility-badge ${room?.roomVisibility === 'public' ? 'sj-room-visibility-badge-public' : ''}`}>
            {room?.roomVisibility === 'public' ? 'Salle publique' : 'Salle privée'}
          </p>
          <ul className="sj-player-list">
            {players.map((player) => (
              <li
                key={player.id}
                className={`sj-pop-in ${!player.connected ? 'sj-player-list-disconnected' : ''}`}
              >
                <span className={`sj-turn-dot ${player.connected ? 'sj-turn-dot-on' : ''}`} />
                <span className="sj-player-list-name">{player.name}</span>
              </li>
            ))}
          </ul>
          <section className="sj-mode-picker" aria-label="Mode de jeu">
            <div className="sj-mode-picker-head">
              <strong>Mode de jeu</strong>
            </div>
            <div className="sj-mode-options">
              {[
                { id: 'classic', label: 'Classique' },
                { id: 'action', label: 'Action' },
              ].map((mode) => (
                <div key={mode.id} className={`sj-mode-option ${room?.gameMode === mode.id ? 'sj-mode-option-active' : ''}`}>
                  <button
                    type="button"
                    disabled
                    aria-pressed={room?.gameMode === mode.id}
                  >
                    <strong>{mode.label}</strong>
                  </button>
                </div>
              ))}
            </div>
          </section>
          <div className="sj-lobby-start-actions">
            <GameGuideButton onClick={() => {}} />
          </div>
          <p className="sj-hint">Vous regardez la salle en lecture seule.</p>
        </section>
      </div>
    </div>
  );
}

function GamePreview({ room, viewport, scale, previewRootRef }) {
  const stageRef = useRef(null);
  const players = room?.players || [];
  const activeId = room?.currentPlayerId || room?.order?.[room?.turnIndex] || players[0]?.id;
  const activePlayer = players.find((player) => player.id === activeId) || players[0];
  const opponents = players.filter((player) => player.id !== activePlayer?.id);
  const isActionMode = room?.gameMode === 'action';
  const actionPopupFor = (playerId) => {
    const played = room?.lastPlayedAction;
    if (!played?.id || played.playerId !== playerId) return null;
    const type = played.card?.type;
    return {
      id: played.id,
      title: ACTION_LABELS[type] || 'Carte Action',
      artType: Object.hasOwn(ACTION_ART_URLS, type) ? type : 'drawThree',
    };
  };
  const shellPadding = Math.max(8, Math.min(16, viewport.height * 0.015));
  const boardWidth = Math.max(1, viewport.width - shellPadding * 2);
  const boardHeight = Math.max(1, viewport.height - shellPadding * 2);
  const layout = calculateAdaptiveBoardLayout({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    playerCount: players.length,
    boardAreaWidth: boardWidth,
    boardAreaHeight: boardHeight,
    opponentsWidth: boardWidth,
    playColumnHeight: boardHeight * 0.5,
    meWrapWidth: boardWidth,
    meWrapHeight: boardHeight * 0.48,
    centerHeight: Math.min(viewport.width * 0.18, viewport.height * 0.18),
    actionPanelWidth: Math.min(180, viewport.width * 0.22),
    playGap: 8,
    actionMode: isActionMode,
  });

  return (
    <div className="sj-public-preview-stage-clip">
      <div
        ref={stageRef}
        className={`sj-app-shell sj-public-preview-stage sj-public-preview-game-stage ${players.length === 2 ? 'sj-two-player-game' : ''} ${isActionMode ? 'sj-action-game' : ''} ${layoutClassNames(layout).join(' ')}`}
        inert=""
        aria-hidden="true"
        style={{
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
          transform: `scale(${scale})`,
        }}
      >
        <main className="sj-board-area">
          {opponents.length > 0 && (
            <section className={`sj-player-zone sj-opponents sj-opponents-count-${Math.min(opponents.length, 4)}`}>
              {opponents.map((player) => (
                <PreviewBoard
                  key={player.id}
                  player={player}
                  active={player.id === activeId}
                  actionCardCount={isActionMode
                    ? room.actionCardCounts?.[player.id] || 0
                    : null}
                  actionPopup={actionPopupFor(player.id)}
                />
              ))}
            </section>
          )}
          <section className="sj-center sj-piles-zone" aria-hidden="true">
            <div className="sj-action-panel">
              <div className="sj-pile-group">
                <PileButton
                  ariaLabel="Pioche"
                  enabled={false}
                  active={false}
                  drawnCard={room?.drawnCard?.from === 'deck' ? room.drawnCard.card : null}
                  drawnFrom="deck"
                >
                  <Card
                    faceUp={false}
                    size="pile"
                    motionAnchor="pile:deck"
                    suppressRevealAnimation
                  />
                </PileButton>
                <PileButton
                  ariaLabel="Défausse"
                  enabled={false}
                  active={false}
                  drawnCard={room?.drawnCard?.from === 'discard' ? room.drawnCard.card : null}
                  drawnFrom="discard"
                >
                  {room?.discardTop ? (
                    <Card
                      value={room.discardTop.value}
                      kind={room.discardTop.kind}
                      faceUp
                      size="pile"
                      motionAnchor="pile:discard"
                      suppressRevealAnimation
                    />
                  ) : (
                    <Card
                      removed
                      size="pile"
                      motionAnchor="pile:discard"
                      suppressRevealAnimation
                    />
                  )}
                </PileButton>
              </div>
            </div>
          </section>
          <section className="sj-play-column">
            {activePlayer && (
              <div className="sj-player-zone sj-me-wrap">
                <PreviewBoard
                  player={activePlayer}
                  active
                  primary
                  actionCardCount={isActionMode
                    ? room.actionCardCounts?.[activePlayer.id] || 0
                    : null}
                  actionPopup={actionPopupFor(activePlayer.id)}
                />
              </div>
            )}
          </section>
        </main>
      </div>
      <CardMotionLayer
        state={room}
        enabled={scale > 0}
        anchorRootRef={stageRef}
        coordinateRootRef={previewRootRef}
        portalRootRef={previewRootRef}
        layerClassName="sj-public-preview-motion-layer"
      />
    </div>
  );
}

export default function PublicRoomPreviewModal({
  roomMetadata,
  preview,
  loading,
  error,
  connected,
  onClose,
  onJoin,
  onWatch,
}) {
  const modalRef = useRef(null);
  const previewViewportRef = useRef(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth || 1,
    height: window.innerHeight || 1,
  }));
  const [previewWidth, setPreviewWidth] = useState(1);

  useEffect(() => {
    modalRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    const handleResize = () => setViewport({
      width: window.visualViewport?.width || window.innerWidth || 1,
      height: window.visualViewport?.height || window.innerHeight || 1,
    });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  useEffect(() => {
    const element = previewViewportRef.current;
    if (!element) return undefined;
    const updatePreviewWidth = () => setPreviewWidth(element.clientWidth || 1);
    updatePreviewWidth();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updatePreviewWidth);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  const ratio = useMemo(
    () => viewport.width / viewport.height,
    [viewport],
  );
  const previewPhase = preview?.phase || roomMetadata.phase;
  const previewGameMode = preview?.gameMode || roomMetadata.gameMode;
  const previewPlayerCount = preview?.players?.length ?? roomMetadata.playerCount;
  const previewMaxPlayers = preview?.roomSettings?.maxPlayers ?? roomMetadata.maxPlayers;
  const roomLocked = preview?.roomSettings?.locked ?? roomMetadata.locked ?? false;
  const spectatorsAllowed = preview?.roomSettings?.allowSpectators
    ?? roomMetadata.allowSpectators
    ?? true;
  const variantSettings = preview?.roomSettings || roomMetadata;
  const spectatorCount = Number.isInteger(preview?.spectatorCount)
    ? Math.max(0, preview.spectatorCount)
    : Number.isInteger(roomMetadata.spectatorCount)
      ? Math.max(0, roomMetadata.spectatorCount)
      : 0;
  const canJoin = previewPhase === 'lobby'
    && !roomLocked
    && previewPlayerCount < previewMaxPlayers;

  return (
    <div
      className="sj-modal-overlay sj-public-preview-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-public-preview-modal sj-pop-in"
        style={{ '--sj-public-preview-ratio': ratio }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-room-preview-title"
        tabIndex={-1}
      >
        <header className="sj-public-preview-head">
          <div>
            <span>{previewPhase === 'lobby' ? 'Salle d’attente' : 'Partie en cours'}</span>
            <h2 id="public-room-preview-title">
              {previewGameMode === 'action' ? 'Skyjo Action' : 'Skyjo classique'}
            </h2>
          </div>
          <button type="button" aria-label="Fermer l’aperçu" title="Fermer" onClick={onClose}>
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <div
          ref={previewViewportRef}
          className="sj-public-preview-viewport"
          style={{
            aspectRatio: String(ratio),
          }}
          aria-live="polite"
        >
          {loading && !preview && <span className="sj-public-preview-status">Chargement de la partie…</span>}
          {error && !preview && <span className="sj-public-preview-status">{error}</span>}
          {preview?.phase === 'lobby' && (
            <LobbyPreview
              room={preview}
              viewport={viewport}
              scale={previewWidth / viewport.width}
            />
          )}
          {preview && preview.phase !== 'lobby' && (
            <GamePreview
              room={preview}
              viewport={viewport}
              scale={previewWidth / viewport.width}
              previewRootRef={previewViewportRef}
            />
          )}
        </div>

        <p className="sj-public-preview-owner">
          Créée par {roomMetadata.creatorName || 'un joueur'}
          {' · '}
          {previewPlayerCount}/{previewMaxPlayers} joueurs
          {' · '}
          {roomVariantLabel(variantSettings)}
          {roomLocked ? ' · Salle verrouillée' : ''}
          {!spectatorsAllowed ? ' · Spectateurs interdits' : ''}
        </p>

        <div className="sj-public-preview-actions">
          {canJoin && (
            <button type="button" className="sj-btn" disabled={!connected || loading} onClick={onJoin}>
              <LogIn aria-hidden="true" size={17} />
              Rejoindre
            </button>
          )}
          <button
            type="button"
            className="sj-btn sj-btn-primary"
            disabled={!connected || loading || !spectatorsAllowed}
            onClick={onWatch}
          >
            <Eye aria-hidden="true" size={17} />
            {spectatorsAllowed
              ? `Regarder${spectatorCount > 0 ? ` · ${spectatorCount}` : ''}`
              : 'Spectateurs interdits'}
          </button>
        </div>
      </section>
    </div>
  );
}
