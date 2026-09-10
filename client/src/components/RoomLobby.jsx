import React, { useState } from 'react';
import {
  ChevronRight,
  Crown,
  Eye,
  Gamepad2,
  Globe2,
  LockKeyhole,
  QrCode,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { roomVariantLabel } from '../../../shared/roomVariants.js';
import { GameGuideButton } from './GameGuide.jsx';
import LobbyGameFormat from './LobbyGameFormat.jsx';

const MODE_OPTIONS = [
  { id: 'classic', label: 'Classique' },
  { id: 'action', label: 'Action' },
];

export default function RoomLobby({
  state,
  roomId = state?.roomId || '',
  myId = null,
  isCreator = false,
  isSpectator = false,
  copied = false,
  disconnectedPlayers = [],
  readOnly = false,
  onCopyCode = () => {},
  onShowQr = () => {},
  onRemovePlayer = () => {},
  onRemoveBot = () => {},
  onAddBot = () => {},
  onSetGameMode = () => {},
  onUpdateSettings = () => {},
  onOpenGuide = () => {},
  onOpenFriends = () => {},
  onStart = () => {},
}) {
  const [mobilePanel, setMobilePanel] = useState('players');
  const players = state?.players || [];
  const maxPlayers = state?.roomSettings?.maxPlayers || 8;
  const availableSeats = Math.max(0, maxPlayers - players.length);
  const lobbyReady = players.length >= 2 && disconnectedPlayers.length === 0;
  const lobbyStatus = players.length < 2
    ? 'En attente de joueurs'
    : disconnectedPlayers.length > 0 ? 'Reconnexion en attente' : 'Prêt à jouer';
  const hostControlsEnabled = isCreator && !readOnly;

  return (
    <section className="sj-room-lobby sj-fade-in" aria-labelledby="room-lobby-title">
      <header className="sj-room-lobby-header">
        <div className="sj-room-lobby-title">
          <span className="sj-room-lobby-eyebrow"><Gamepad2 aria-hidden="true" size={14} /> Lobby de partie</span>
          <h1 id="room-lobby-title">Préparez votre partie</h1>
          <p>Invitez vos amis, choisissez le mode et lancez dès que tout le monde est prêt.</p>
        </div>
        <div className="sj-room-lobby-invite">
          <span>Code de la salle</span>
          <div>
            <span className="sj-room-code-copy">
              <button
                type="button"
                className={`sj-room-lobby-code ${copied ? 'sj-room-copy-copied' : ''}`}
                aria-label={`Copier le code de salle ${roomId}`}
                onClick={onCopyCode}
              >
                {roomId}
              </button>
              {copied && (
                <span className="sj-copy-toast" role="status" aria-live="polite" aria-label="Lien d’invitation copié">✓</span>
              )}
            </span>
            <button
              type="button"
              className="sj-room-lobby-qr"
              aria-label="Afficher le QR code d’invitation"
              title="Afficher le QR code d’invitation"
              onClick={onShowQr}
            >
              <QrCode aria-hidden="true" size={20} />
            </button>
          </div>
          <small>Appuyez sur le code pour copier l’invitation</small>
        </div>
      </header>

      <div className="sj-room-lobby-summary" aria-label="Informations de la salle">
        <span className={state?.roomVisibility === 'public' ? 'is-public' : ''}>
          {state?.roomVisibility === 'public' ? <Globe2 aria-hidden="true" size={14} /> : <LockKeyhole aria-hidden="true" size={14} />}
          {state?.roomVisibility === 'public' ? 'Publique' : 'Privée'}
        </span>
        <span><Users aria-hidden="true" size={14} /> {players.length}/{maxPlayers} joueurs</span>
        <span><Sparkles aria-hidden="true" size={14} /> {roomVariantLabel(state?.roomSettings)}</span>
        {state?.roomSettings?.locked && <span><LockKeyhole aria-hidden="true" size={14} /> Verrouillée</span>}
        <span className={`sj-room-lobby-status ${lobbyReady ? 'is-ready' : ''}`}><i aria-hidden="true" /> {lobbyStatus}</span>
      </div>

      <div className={`sj-room-lobby-content is-${mobilePanel}-active`}>
        <section
          className={`sj-room-lobby-players ${mobilePanel !== 'players' ? 'is-mobile-collapsed' : 'is-mobile-expanded'}`}
          aria-labelledby="room-player-list-title"
          aria-expanded={mobilePanel === 'players'}
          onClick={() => setMobilePanel('players')}
        >
          <div className="sj-room-lobby-section-head">
            <div>
              <span className="sj-room-lobby-section-icon"><Users aria-hidden="true" size={18} /></span>
              <span><strong id="room-player-list-title">Joueurs</strong></span>
            </div>
            <strong>{players.length}<small>/{maxPlayers}</small></strong>
          </div>
          <ul className="sj-lobby-player-list">
            {players.map((player) => (
              <li
                key={player.id}
                className={`sj-pop-in ${player.id === myId ? 'is-current' : ''} ${!player.connected ? 'is-disconnected' : ''}`}
              >
                <span className="sj-lobby-player-copy">
                  <strong>{player.name}</strong>
                  <i
                    className="sj-lobby-player-presence"
                    role="img"
                    aria-label={player.connected ? 'Connecté' : 'Déconnecté'}
                    title={player.connected ? 'Connecté' : 'Déconnecté'}
                  />
                </span>
                <span className="sj-lobby-player-badges">
                  {player.id === state?.creatorId && <span title="Créateur"><Crown aria-hidden="true" size={14} /> <em>Hôte</em></span>}
                  {player.isBot && <span className="is-bot"><Sparkles aria-hidden="true" size={12} /> <em>Bot</em></span>}
                  {player.id === myId && <span className="is-you">Vous</span>}
                </span>
                {hostControlsEnabled && player.id !== myId && (
                  <button
                    type="button"
                    className="sj-lobby-player-remove"
                    aria-label={`Retirer ${player.name} de la salle`}
                    title={`Retirer ${player.name} de la salle`}
                    onClick={() => player.isBot ? onRemoveBot(player.id) : onRemovePlayer(player.id)}
                  >
                    <UserMinus aria-hidden="true" size={17} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="sj-room-lobby-seats">
            {availableSeats > 0
              ? `${availableSeats} place${availableSeats > 1 ? 's' : ''} encore disponible${availableSeats > 1 ? 's' : ''}`
              : 'La salle est complète'}
          </p>
          {hostControlsEnabled && availableSeats > 0 && (
            <button
              type="button"
              className="sj-room-lobby-add-bot"
              onClick={(event) => {
                event.stopPropagation();
                onAddBot();
              }}
            >
              <Sparkles aria-hidden="true" size={14} /> Ajouter un bot
            </button>
          )}
        </section>

        <aside
          className={`sj-room-lobby-settings ${mobilePanel !== 'settings' ? 'is-mobile-collapsed' : 'is-mobile-expanded'}`}
          aria-expanded={mobilePanel === 'settings'}
          onClick={() => setMobilePanel('settings')}
        >
          <section className="sj-room-lobby-mode" aria-labelledby="room-mode-title">
            <div className="sj-room-lobby-section-head">
              <div>
                <span className="sj-room-lobby-section-icon"><Sparkles aria-hidden="true" size={18} /></span>
                <span><strong id="room-mode-title">Mode de jeu</strong></span>
              </div>
            </div>
            <div
              className={`sj-room-visibility sj-room-lobby-mode-options ${state?.gameMode === 'action' ? 'is-action' : ''}`}
              role="group"
              aria-label="Mode de jeu"
            >
              {MODE_OPTIONS.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`sj-room-visibility-option ${state?.gameMode === mode.id ? 'sj-room-visibility-option-active' : ''}`}
                  disabled={!hostControlsEnabled}
                  aria-pressed={state?.gameMode === mode.id}
                  onClick={() => onSetGameMode(mode.id)}
                >
                  <strong>{mode.label}</strong>
                </button>
              ))}
            </div>
            <LobbyGameFormat
              roomSettings={state?.roomSettings}
              disabled={!hostControlsEnabled}
              onUpdate={onUpdateSettings}
            />
          </section>
          <div className="sj-room-lobby-role-note">
            {isSpectator ? <Eye aria-hidden="true" size={17} /> : isCreator ? <Crown aria-hidden="true" size={17} /> : <Users aria-hidden="true" size={17} />}
            <span>
              <strong>{isSpectator ? 'Mode spectateur' : isCreator ? 'Vous êtes l’hôte' : 'Vous êtes invité'}</strong>
              <small>{isSpectator ? 'Vous regardez la salle en lecture seule.' : isCreator ? 'Vous contrôlez le lancement et les paramètres.' : 'La partie sera lancée par l’hôte.'}</small>
            </span>
          </div>
        </aside>
      </div>

      <footer className="sj-room-lobby-footer">
        <div className="sj-room-lobby-actions">
          <GameGuideButton onClick={onOpenGuide} />
          {!isSpectator && availableSeats > 0 && <button type="button" className="sj-btn sj-room-lobby-friends" onClick={onOpenFriends}><UserPlus aria-hidden="true" size={16} /> Inviter des amis</button>}
          {hostControlsEnabled && (
            <button
              className="sj-btn sj-btn-primary sj-room-lobby-start"
              disabled={players.length < 2}
              onClick={onStart}
            >
              Lancer la partie <ChevronRight aria-hidden="true" size={18} />
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
