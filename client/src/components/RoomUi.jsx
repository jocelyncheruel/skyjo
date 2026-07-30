import { useEffect, useRef, useState } from 'react';
import { Eye, LogOut, MessageCircle, Send, X } from 'lucide-react';

const CHAT_GROUP_WINDOW_MS = 2 * 60 * 1000;

export function LeaveRoomModal({ open, onCancel, onConfirm, isSpectator = false }) {
  const cancelButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    cancelButtonRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="sj-confirm-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-room-title"
        aria-describedby="leave-room-description"
      >
        <h2 id="leave-room-title">Quitter la salle ?</h2>
        <p id="leave-room-description">
          {isSpectator
            ? 'Vous arrêterez de regarder cette salle.'
            : 'Vous serez retiré de la partie. Cette action ne peut pas être annulée.'}
        </p>
        <div className="sj-modal-actions">
          <button ref={cancelButtonRef} type="button" className="sj-btn" onClick={onCancel}>
            Annuler
          </button>
          <button type="button" className="sj-btn sj-btn-danger" onClick={onConfirm}>
            Quitter
          </button>
        </div>
      </section>
    </div>
  );
}

export function LeaveRoomButton({ onClick }) {
  return (
    <button
      type="button"
      className="sj-exit-button"
      aria-label="Quitter la salle"
      title="Quitter la salle"
      onClick={onClick}
    >
      <LogOut aria-hidden="true" size={21} strokeWidth={2.4} />
    </button>
  );
}

export function DisconnectedPlayersModal({ open, players, onCancel, onConfirm }) {
  const cancelButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    cancelButtonRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open || players.length === 0) return null;

  const multiplePlayers = players.length > 1;
  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="sj-confirm-modal sj-disconnected-players-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="disconnected-players-title"
        aria-describedby="disconnected-players-description"
      >
        <h2 id="disconnected-players-title">
          {multiplePlayers ? 'Des joueurs sont déconnectés' : 'Un joueur est déconnecté'}
        </h2>
        <p id="disconnected-players-description">
          La partie ne peut démarrer que lorsque tous les sièges sont connectés. Vous pouvez attendre leur retour ou les retirer de la salle.
        </p>
        <ul className="sj-disconnected-players-list">
          {players.map((player) => <li key={player.id}>{player.name}</li>)}
        </ul>
        <div className="sj-modal-actions">
          <button ref={cancelButtonRef} type="button" className="sj-btn" onClick={onCancel}>
            Attendre
          </button>
          <button type="button" className="sj-btn sj-btn-danger" onClick={onConfirm}>
            {multiplePlayers ? 'Retirer les joueurs' : 'Retirer le joueur'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ChatButton({ unreadCount = 0, onClick }) {
  return (
    <button
      type="button"
      className={`sj-chat-button ${unreadCount > 0 ? 'sj-chat-button-unread' : ''}`}
      aria-label={unreadCount > 0 ? `Ouvrir le chat, ${unreadCount} nouveau message` : 'Ouvrir le chat'}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <MessageCircle aria-hidden="true" size={21} strokeWidth={2.4} />
      <span>Chat</span>
      {unreadCount > 0 && (
        <strong className="sj-chat-badge" aria-hidden="true">
          {unreadCount > 9 ? '9+' : unreadCount}
        </strong>
      )}
    </button>
  );
}

export function SpectatorBadge({ connected = true }) {
  return (
    <div
      className={`sj-spectator-badge ${connected ? 'sj-spectator-badge-live' : 'sj-spectator-badge-reconnecting'}`}
      role="status"
      aria-live="polite"
    >
      <span className="sj-spectator-live-dot" aria-hidden="true" />
      <span>{connected ? 'En direct' : 'Reconnexion…'}</span>
    </div>
  );
}

function chatMessageTime(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function ChatModal({
  open,
  messages = [],
  hasMore = false,
  myId,
  onClose,
  onSend,
  onLoadMore,
  readOnly = false,
}) {
  const [draft, setDraft] = useState('');
  const modalRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    modalRef.current?.focus({ preventScroll: true });
    if (!readOnly) {
      window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, readOnly]);

  useEffect(() => {
    if (!open) return;
    const scrollArea = scrollRef.current;
    if (!scrollArea) return;
    window.requestAnimationFrame(() => {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    });
  }, [open, messages.length]);

  if (!open) return null;

  function handleSubmit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div
      className="sj-modal-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-chat-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-title"
        tabIndex={-1}
      >
        <header className="sj-chat-head">
          <div>
            <span>Discussion de la salle</span>
            <h2 id="chat-title">Chat</h2>
          </div>
          <button
            type="button"
            className="sj-chat-close"
            aria-label="Fermer le chat"
            onClick={onClose}
          >
            <X aria-hidden="true" size={22} strokeWidth={2.4} />
          </button>
        </header>

        <div ref={scrollRef} className="sj-chat-messages" aria-live="polite">
          {hasMore && (
            <button type="button" className="sj-chat-load-more" onClick={onLoadMore}>
              Charger les 80 messages précédents
            </button>
          )}
          {messages.length === 0 ? (
            <div className="sj-chat-empty">
              <strong>Aucun message</strong>
              <span>
                {readOnly
                  ? 'Les messages des joueurs apparaîtront ici.'
                  : 'Écrivez le premier message de cette partie.'}
              </span>
            </div>
          ) : (
            messages.map((message, index) => {
              const system = message.type === 'system';
              const mine = message.playerId === myId;
              const previousMessage = messages[index - 1];
              const grouped = !system
                && previousMessage?.type !== 'system'
                && previousMessage?.playerId === message.playerId
                && Math.abs((message.t || 0) - (previousMessage.t || 0)) <= CHAT_GROUP_WINDOW_MS;
              if (system) {
                return (
                  <article key={message.id} className="sj-chat-system-message">
                    <span>{message.text}</span>
                    <time dateTime={new Date(message.t).toISOString()}>
                      {chatMessageTime(message.t)}
                    </time>
                  </article>
                );
              }
              return (
                <article
                  key={message.id}
                  className={`sj-chat-message ${mine ? 'sj-chat-message-me' : ''} ${grouped ? 'sj-chat-message-grouped' : ''}`}
                >
                  {!mine && !grouped && (
                    <span className="sj-chat-avatar" aria-hidden="true">
                      {(message.playerName || '?').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div className="sj-chat-bubble">
                    {!grouped && (
                      <div className="sj-chat-meta">
                        <strong>{mine ? 'Vous' : message.playerName}</strong>
                        <time dateTime={new Date(message.t).toISOString()}>
                          {chatMessageTime(message.t)}
                        </time>
                      </div>
                    )}
                    <p>{message.text}</p>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {readOnly ? (
          <p className="sj-chat-read-only">
            <Eye aria-hidden="true" size={15} />
            Chat en lecture seule
          </p>
        ) : (
          <form className="sj-chat-form" onSubmit={handleSubmit}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value.slice(0, 280))}
              placeholder="Message..."
              maxLength={280}
              autoComplete="off"
            />
            <button
              type="submit"
              className="sj-chat-send"
              aria-label="Envoyer le message"
              disabled={!draft.trim()}
            >
              <Send aria-hidden="true" size={19} strokeWidth={2.5} />
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

export function countUnreadChatMessages(messages, lastSeenId, myId) {
  if (!messages.length) return 0;
  const startIndex = lastSeenId
    ? messages.findIndex((message) => message.id === lastSeenId) + 1
    : 0;
  return messages
    .slice(Math.max(0, startIndex))
    .filter((message) => message.playerId !== myId)
    .length;
}
