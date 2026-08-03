import { useEffect, useRef, useState } from 'react';
import {
  Ban,
  Crown,
  Eye,
  Lock,
  MessageCircle,
  Settings,
  Unlock,
  UserMinus,
  X,
} from 'lucide-react';

const DEFAULT_SETTINGS = Object.freeze({
  maxPlayers: 8,
  locked: false,
  allowSpectators: true,
  chatEnabled: true,
});

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'select:not(:disabled)',
  'input:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function initialDraft(state) {
  return {
    ...DEFAULT_SETTINGS,
    ...(state.roomSettings || {}),
    roomVisibility: state.roomVisibility === 'public' ? 'public' : 'private',
  };
}

function SettingSwitch({ icon: Icon, label, checked, onChange }) {
  return (
    <button
      type="button"
      className={`sj-admin-switch ${checked ? 'sj-admin-switch-on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="sj-admin-switch-icon">
        <Icon aria-hidden="true" size={18} />
      </span>
      <span className="sj-admin-switch-copy">
        <strong>{label}</strong>
      </span>
      <span className="sj-admin-switch-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export function RoomAdministrationButton({ onClick }) {
  return (
    <button
      type="button"
      className="sj-room-admin-button"
      aria-label="Administrer la salle"
      title="Paramètres de la salle"
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <Settings aria-hidden="true" size={21} strokeWidth={2.4} />
    </button>
  );
}

export function RoomAdministrationModal({
  open,
  state,
  myId,
  onClose,
  onSave,
  onTransfer,
  onKick,
  onBan,
}) {
  const [draft, setDraft] = useState(() => initialDraft(state));
  const [pendingAction, setPendingAction] = useState(null);
  const modalRef = useRef(null);
  const liveMaxPlayers = state.roomSettings?.maxPlayers ?? DEFAULT_SETTINGS.maxPlayers;
  const liveLocked = state.roomSettings?.locked ?? DEFAULT_SETTINGS.locked;
  const liveAllowSpectators = state.roomSettings?.allowSpectators
    ?? DEFAULT_SETTINGS.allowSpectators;
  const liveChatEnabled = state.roomSettings?.chatEnabled ?? DEFAULT_SETTINGS.chatEnabled;
  const liveVisibility = state.roomVisibility === 'public' ? 'public' : 'private';

  useEffect(() => {
    if (!open) return;
    setDraft({
      maxPlayers: liveMaxPlayers,
      locked: liveLocked,
      allowSpectators: liveAllowSpectators,
      chatEnabled: liveChatEnabled,
      roomVisibility: liveVisibility,
    });
    setPendingAction(null);
  }, [
    liveAllowSpectators,
    liveChatEnabled,
    liveLocked,
    liveMaxPlayers,
    liveVisibility,
    open,
  ]);

  useEffect(() => {
    if (!open) return;
    setDraft((current) => ({
      ...current,
      maxPlayers: Math.max(current.maxPlayers, state.players.length),
    }));
  }, [open, state.players.length]);

  useEffect(() => {
    if (!open) return undefined;
    const modal = modalRef.current;
    const focusableElements = () => [...(modal?.querySelectorAll(FOCUSABLE_SELECTOR) || [])];
    const initialTarget = focusableElements()[0] || modal;
    initialTarget?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (pendingAction) setPendingAction(null);
      else onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open, pendingAction]);

  if (!open) return null;

  const currentPlayerCount = state.players.length;
  const otherPlayers = state.players.filter((player) => player.id !== myId);
  const pendingPlayer = pendingAction
    ? state.players.find((player) => player.id === pendingAction.playerId)
    : null;

  function updateDraft(key, value) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function confirmPendingAction() {
    if (!pendingAction || !pendingPlayer) return;
    if (pendingAction.type === 'transfer') onTransfer(pendingPlayer.id);
    if (pendingAction.type === 'kick') onKick(pendingPlayer.id);
    if (pendingAction.type === 'ban') onBan(pendingPlayer.id);
    setPendingAction(null);
    onClose();
  }

  const confirmation = pendingAction && pendingPlayer ? {
    transfer: {
      title: 'Transférer la propriété ?',
      message: `${pendingPlayer.name} deviendra propriétaire et pourra administrer la salle. Vous perdrez immédiatement ces droits.`,
      button: 'Transférer',
      tone: 'primary',
    },
    kick: {
      title: `Exclure ${pendingPlayer.name} ?`,
      message: 'Le joueur sera retiré de la salle, mais pourra la rejoindre de nouveau si elle reste accessible.',
      button: 'Exclure',
      tone: 'danger',
    },
    ban: {
      title: `Bannir ${pendingPlayer.name} ?`,
      message: 'Le joueur sera retiré et son compte ne pourra plus rejoindre ni regarder cette salle pendant toute sa durée de vie.',
      button: 'Bannir',
      tone: 'danger',
    },
  }[pendingAction.type] : null;

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (pendingAction) setPendingAction(null);
        else onClose();
      }}
    >
      {confirmation ? (
        <section
          ref={modalRef}
          className="sj-confirm-modal sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-admin-confirm-title"
          tabIndex={-1}
        >
          <h2 id="room-admin-confirm-title">{confirmation.title}</h2>
          <p>{confirmation.message}</p>
          <div className="sj-modal-actions">
            <button type="button" className="sj-btn" onClick={() => setPendingAction(null)}>
              Annuler
            </button>
            <button
              type="button"
              className={`sj-btn ${confirmation.tone === 'danger' ? 'sj-btn-danger' : 'sj-btn-primary'}`}
              onClick={confirmPendingAction}
            >
              {confirmation.button}
            </button>
          </div>
        </section>
      ) : (
        <section
          ref={modalRef}
          className="sj-room-admin-modal sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="room-admin-title"
          tabIndex={-1}
        >
          <header className="sj-room-admin-head">
            <div>
              <h2 id="room-admin-title">Administration de la salle</h2>
            </div>
            <button type="button" aria-label="Fermer" onClick={onClose}>
              <X aria-hidden="true" size={21} />
            </button>
          </header>

          <div className="sj-room-admin-body">
            <section className="sj-room-admin-section" aria-labelledby="room-access-title">
              <div className="sj-room-admin-section-head">
                <div>
                  <h3 id="room-access-title">Accès</h3>
                  <p>Enregistrez pour appliquer ces réglages.</p>
                </div>
              </div>

              <div
                className={`sj-room-visibility ${draft.roomVisibility === 'public' ? 'sj-room-visibility-public' : 'sj-room-visibility-private'}`}
                role="group"
                aria-label="Visibilité de la salle"
              >
                <button
                  type="button"
                  className={`sj-room-visibility-option ${draft.roomVisibility === 'private' ? 'sj-room-visibility-option-active' : ''}`}
                  onClick={() => updateDraft('roomVisibility', 'private')}
                >
                  <strong>Privée</strong>
                </button>
                <button
                  type="button"
                  className={`sj-room-visibility-option ${draft.roomVisibility === 'public' ? 'sj-room-visibility-option-active' : ''}`}
                  onClick={() => updateDraft('roomVisibility', 'public')}
                >
                  <strong>Publique</strong>
                </button>
              </div>

              <label className="sj-room-admin-capacity" htmlFor="room-max-players">
                <span>
                  <strong>Nombre maximal de joueurs</strong>
                  <small>{currentPlayerCount} joueur{currentPlayerCount > 1 ? 's' : ''} actuellement</small>
                </span>
                <select
                  id="room-max-players"
                  value={draft.maxPlayers}
                  onChange={(event) => updateDraft('maxPlayers', Number(event.target.value))}
                >
                  {Array.from({ length: 7 }, (_, index) => index + 2).map((value) => (
                    <option key={value} value={value} disabled={value < currentPlayerCount}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>

              <SettingSwitch
                icon={draft.locked ? Lock : Unlock}
                label="Verrouiller la salle"
                checked={draft.locked}
                onChange={(value) => updateDraft('locked', value)}
              />
              <SettingSwitch
                icon={Eye}
                label="Autoriser les spectateurs"
                checked={draft.allowSpectators}
                onChange={(value) => updateDraft('allowSpectators', value)}
              />
              <SettingSwitch
                icon={MessageCircle}
                label="Activer le chat"
                checked={draft.chatEnabled}
                onChange={(value) => updateDraft('chatEnabled', value)}
              />

              <button
                type="button"
                className="sj-btn sj-btn-primary sj-room-admin-save"
                onClick={() => {
                  onSave(draft);
                  onClose();
                }}
              >
                Enregistrer les paramètres
              </button>
            </section>

            <section className="sj-room-admin-section" aria-labelledby="room-members-title">
              <div className="sj-room-admin-section-head">
                <div>
                  <h3 id="room-members-title">Joueurs</h3>
                  <p>Transférez la propriété, excluez ou bannissez un membre.</p>
                </div>
              </div>
              {otherPlayers.length === 0 ? (
                <p className="sj-room-admin-empty">Aucun autre joueur dans la salle.</p>
              ) : (
                <ul className="sj-room-admin-player-list">
                  {otherPlayers.map((player) => (
                    <li key={player.id}>
                      <span className={`sj-turn-dot ${player.connected ? 'sj-turn-dot-on' : ''}`} />
                      <strong>{player.name}</strong>
                      <div className="sj-room-admin-player-actions">
                        <button
                          type="button"
                          aria-label={`Transférer la propriété à ${player.name}`}
                          title="Transférer la propriété"
                          onClick={() => setPendingAction({ type: 'transfer', playerId: player.id })}
                        >
                          <Crown aria-hidden="true" size={17} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Exclure ${player.name}`}
                          title="Exclure"
                          onClick={() => setPendingAction({ type: 'kick', playerId: player.id })}
                        >
                          <UserMinus aria-hidden="true" size={17} />
                        </button>
                        <button
                          type="button"
                          className="sj-room-admin-player-ban"
                          aria-label={`Bannir ${player.name}`}
                          title="Bannir pour la durée de la salle"
                          onClick={() => setPendingAction({ type: 'ban', playerId: player.id })}
                        >
                          <Ban aria-hidden="true" size={17} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </section>
      )}
    </div>
  );
}
