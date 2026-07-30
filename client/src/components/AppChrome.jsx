import Card from './Card.jsx';

export function GameToast({ message, tone = 'error' }) {
  if (!message) return null;

  return (
    <div className={`sj-game-toast sj-game-toast-${tone}`} role="status" aria-live="polite">
      <span className="sj-game-toast-icon" aria-hidden="true">{tone === 'info' ? 'i' : '!'}</span>
      <span className="sj-game-toast-text">{message}</span>
    </div>
  );
}

export function ConnectionBadge({ connected }) {
  return (
    <span
      className={`sj-connection-badge ${connected ? 'sj-connection-badge-ok' : ''}`}
      aria-label={connected ? 'Connecté au serveur' : 'Connexion au serveur'}
      title={connected ? 'Connecté au serveur' : 'Connexion au serveur'}
    />
  );
}

export function SkyjoLogo({ label = 'Skyjo', connectionBadge = null }) {
  return (
    <div className="sj-brand-logo" aria-label={label}>
      <span className="sj-brand-logo-mark" aria-hidden="true">
        <span className="sj-brand-logo-card sj-brand-logo-card-center">
          <Card value={0} kind="star" faceUp size="logo" />
        </span>
        <span className="sj-brand-logo-card sj-brand-logo-card-left">
          <Card value={12} kind="number" faceUp size="logo" />
        </span>
        <span className="sj-brand-logo-card sj-brand-logo-card-right">
          <Card value={0} kind="number" faceUp size="logo" />
        </span>
      </span>
      <span className="sj-brand-logo-copy">
        <strong>{label}</strong>
        {connectionBadge}
      </span>
    </div>
  );
}

export function RoomConnectionView({
  connected = false,
  error = '',
  errorSerial = 0,
  reconnectRoomId = '',
  title = '',
  description = '',
  status = '',
}) {
  const reconnecting = Boolean(reconnectRoomId);
  const resolvedTitle = title || (reconnecting ? 'Reconnexion' : 'Connexion à la salle');
  const resolvedDescription = description || (
    reconnecting ? `Retour dans la salle ${reconnectRoomId}...` : 'Ouverture de votre invitation...'
  );
  return (
    <div className="sj-lobby">
      <GameToast key={errorSerial} message={error} />
      <section className="sj-lobby-card sj-reconnect-card">
        <div className="sj-brand-mark">
          <SkyjoLogo connectionBadge={<ConnectionBadge connected={connected} />} />
        </div>
        <div className="sj-reconnect-spinner" aria-hidden="true" />
        <h1>{resolvedTitle}</h1>
        <p className="sj-lobby-copy">{resolvedDescription}</p>
        <p className="sj-reconnect-status">
          {status || (connected ? 'Accès à la salle' : 'Connexion au serveur')}
        </p>
      </section>
    </div>
  );
}
