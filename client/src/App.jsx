import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { LogOut, MessageCircle, Send, Trash2, X } from 'lucide-react';
import Card from './components/Card.jsx';
import CardMotionLayer from './components/CardMotionLayer.jsx';
import { GameGuideButton, GameGuideModal, GameTutorial } from './components/GameGuide.jsx';
import {
  ActionDrawModal,
  ActionHandDock,
  ActionTile,
  PileButton,
} from './components/GameTablePieces.jsx';
import PlayerBoard from './components/PlayerBoard.jsx';
import ProfileModal, { ProfileButton } from './ProfileModal.jsx';
import { AuthLoadingView, AuthView, ConsentGate, LegalPage, ResetPasswordView } from './Auth.jsx';
import { useAuth } from './authContext.js';
import { apiFetch, AUTH_REMEMBER_KEY, SERVER_URL } from './apiClient.js';
import { connectErrorUserMessage } from './connectionError.js';
import { extractRoomCodeFromInvite, ROOM_CODE_PATTERN } from './inviteCode.js';
import { useAdaptiveBoardSizing } from './useAdaptiveBoardSizing.js';
import {
  ACTION_ART_URLS,
  ACTION_LABELS,
  completeGameTutorial,
  hasCompletedGameTutorial,
} from './gameGuide.js';
import {
  SOCKET_EVENTS,
  SOCKET_PROTOCOL_VERSION,
  socketClientPayload,
} from '../../shared/socketProtocol.js';

const AUTO_RECONNECT_TIMEOUT_MS = 5000;

function emitSocket(socket, eventName, payload) {
  if (!socket) return;
  const normalizedPayload = socketClientPayload(eventName, payload);
  if (normalizedPayload === undefined) socket.emit(eventName);
  else socket.emit(eventName, normalizedPayload);
}

async function serverErrorMessage(response, fallback) {
  try {
    const payload = await response.json();
    const message = typeof payload?.error?.message === 'string'
      ? [...payload.error.message].slice(0, 200).join('')
      : fallback;
    const requestId = /^[0-9a-f-]{36}$/i.test(payload?.requestId || '') ? payload.requestId : '';
    return requestId ? `${message} Référence : ${requestId}` : message;
  } catch {
    return fallback;
  }
}

function takeRoomInviteFromFragment() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const candidate = params.get('room') || '';
  const room = ROOM_CODE_PATTERN.test(candidate) ? candidate : '';
  if (window.location.hash) window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  return room;
}
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
const SHOW_ALL_ACTION_CARDS_PREVIEW = false;
const MIN_RECONNECT_SCREEN_MS = 1000;
const CHAT_GROUP_WINDOW_MS = 2 * 60 * 1000;
const ACTION_PLAY_POPUP_MS = 3400;
const MAX_PLAYER_NAME_LENGTH = 20;
const ACTION_CARD_PREVIEWS = Object.keys(ACTION_LABELS).map((type) => ({
  id: `preview-${type}`,
  type,
  preview: true,
}));

function normalizePlayerNameInput(value) {
  return String(value || '').trim().slice(0, MAX_PLAYER_NAME_LENGTH);
}

function GameToast({ message, tone = 'error' }) {
  if (!message) return null;

  return (
    <div className={`sj-game-toast sj-game-toast-${tone}`} role="status" aria-live="polite">
      <span className="sj-game-toast-icon" aria-hidden="true">!</span>
      <span className="sj-game-toast-text">{message}</span>
    </div>
  );
}

function ConnectionBadge({ connected }) {
  return (
    <span
      className={`sj-connection-badge ${connected ? 'sj-connection-badge-ok' : ''}`}
      aria-label={connected ? 'Connecté au serveur' : 'Connexion au serveur'}
      title={connected ? 'Connecté au serveur' : 'Connexion au serveur'}
    />
  );
}

function SkyjoLogo({ label = 'Skyjo', connectionBadge = null }) {
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

function readGameValue(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key) || '';
}

function saveGameValue(key, value) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
  if (!value) return;
  const target = localStorage.getItem(AUTH_REMEMBER_KEY) === 'true' ? localStorage : sessionStorage;
  target.setItem(key, value);
}

const PUBLIC_LEGAL_ROUTES = {
  '/privacy': 'privacy',
  '/terms': 'terms',
};

export default function App() {
  const pathname = typeof window === 'undefined'
    ? '/'
    : window.location.pathname.replace(/\/$/, '') || '/';
  const legalDocumentId = PUBLIC_LEGAL_ROUTES[pathname];
  if (legalDocumentId) return <LegalPage documentId={legalDocumentId} />;
  return <SkyjoApp />;
}

function SkyjoApp() {
  const { user, ready, recoveryMode, logout } = useAuth();
  const [consent, setConsent] = useState(null);
  const [consentVersions, setConsentVersions] = useState(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState('');

  useEffect(() => {
    if (!user || recoveryMode) {
      setConsent(null);
      setConsentVersions(null);
      return;
    }
    if (!SERVER_URL) {
      setConsent(false);
      setConsentVersions(null);
      setConsentError('Le serveur de jeu n\'est pas configuré correctement.');
      return;
    }
    let cancelled = false;
    apiFetch('/api/account/consent').then(async (response) => {
      if (!response.ok) throw new Error(await serverErrorMessage(response, 'Impossible de vérifier le consentement.'));
      const data = await response.json();
      if (!data?.termsVersion || !data?.privacyVersion) {
        throw new Error('Les versions des documents sont indisponibles.');
      }
      if (!cancelled) {
        setConsentVersions({
          termsVersion: data.termsVersion,
          privacyVersion: data.privacyVersion,
        });
        setConsent(data.accepted === true);
      }
    }).catch(() => {
      if (!cancelled) {
        setConsentVersions(null);
        setConsent(false);
      }
    });
    return () => { cancelled = true; };
  }, [recoveryMode, user]);

  if (!ready) return <AuthLoadingView />;
  if (recoveryMode) return <ResetPasswordView />;
  if (!user) return <AuthView />;
  if (consent === null) return <AuthLoadingView label="Vérification du consentement" />;
  if (!consent) return <ConsentGate busy={consentBusy} error={consentError} onLogout={logout} onAccept={async () => {
    if (!consentVersions) {
      setConsentError('Impossible de vérifier la version des documents. Rechargez la page.');
      return;
    }
    setConsentBusy(true);
    setConsentError('');
    try {
      const response = await apiFetch('/api/account/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(consentVersions),
      });
      if (!response.ok) throw new Error(await serverErrorMessage(response, 'Impossible d\'enregistrer le consentement.'));
      setConsent(true);
    } catch (error) {
      setConsentError(error.message || 'Impossible d\'enregistrer le consentement.');
    } finally {
      setConsentBusy(false);
    }
  }} />;
  return <GameApp />;
}

function GameApp() {
  const { user, logout } = useAuth();
  const accountPlayerName = normalizePlayerNameInput(user?.playerName || user?.firstName || user?.displayName || '');
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState(() => readGameValue('sj-room-id'));
  const [playerName, setPlayerName] = useState(() => normalizePlayerNameInput(readGameValue('sj-player-name') || accountPlayerName));
  const [playerId, setPlayerId] = useState('');
  const [autoReconnectPending, setAutoReconnectPending] = useState(() => {
    const savedRoomId = readGameValue('sj-room-id');
    return !!savedRoomId;
  });
  const [joinRoomInput, setJoinRoomInput] = useState(() => takeRoomInviteFromFragment());
  const [nameInput, setNameInput] = useState(accountPlayerName || playerName);
  const [roomVisibilityInput, setRoomVisibilityInput] = useState('private');
  const [publicRooms, setPublicRooms] = useState([]);
  const [publicRoomsLoading, setPublicRoomsLoading] = useState(false);
  const [homePanel, setHomePanel] = useState('home');
  const [profileOpen, setProfileOpen] = useState(false);
  const [state, setState] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatBefore, setChatBefore] = useState(null);
  const [pendingReconnectState, setPendingReconnectState] = useState(null);
  const [error, setError] = useState('');
  const [errorSerial, setErrorSerial] = useState(0);
  const autoReconnectPendingRef = useRef(autoReconnectPending);
  const autoReconnectStartedAtRef = useRef(0);
  const errorTimerRef = useRef(null);
  const publicRoomsRequestRef = useRef(0);

  const clearError = useCallback(() => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError('');
  }, []);

  const showError = useCallback((message, timeout = 3500) => {
    if (!message) {
      clearError();
      return;
    }
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setError(message);
    setErrorSerial((serial) => serial + 1);
    if (timeout > 0) {
      errorTimerRef.current = window.setTimeout(() => {
        setError('');
        errorTimerRef.current = null;
      }, timeout);
    }
  }, [clearError]);

  const loadPublicRooms = useCallback(async ({ silent = false } = {}) => {
    const requestId = publicRoomsRequestRef.current + 1;
    publicRoomsRequestRef.current = requestId;
    if (!silent) setPublicRoomsLoading(true);
    try {
      const res = await apiFetch('/api/rooms/public');
      if (!res.ok) throw new Error(await serverErrorMessage(res, 'Impossible de charger les salles publiques.'));
      const data = await res.json();
      if (publicRoomsRequestRef.current !== requestId) return;
      setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch {
      if (publicRoomsRequestRef.current !== requestId) return;
      setPublicRooms([]);
    } finally {
      if (publicRoomsRequestRef.current === requestId) {
        setPublicRoomsLoading(false);
      }
    }
  }, []);

  useEffect(() => () => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    autoReconnectPendingRef.current = autoReconnectPending;
    if (autoReconnectPending && !autoReconnectStartedAtRef.current) {
      autoReconnectStartedAtRef.current = Date.now();
    }
    if (!autoReconnectPending) {
      autoReconnectStartedAtRef.current = 0;
    }
  }, [autoReconnectPending]);

  useEffect(() => {
    if (state || autoReconnectPending || homePanel !== 'public') return undefined;
    const interval = window.setInterval(() => loadPublicRooms({ silent: true }), 5000);
    return () => window.clearInterval(interval);
  }, [autoReconnectPending, homePanel, loadPublicRooms, state]);

  useEffect(() => {
    if (!pendingReconnectState) return undefined;
    const elapsed = Date.now() - autoReconnectStartedAtRef.current;
    const remaining = Math.max(0, MIN_RECONNECT_SCREEN_MS - elapsed);
    const timeout = window.setTimeout(() => {
      setState(pendingReconnectState);
      setPendingReconnectState(null);
      setAutoReconnectPending(false);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [pendingReconnectState]);

  useEffect(() => {
    const savedRoomId = readGameValue('sj-room-id');
    const savedPlayerName = normalizePlayerNameInput(readGameValue('sj-player-name'));
    let nextSocket;
    let reconnectTimeout;

    const stopReconnectScreen = ({ clearSavedRoom = false } = {}) => {
      if (!autoReconnectPendingRef.current) return;
      if (clearSavedRoom) saveGameValue('sj-room-id', '');
      setRoomId('');
      setPlayerId('');
      setPendingReconnectState(null);
      setAutoReconnectPending(false);
    };

    if (savedRoomId) {
      reconnectTimeout = window.setTimeout(() => {
        if (!autoReconnectPendingRef.current) return;
        stopReconnectScreen();
        showError('Impossible de retrouver cette salle pour le moment.');
      }, AUTO_RECONNECT_TIMEOUT_MS);
    }

    nextSocket = io(SERVER_URL, {
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnectionDelay: 300,
      reconnectionDelayMax: 1500,
      timeout: 8000,
      withCredentials: true,
      auth: {
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        roomId: savedRoomId,
        playerName: savedPlayerName,
      },
    });
    setSocket(nextSocket);
    nextSocket.on(SOCKET_EVENTS.CONNECT, () => setConnected(true));
    nextSocket.on(SOCKET_EVENTS.DISCONNECT, () => setConnected(false));
    nextSocket.on(SOCKET_EVENTS.CONNECT_ERROR, (connectError) => {
      console.error('[Skyjo] Échec de connexion Socket.IO', connectError);
      const rawMessage = typeof connectError?.message === 'string' ? connectError.message : '';
      showError(connectErrorUserMessage(connectError));
      if (/session invalide|session expirée/iu.test(rawMessage)) void logout();
    });
    nextSocket.on(SOCKET_EVENTS.ERROR, (payload) => {
      const rawMessage = typeof payload === 'string' ? payload : payload?.message;
      const baseMessage = typeof rawMessage === 'string' ? [...rawMessage].slice(0, 200).join('') : 'Action impossible.';
      const requestId = /^[0-9a-f-]{36}$/i.test(payload?.requestId || '') ? payload.requestId : '';
      const message = requestId ? `${baseMessage} Référence : ${requestId}` : baseMessage;
      const code = typeof payload === 'object' ? payload?.code : '';
      showError(message);
      if (code === 'invalid_session') {
        void logout();
        return;
      }
      if (autoReconnectPendingRef.current && (
        code === 'room_unavailable'
        || code === 'seat_unavailable'
        || message === "Impossible de rejoindre cette salle."
      )) {
        stopReconnectScreen({ clearSavedRoom: true });
      } else if (autoReconnectPendingRef.current && code === 'reconnect_failed') {
        stopReconnectScreen();
      }
    });
    nextSocket.on(SOCKET_EVENTS.JOINED, ({ roomId: rid, playerId: pid }) => {
      setRoomId(rid);
      setPlayerId(pid);
      saveGameValue('sj-room-id', rid);
      nextSocket.auth = {
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        roomId: rid,
        playerName: normalizePlayerNameInput(readGameValue('sj-player-name')),
      };
    });
    nextSocket.on(SOCKET_EVENTS.STATE, (nextState) => {
      if (autoReconnectPendingRef.current) {
        setPendingReconnectState(nextState);
      } else {
        setState(nextState);
      }
    });
    nextSocket.on(SOCKET_EVENTS.CHAT_HISTORY, ({ messages, hasMore, before }) => {
      const page = Array.isArray(messages) ? messages : [];
      setChatMessages((current) => {
        const byId = new Map([...page, ...current].map((message) => [message.id, message]));
        return [...byId.values()].sort((a, b) => (a.t || 0) - (b.t || 0));
      });
      setChatHasMore(Boolean(hasMore));
      setChatBefore(before || null);
    });
    nextSocket.on(SOCKET_EVENTS.CHAT_MESSAGE, (message) => {
      if (!message?.id) return;
      setChatMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
    });
    nextSocket.on(SOCKET_EVENTS.ROOM_EXPIRED, () => {
      saveGameValue('sj-room-id', '');
      setRoomId('');
      setPlayerId('');
      setState(null);
      setChatMessages([]);
      showError('Cette salle a expiré après 24 heures d\'inactivité.');
    });
    nextSocket.on(SOCKET_EVENTS.REMOVED_FROM_ROOM, () => {
      saveGameValue('sj-room-id', '');
      nextSocket.auth = {
        ...nextSocket.auth,
        roomId: '',
      };
      setRoomId('');
      setPlayerId('');
      setState(null);
      setChatMessages([]);
      setJoinRoomInput('');
      setHomePanel('home');
      setAutoReconnectPending(false);
      setPendingReconnectState(null);
      showError('Le propriétaire vous a retiré de la salle.', 5000);
    });
    return () => {
      if (reconnectTimeout) window.clearTimeout(reconnectTimeout);
      nextSocket?.disconnect();
    };
  }, [logout, showError]);

  async function createRoom() {
    if (!socket || !connected) return;
    const name = normalizePlayerNameInput(nameInput);
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    clearError();
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
    try {
      const res = await apiFetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomVisibility: roomVisibilityInput, playerName: name }),
      });
      if (!res.ok) throw new Error(await serverErrorMessage(res, 'Impossible de créer la salle.'));
      const data = await res.json();
      setPlayerName(name);
      saveGameValue('sj-player-name', name);
      emitSocket(socket, SOCKET_EVENTS.JOIN_ROOM, { roomId: data.roomId, playerName: name });
    } catch (err) {
      showError(err.message || 'Serveur indisponible.');
    }
  }

  function joinRoomById(targetRoomId) {
    if (!socket || !connected) return;
    const name = normalizePlayerNameInput(nameInput);
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
    const candidate = String(targetRoomId || '').trim();
    const normalizedRoomId = ROOM_CODE_PATTERN.test(candidate) ? candidate : '';
    if (!normalizedRoomId) {
      showError('Le code de salle est invalide.');
      return;
    }
    setPlayerName(name);
    saveGameValue('sj-player-name', name);
    emitSocket(socket, SOCKET_EVENTS.JOIN_ROOM, { roomId: normalizedRoomId, playerName: name });
  }

  function joinRoom() {
    joinRoomById(joinRoomInput);
  }

  function handleRoomCodePaste(event) {
    const pastedText = event.clipboardData.getData('text');
    const roomCode = extractRoomCodeFromInvite(pastedText);
    const looksLikeInviteLink = pastedText.includes('://')
      || /^[#?]/.test(pastedText.trim())
      || /(?:^|[?&#])room=/i.test(pastedText);
    if (!roomCode && !looksLikeInviteLink) return;

    event.preventDefault();
    setJoinRoomInput(roomCode);
  }

  function openPublicRoomsPanel() {
    const name = normalizePlayerNameInput(nameInput);
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    clearError();
    setHomePanel('public');
    loadPublicRooms();
  }

  function leaveRoom() {
    emitSocket(socket, SOCKET_EVENTS.LEAVE_ROOM);
    saveGameValue('sj-room-id', '');
    setRoomId('');
    setPlayerId('');
    setState(null);
    setChatMessages([]);
    setJoinRoomInput('');
    setHomePanel('home');
    clearError();
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
  }

  async function logoutFromHome() {
    socket?.disconnect();
    saveGameValue('sj-room-id', '');
    saveGameValue('sj-player-name', '');
    await logout();
  }

  if (!state) {
    if (autoReconnectPending && roomId) {
      return (
        <div className="sj-lobby">
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-reconnect-card sj-pop-in">
            <div className="sj-brand-mark">
              <SkyjoLogo connectionBadge={<ConnectionBadge connected={connected} />} />
            </div>
            <div className="sj-reconnect-spinner" aria-hidden="true" />
            <h1>Reconnexion</h1>
            <p className="sj-lobby-copy">Retour dans la salle {roomId}...</p>
            <p className="sj-reconnect-status">
              {connected ? 'Synchronisation de la partie' : 'Connexion au serveur'}
            </p>
          </section>
        </div>
      );
    }

    const canJoinRoom = connected && ROOM_CODE_PATTERN.test(joinRoomInput);
    const canJoinPublicRoom = connected;

    return (
      <>
      <div className="sj-app-shell sj-lobby-room">
        <GameToast key={errorSerial} message={error} />
        <div className="sj-home-panel-stack">
        {homePanel === 'public' && (
          <section
            key="public-rooms"
            className="sj-lobby-card sj-home-card sj-public-search-card"
          >
            <div className="sj-account-controls">
              <ProfileButton onClick={() => setProfileOpen(true)} />
              <button
                type="button"
                className="sj-account-logout"
                onClick={logoutFromHome}
                aria-label="Se déconnecter du compte"
                title="Se déconnecter"
              >
                <LogOut aria-hidden="true" size={16} />
              </button>
            </div>
            <div className="sj-brand-mark">
              <SkyjoLogo connectionBadge={<ConnectionBadge connected={connected} />} />
            </div>

            <section className="sj-public-rooms" aria-label="Parties publiques disponibles">
              {publicRooms.length > 0 ? (
                <div className="sj-public-room-list">
                  {publicRooms.map((publicRoom) => (
                    <button
                      key={publicRoom.roomId}
                      type="button"
                      className="sj-public-room-card"
                      disabled={!canJoinPublicRoom}
                      onClick={() => joinRoomById(publicRoom.roomId)}
                    >
                      <span className="sj-public-room-main">
                        <strong>{publicRoom.gameMode === 'action' ? 'Skyjo Action' : 'Skyjo classique'}</strong>
                        <small>Créée par {publicRoom.creatorName || 'un joueur'}</small>
                      </span>
                      <span className="sj-public-room-meta">
                        <strong>{publicRoom.playerCount}/{publicRoom.maxPlayers}</strong>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="sj-public-room-empty">
                  {publicRoomsLoading ? 'Chargement des parties publiques...' : 'Aucune partie publique disponible.'}
                </p>
              )}
            </section>

            <button type="button" className="sj-public-search-trigger sj-public-search-trigger-back" onClick={() => setHomePanel('home')}>
              Retour à l’accueil
              <span aria-hidden="true">←</span>
            </button>
          </section>
        )}
          <section
            key="home"
            className={`sj-lobby-card sj-home-card ${homePanel === 'public' ? 'sj-home-card-measure' : ''}`}
            aria-hidden={homePanel === 'public' || undefined}
            inert={homePanel === 'public' ? '' : undefined}
          >
            <div className="sj-account-controls">
              <ProfileButton onClick={() => setProfileOpen(true)} />
              <button
                type="button"
                className="sj-account-logout"
                onClick={logoutFromHome}
                aria-label="Se déconnecter du compte"
                title="Se déconnecter"
              >
                <LogOut aria-hidden="true" size={16} />
              </button>
            </div>
            <div className="sj-brand-mark">
              <SkyjoLogo connectionBadge={<ConnectionBadge connected={connected} />} />
            </div>

            <div className="sj-home-main">
              <label htmlFor="player-name">
                Votre nom <span aria-hidden="true">*</span>
              </label>
              <input
                id="player-name"
                value={nameInput}
                onChange={(event) => {
                  const nextName = event.target.value.slice(0, MAX_PLAYER_NAME_LENGTH);
                  setNameInput(nextName);
                  if (error === 'Votre nom est obligatoire.' && normalizePlayerNameInput(nextName)) clearError();
                }}
                placeholder="Pseudo"
                autoComplete="nickname"
                maxLength={MAX_PLAYER_NAME_LENGTH}
                required
                aria-required="true"
              />
              <div
                className={`sj-room-visibility ${roomVisibilityInput === 'public' ? 'sj-room-visibility-public' : 'sj-room-visibility-private'}`}
                role="group"
                aria-label="Visibilité de la salle"
              >
                <button
                  type="button"
                  className={`sj-room-visibility-option ${roomVisibilityInput === 'private' ? 'sj-room-visibility-option-active' : ''}`}
                  onClick={() => setRoomVisibilityInput('private')}
                >
                  <strong>Privée</strong>
                </button>
                <button
                  type="button"
                  className={`sj-room-visibility-option ${roomVisibilityInput === 'public' ? 'sj-room-visibility-option-active' : ''}`}
                  onClick={() => setRoomVisibilityInput('public')}
                >
                  <strong>Publique</strong>
                </button>
              </div>

              <button className="sj-btn sj-btn-primary" disabled={!connected} onClick={createRoom}>
                Créer une salle {roomVisibilityInput === 'public' ? 'publique' : 'privée'}
              </button>

              <div className="sj-divider"><span>ou</span></div>

              <label htmlFor="room-code">Code de la salle à 6 chiffres</label>
              <input
                id="room-code"
                value={joinRoomInput}
                onChange={(event) => setJoinRoomInput(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                onPaste={handleRoomCodePaste}
                placeholder="123456"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="off"
              />
              <button className="sj-btn" disabled={!canJoinRoom} onClick={joinRoom}>
                Rejoindre
              </button>

              <button type="button" className="sj-public-search-trigger" disabled={!connected} onClick={openPublicRoomsPanel}>
                Chercher une partie publique
                <span aria-hidden="true">→</span>
              </button>
            </div>

          </section>
        </div>
      </div>
      <ProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onProfileUpdated={(updatedUser) => {
          const nextPlayerName = normalizePlayerNameInput(updatedUser?.playerName || '');
          if (!nextPlayerName) return;
          setNameInput(nextPlayerName);
          setPlayerName(nextPlayerName);
          saveGameValue('sj-player-name', nextPlayerName);
        }}
      />
      </>
    );
  }

  return (
    <GameScreen
      socket={socket}
      state={state}
      myId={playerId}
      roomId={roomId}
      error={error}
      errorSerial={errorSerial}
      onLeaveRoom={leaveRoom}
      chatMessages={chatMessages}
      chatHasMore={chatHasMore}
      onLoadOlderChat={() => {
        if (chatHasMore && chatBefore) emitSocket(socket, SOCKET_EVENTS.LOAD_CHAT_HISTORY, { before: chatBefore });
      }}
    />
  );
}

function getSelectableSlots(state, isMyTurn, me) {
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

function getBoardActionMode(state) {
  if (state.phase === 'initialFlip' || state.turnStage === 'reveal') return 'reveal';
  if (state.turnStage === 'decide' || state.turnStage === 'place') return 'place';
  return null;
}

function getPeekLineCandidates(player, first) {
  if (!player) return [];

  if (!first) {
    return player.board
      .map((slot, index) => (!slot.removed && !slot.faceUp ? index : -1))
      .filter((index) => index >= 0);
  }
  return [];
}

function getPeekLineOptions(player, firstSlotIndex) {
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

function LeaveRoomModal({ open, onCancel, onConfirm }) {
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
          Vous serez retiré de la partie. Cette action ne peut pas être annulée.
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

function LeaveRoomButton({ onClick }) {
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

function DisconnectedPlayersModal({ open, players, onCancel, onConfirm }) {
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

function ChatButton({ unreadCount = 0, onClick }) {
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

function chatMessageTime(timestamp) {
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function ChatModal({
  open,
  messages = [],
  hasMore = false,
  myId,
  onClose,
  onSend,
  onLoadMore,
}) {
  const [draft, setDraft] = useState('');
  const modalRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    modalRef.current?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

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
              <span>Écrivez le premier message de cette partie.</span>
            </div>
          ) : (
            messages.map((message, index) => {
              const mine = message.playerId === myId;
              const previousMessage = messages[index - 1];
              const grouped = previousMessage?.playerId === message.playerId
                && Math.abs((message.t || 0) - (previousMessage.t || 0)) <= CHAT_GROUP_WINDOW_MS;
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
      </section>
    </div>
  );
}

function countUnreadChatMessages(messages, lastSeenId, myId) {
  if (!messages.length) return 0;
  const startIndex = lastSeenId
    ? messages.findIndex((message) => message.id === lastSeenId) + 1
    : 0;
  return messages
    .slice(Math.max(0, startIndex))
    .filter((message) => message.playerId !== myId)
    .length;
}

function DefensePromptModal({ prompt, players, myId, onResolve }) {
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

function StarGroupChoiceModal({ choice, onResolve }) {
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

function PeekLineChoiceModal({ choice, onResolve, onBack }) {
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

function PeekResultModal({ peek, targetPlayer, isOwnBoard, onClose }) {
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

function ActionHandModal({
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

function PlayerActionCardsModal({
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

function StealActionPlayerModal({
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

function StealActionCardModal({
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

function DrawThreeActionModal({
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

function PlayDiscardActionModal({
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

const CARD_REVEAL_SETTLE_MS = 380;
const CARD_MOTION_SETTLE_BUFFER_MS = 40;

function getCardMotionSettleDelay(moveType, motionEndsAt) {
  const fallbackDelay = ['reveal', 'roundReveal'].includes(moveType)
    ? CARD_REVEAL_SETTLE_MS
    : 120;
  const remainingMotion = Math.max(
    0,
    Math.ceil(motionEndsAt - Date.now()) + CARD_MOTION_SETTLE_BUFFER_MS,
  );
  return Math.max(fallbackDelay, remainingMotion);
}

function GameScreen({
  socket, state, myId, roomId, error, errorSerial, onLeaveRoom,
  chatMessages = [], chatHasMore = false, onLoadOlderChat,
}) {
  const [copied, setCopied] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [disconnectedPlayersModalOpen, setDisconnectedPlayersModalOpen] = useState(false);
  const [gameGuideOpen, setGameGuideOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(null);
  const [actionHandModalOpen, setActionHandModalOpen] = useState(false);
  const [viewedActionPlayerId, setViewedActionPlayerId] = useState(null);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [visibleActionPlayId, setVisibleActionPlayId] = useState(null);
  const [roundScoresReady, setRoundScoresReady] = useState(true);
  const [peekNow, setPeekNow] = useState(() => Date.now());
  const [dismissedPeekId, setDismissedPeekId] = useState(null);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState(null);
  const [visibleLastTurnNoticeId, setVisibleLastTurnNoticeId] = useState(null);
  const [roundCountdown, setRoundCountdown] = useState(10);
  const [starClaimModalReady, setStarClaimModalReady] = useState(false);
  const tutorialCheckedRef = useRef(false);
  const [groupChoiceModalReadyId, setGroupChoiceModalReadyId] = useState(null);
  const [cardMotionEndsAt, setCardMotionEndsAt] = useState(0);
  const [visibleRoundRevealId, setVisibleRoundRevealId] = useState(null);
  const [roundRevealEndsAt, setRoundRevealEndsAt] = useState(0);
  const initializedChatRoomRef = useRef('');
  const closeChatModal = useCallback(() => setChatModalOpen(false), []);
  const handleCardMotionBatch = useCallback((endsAt) => {
    if (!Number.isFinite(endsAt)) return;
    setCardMotionEndsAt((current) => Math.max(current, endsAt));
  }, []);

  const cardMoves = state.cardMoves?.length > 0
    ? state.cardMoves
    : state.lastCardMove ? [state.lastCardMove] : [];
  const latestCardMove = cardMoves.at(-1) || null;
  const latestCardMoveType = latestCardMove?.type || null;
  const roundRevealMove = [...cardMoves]
    .reverse()
    .find((move) => move.type === 'roundReveal') || null;
  const roundRevealId = roundRevealMove?.id || null;
  const concealedRoundRevealSlots = new Set(
    (roundRevealMove?.cards || []).map((entry) => `${entry.playerId}:${entry.slotIndex}`),
  );
  const concealRoundReveal = !!roundRevealId && visibleRoundRevealId !== roundRevealId;
  const motionSequenceEndsAt = Math.max(cardMotionEndsAt, roundRevealEndsAt);

  const roundScorePhase = ['roundEnd', 'gameEnd'].includes(state.phase);
  const roundScoreDeadline = Math.max(state.roundScoresAt || 0, motionSequenceEndsAt);
  const roundScoreDeadlineReached = !roundScoreDeadline || Date.now() >= roundScoreDeadline;
  const roundScoresVisible = !roundScorePhase
    || !state.roundScoresAt
    || (roundScoresReady && roundScoreDeadlineReached);
  const roundScorePreviewActive = roundScorePhase && !roundScoresVisible;
  const boardPlayers = state.players.map((player) => ({
    ...player,
    ...(roundScorePreviewActive ? {
      hasTotalScore: false,
      hideTotalScore: true,
      lastRoundScore: null,
    } : {}),
    board: concealRoundReveal
      ? player.board.map((slot, slotIndex) => (
        !slot.removed && concealedRoundRevealSlots.has(`${player.id}:${slotIndex}`)
          ? {
            ...slot,
            cardId: null,
            value: null,
            kind: null,
            faceUp: false,
          }
          : slot
      ))
      : player.board,
  }));
  const me = boardPlayers.find((player) => player.id === myId);
  const others = boardPlayers.filter((player) => player.id !== myId);
  const isCreator = state.creatorId === myId;
  const disconnectedPlayers = state.players.filter((player) => !player.connected);
  const isMyTurn = state.phase === 'playing' && state.currentPlayerId === myId;
  const selectableSlots = getSelectableSlots(state, isMyTurn, me);
  const boardActionMode = getBoardActionMode(state);
  const drawnCard = state.drawnCard?.card;
  const isActionMode = state.gameMode === 'action';
  const lastTurnLocked = isActionMode && state.phase === 'playing' && !!state.roundEnderId;
  const roundEnder = state.roundEnderId
    ? state.players.find((player) => player.id === state.roundEnderId)
    : null;
  const lastTurnNoticeId = state.roundEnderId
    ? `${state.roundNumber || 0}-${state.roundEnderId}`
    : null;
  const showLastTurnNotice = state.phase === 'playing'
    && !!roundEnder
    && visibleLastTurnNoticeId === lastTurnNoticeId;
  const latestChatMessageId = chatMessages.at(-1)?.id || null;
  const chatRoomInitialized = initializedChatRoomRef.current === roomId;
  const unreadChatCount = chatModalOpen || !chatRoomInitialized
    ? 0
    : countUnreadChatMessages(chatMessages, lastSeenChatMessageId, myId);
  const myActionState = state.playersAction?.[myId] || { actionCards: [], peek: null };
  const activePeek = myActionState.peek
    && myActionState.peek.expiresAt > peekNow
    && myActionState.peek.id !== dismissedPeekId
    ? myActionState.peek
    : null;
  const activePeekTarget = activePeek
    ? state.players.find((player) => player.id === activePeek.targetPlayerId)
    : null;
  const actionCardsForDisplay = SHOW_ALL_ACTION_CARDS_PREVIEW
    ? [
      ...myActionState.actionCards,
      ...ACTION_CARD_PREVIEWS.filter((preview) =>
        !myActionState.actionCards.some((card) => card.type === preview.type)),
    ]
    : myActionState.actionCards;
  const viewedActionPlayer = viewedActionPlayerId
    ? state.players.find((player) => player.id === viewedActionPlayerId)
    : null;
  const viewedActionCards = viewedActionPlayerId
    ? state.playersAction?.[viewedActionPlayerId]?.actionCards || []
    : [];
  const pendingAction = state.pendingAction;
  const currentRemoveEachTargetId = pendingAction?.type === 'removeEach'
    ? pendingAction.currentTargetId || pendingAction.remaining?.[0]
    : null;
  const pendingGroupChoice = state.pendingGroupChoice || null;
  const lastPlayedAction = state.lastPlayedAction || null;
  const actionPlayId = lastPlayedAction?.id || null;
  const actionSelection = pendingAction?.selection || {};
  const peekFirst = pendingAction?.type === 'peekLine' ? actionSelection.peekFirst : null;
  const peekTarget = peekFirst
    ? state.players.find((player) => player.id === peekFirst.playerId)
    : null;
  const peekFirstSlot = peekTarget?.board?.[peekFirst?.slotIndex];
  const invalidPeekFirst = !!pendingAction?.mustRespond
    && pendingAction.type === 'peekLine'
    && !!peekFirst
    && (!peekFirstSlot || peekFirstSlot.removed || peekFirstSlot.faceUp);
  const peekLineChoice = pendingAction?.mustRespond && peekTarget
    ? {
      targetPlayerId: peekTarget.id,
      targetPlayerName: peekTarget.name,
      isOwnBoard: peekTarget.id === myId,
      firstSlotIndex: peekFirst.slotIndex,
      options: getPeekLineOptions(peekTarget, peekFirst.slotIndex),
      boardCards: peekTarget.board.map((slot, slotIndex) => ({
        slotIndex,
        value: slot?.value ?? null,
        kind: slot?.kind || 'number',
        faceUp: !!slot?.faceUp,
        removed: !!slot?.removed,
      })),
    }
    : null;
  const selectableByPlayer = Object.fromEntries(state.players.map((player) => [player.id, []]));
  const selectedByPlayer = Object.fromEntries(state.players.map((player) => [player.id, []]));
  selectableByPlayer[myId] = selectableSlots || [];
  if (pendingAction?.mustRespond) {
    if (pendingAction.type === 'removeEach') {
      selectableByPlayer[myId] = [];
      const currentTargetId = pendingAction.currentTargetId || pendingAction.remaining?.[0];
      for (const player of state.players) {
        if (player.id !== currentTargetId) continue;
        selectableByPlayer[player.id] = player.board
          .map((slot, index) => (!slot.removed ? index : -1))
          .filter((index) => index >= 0);
      }
    } else if (pendingAction.type === 'swapOwn') {
      selectableByPlayer[myId] = me?.board.map((slot, index) => (!slot.removed ? index : -1)).filter((index) => index >= 0) || [];
      selectedByPlayer[myId] = actionSelection.slots || [];
    } else if (pendingAction.type === 'drawThree') {
      const hasChoice = Object.prototype.hasOwnProperty.call(actionSelection, 'choiceIndex');
      selectableByPlayer[myId] = me?.board
        .map((slot, index) => (hasChoice && !slot.removed && (actionSelection.choiceIndex !== null || !slot.faceUp) ? index : -1))
        .filter((index) => index >= 0) || [];
    } else if (pendingAction.type === 'peekLine') {
      const first = actionSelection.peekFirst;
      for (const player of state.players) {
        selectableByPlayer[player.id] = getPeekLineCandidates(player, first);
      }
      if (first?.playerId && Number.isInteger(first.slotIndex)) {
        selectedByPlayer[first.playerId] = [first.slotIndex];
      }
    } else if (pendingAction.type === 'swapPlayers') {
      for (const player of state.players) {
        selectableByPlayer[player.id] = player.board
          .map((slot, index) => (!slot.removed ? index : -1))
          .filter((index) => index >= 0);
      }
      for (const target of actionSelection.targets || []) {
        if (!selectedByPlayer[target.playerId]) selectedByPlayer[target.playerId] = [];
        selectedByPlayer[target.playerId].push(target.slotIndex);
      }
    }
  }

  const canDrawDeck = state.phase === 'playing'
    && isMyTurn
    && state.turnStage === (isActionMode ? 'choose' : 'draw');
  const canDrawDiscard = canDrawDeck && !!state.discardTop;
  const canDiscardDrawn = state.phase === 'playing' && isMyTurn && state.turnStage === 'decide' && !!drawnCard;
  const hasDrawnCard = !!state.drawnCard;
  const drawnFromDeck = hasDrawnCard && state.drawnCard?.from === 'deck';
  const drawnFromDiscard = hasDrawnCard && state.drawnCard?.from === 'discard';
  const drawnCardIsMine = hasDrawnCard && state.currentPlayerId === myId;
  const defensePrompt = pendingAction?.defensePrompt || null;
  const hasDrawThreeChoice = Object.prototype.hasOwnProperty.call(actionSelection, 'choiceIndex');
  const showDrawThreeModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'drawThree'
    && !hasDrawThreeChoice;
  const showPlayDiscardModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'playDiscard';
  const playableDiscardCardIds = new Set(pendingAction?.playableDiscardCardIds || []);
  const playableDiscardCards = (state.actionDiscard || [])
    .filter((card) => playableDiscardCardIds.has(card.id));
  const stealTargetId = pendingAction?.type === 'stealAction'
    ? actionSelection.stealTargetId
    : null;
  const stealTarget = stealTargetId
    ? state.players.find((player) => player.id === stealTargetId)
    : null;
  const stealTargetCards = stealTargetId
    ? state.playersAction?.[stealTargetId]?.actionCards || []
    : [];
  const stealTargets = pendingAction?.type === 'stealAction'
    ? state.players
      .filter((player) => player.id !== myId && player.connected)
      .map((player) => ({
        player,
        cards: state.playersAction?.[player.id]?.actionCards || [],
      }))
      .filter(({ cards }) => cards.length > 0)
    : [];
  const autoStealTargetId = !stealTargetId && stealTargets.length === 1
    ? stealTargets[0].player.id
    : null;
  const showStealPlayerModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'stealAction'
    && !stealTargetId
    && !autoStealTargetId;
  const showStealCardModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'stealAction'
    && !!stealTargetId;
  const layoutKey = [
    state.phase,
    state.gameMode,
    state.players.length,
  ].join('|');
  const {
    shellRef,
    boardAreaRef,
    opponentsRef,
    playColumnRef,
    meWrapRef,
    centerRef,
    actionPanelRef,
    layoutReady,
    layoutClassName,
  } = useAdaptiveBoardSizing(state.players.length, layoutKey, isActionMode);

  useEffect(() => {
    if (!['initialFlip', 'playing'].includes(state.phase) || tutorialCheckedRef.current) return;
    tutorialCheckedRef.current = true;
    if (!hasCompletedGameTutorial()) setTutorialStep(0);
  }, [state.phase]);

  useEffect(() => {
    if (!actionPlayId) {
      setVisibleActionPlayId(null);
      return undefined;
    }

    setVisibleActionPlayId(actionPlayId);
    const timeout = window.setTimeout(() => {
      setVisibleActionPlayId((currentId) => (
        currentId === actionPlayId ? null : currentId
      ));
    }, ACTION_PLAY_POPUP_MS);

    return () => window.clearTimeout(timeout);
  }, [actionPlayId]);

  useEffect(() => {
    if (state.phase !== 'playing' || !lastTurnNoticeId) {
      setVisibleLastTurnNoticeId(null);
      return undefined;
    }

    setVisibleLastTurnNoticeId(lastTurnNoticeId);
    const timeout = window.setTimeout(() => {
      setVisibleLastTurnNoticeId((currentId) => (
        currentId === lastTurnNoticeId ? null : currentId
      ));
    }, 3500);

    return () => window.clearTimeout(timeout);
  }, [lastTurnNoticeId, state.phase]);

  useEffect(() => {
    if (!['roundEnd', 'gameEnd'].includes(state.phase) || !roundScoreDeadline) {
      setRoundScoresReady(true);
      return undefined;
    }

    const updateScoresReady = () => {
      setRoundScoresReady(Date.now() >= roundScoreDeadline);
    };

    updateScoresReady();
    const delay = Math.max(0, roundScoreDeadline - Date.now());
    const timeout = window.setTimeout(updateScoresReady, delay);
    return () => window.clearTimeout(timeout);
  }, [roundScoreDeadline, state.phase]);

  useEffect(() => {
    if (!myActionState.peek?.expiresAt) return undefined;

    setPeekNow(Date.now());
    const delay = Math.max(0, myActionState.peek.expiresAt - Date.now());
    const timeout = window.setTimeout(() => setPeekNow(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [myActionState.peek?.id, myActionState.peek?.expiresAt]);

  useEffect(() => {
    if (!invalidPeekFirst) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { peekFirst: null } });
  }, [invalidPeekFirst, socket]);

  useEffect(() => {
    if (!pendingAction?.mustRespond || pendingAction.type !== 'stealAction' || !autoStealTargetId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: autoStealTargetId } });
  }, [autoStealTargetId, pendingAction?.mustRespond, pendingAction?.type, socket]);

  useEffect(() => {
    if (!roundRevealId) {
      setVisibleRoundRevealId(null);
      setRoundRevealEndsAt(0);
      return undefined;
    }
    if (visibleRoundRevealId === roundRevealId) return undefined;

    const revealDelay = getCardMotionSettleDelay('roundReveal', cardMotionEndsAt);
    setRoundRevealEndsAt(Date.now() + revealDelay + CARD_REVEAL_SETTLE_MS);
    const timeout = window.setTimeout(
      () => setVisibleRoundRevealId(roundRevealId),
      revealDelay,
    );
    return () => window.clearTimeout(timeout);
  }, [cardMotionEndsAt, roundRevealId, visibleRoundRevealId]);

  useEffect(() => {
    setStarClaimModalReady(false);
    if (!state.pendingStarClaim) return undefined;

    const cardMotionSettleDelay = getCardMotionSettleDelay(
      latestCardMoveType,
      motionSequenceEndsAt,
    );
    const timeout = window.setTimeout(() => setStarClaimModalReady(true), cardMotionSettleDelay);
    return () => window.clearTimeout(timeout);
  }, [latestCardMoveType, motionSequenceEndsAt, state.pendingStarClaim]);

  useEffect(() => {
    setGroupChoiceModalReadyId(null);
    if (!pendingGroupChoice?.id) return undefined;

    const cardMotionSettleDelay = getCardMotionSettleDelay(
      latestCardMoveType,
      motionSequenceEndsAt,
    );
    const timeout = window.setTimeout(
      () => setGroupChoiceModalReadyId(pendingGroupChoice.id),
      cardMotionSettleDelay,
    );
    return () => window.clearTimeout(timeout);
  }, [latestCardMoveType, motionSequenceEndsAt, pendingGroupChoice?.id]);

  useEffect(() => {
    if (state.phase !== 'playing' || state.currentPlayerId === myId) return undefined;

    let frame = null;
    const cardMotionSettleDelay = getCardMotionSettleDelay(
      latestCardMoveType,
      motionSequenceEndsAt,
    );
    const timeout = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        const activeBoard = opponentsRef.current?.querySelector('.sj-board-active');
        if (!activeBoard) return;
        activeBoard.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center',
        });
      });
    }, cardMotionSettleDelay);

    return () => {
      window.clearTimeout(timeout);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [latestCardMoveType, motionSequenceEndsAt, myId, opponentsRef, state.currentPlayerId, state.phase, state.players.length]);

  useEffect(() => {
    if (
      myActionState.actionCards.length === 0
      || state.phase === 'roundEnd'
      || !!state.pendingStarClaim
      || !!defensePrompt
      || !!pendingAction?.mustRespond
    ) {
      setActionHandModalOpen(false);
    }
  }, [
    myActionState.actionCards.length,
    defensePrompt,
    pendingAction?.mustRespond,
    state.pendingStarClaim,
    state.phase,
  ]);

  useEffect(() => {
    if (!viewedActionPlayerId) return;
    if (!isActionMode || !state.players.some((player) => player.id === viewedActionPlayerId)) {
      setViewedActionPlayerId(null);
    }
  }, [isActionMode, state.players, viewedActionPlayerId]);

  useEffect(() => {
    if (state.phase !== 'roundEnd' || !state.nextRoundAt) {
      setRoundCountdown(10);
      return undefined;
    }

    const updateCountdown = () => {
      const secondsLeft = Math.max(0, Math.ceil((state.nextRoundAt - Date.now()) / 1000));
      setRoundCountdown(secondsLeft);
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [state.phase, state.nextRoundAt]);

  useEffect(() => {
    if (initializedChatRoomRef.current === roomId) return;
    initializedChatRoomRef.current = roomId;
    setLastSeenChatMessageId(latestChatMessageId);
  }, [latestChatMessageId, roomId]);

  useEffect(() => {
    if (!chatModalOpen) return;
    setLastSeenChatMessageId(latestChatMessageId);
  }, [chatModalOpen, latestChatMessageId]);

  async function copyRoomCode() {
    const text = roomId ? `${window.location.origin}/#room=${encodeURIComponent(roomId)}` : '';
    if (!text) return;

    let copiedSuccessfully = false;

    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copiedSuccessfully = true;
      } catch {
        copiedSuccessfully = false;
      }
    }

    if (!copiedSuccessfully) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.className = 'sj-clipboard-fallback';
      document.body.appendChild(textarea);

      const selection = document.getSelection();
      const previousRange = selection && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null;
      const activeElement = document.activeElement;

      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);

      try {
        copiedSuccessfully = document.execCommand('copy');
      } catch {
        copiedSuccessfully = false;
      }

      document.body.removeChild(textarea);
      if (previousRange && selection) {
        selection.removeAllRanges();
        selection.addRange(previousRange);
      }
      activeElement?.focus?.({ preventScroll: true });
    }

    if (!copiedSuccessfully) return;

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function handleBoardSlotClick(playerId, slotIndex) {
    if (pendingAction?.mustRespond && pendingAction.type === 'removeEach') {
      const currentTargetId = pendingAction.currentTargetId || pendingAction.remaining?.[0];
      if (playerId !== myId && playerId === currentTargetId) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { targetPlayerId: playerId, slotIndex });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'swapOwn' && playerId === myId) {
      const firstSlot = actionSelection.slots?.[0];
      if (Number.isInteger(firstSlot) && firstSlot !== slotIndex) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { slotIndex });
      } else if (!Number.isInteger(firstSlot)) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { slots: [slotIndex] } });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'drawThree' && playerId === myId) {
      if (actionSelection.choiceIndex === null) emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { revealSlot: slotIndex });
      else if (Number.isInteger(actionSelection.choiceIndex)) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { slotIndex });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'peekLine') {
      const first = actionSelection.peekFirst;
      if (!first) {
        const target = state.players.find((player) => player.id === playerId);
        const options = getPeekLineOptions(target, slotIndex);
        const informativeOptions = options.filter((option) => option.hiddenCount > 1);
        const automaticGroupType = informativeOptions.length === 0
          ? 'single'
          : informativeOptions.length === 1 ? informativeOptions[0].groupType : null;
        if (automaticGroupType) {
          emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, {
            targetPlayerId: playerId,
            firstSlotIndex: slotIndex,
            groupType: automaticGroupType,
          });
        } else {
          emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { peekFirst: { playerId, slotIndex } } });
        }
      } else if (first.playerId === playerId && first.slotIndex !== slotIndex) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, {
          targetPlayerId: playerId,
          firstSlotIndex: first.slotIndex,
          secondSlotIndex: slotIndex,
        });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'swapPlayers') {
      const first = actionSelection.targets?.[0];
      const target = { playerId, slotIndex };
      if (first && (first.playerId !== playerId || first.slotIndex !== slotIndex)) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { second: target });
      } else if (!first) {
        emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { targets: [target] } });
      }
      return;
    }

    if (playerId !== myId) return;
    if (state.phase === 'initialFlip') {
      emitSocket(socket, SOCKET_EVENTS.FLIP_INITIAL, { slotIndex });
    } else if (state.turnStage === 'decide') {
      emitSocket(socket, SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE, { slotIndex });
    } else if (state.turnStage === 'place') {
      emitSocket(socket, SOCKET_EVENTS.PLACE_CARD, { slotIndex });
    } else if (state.turnStage === 'reveal') {
      emitSocket(socket, SOCKET_EVENTS.REVEAL_CARD, { slotIndex });
    }
  }

  function handleMySlotClick(slotIndex) {
    handleBoardSlotClick(myId, slotIndex);
  }

  function handleDiscardClick() {
    if (canDiscardDrawn) {
      emitSocket(socket, SOCKET_EVENTS.DECIDE_DRAWN, { keep: false });
    } else if (canDrawDiscard) {
      emitSocket(socket, SOCKET_EVENTS.DRAW_CARD, { source: 'discard' });
    }
  }

  function handleActionCardSelect(payload) {
    if (state.pendingStarClaim) {
      emitSocket(socket, SOCKET_EVENTS.CLAIM_STAR_ACTION, payload);
    }
  }

  function handlePlayActionCard(cardId) {
    emitSocket(socket, SOCKET_EVENTS.PLAY_ACTION_CARD, { cardId });
    setActionHandModalOpen(false);
  }

  function handleDiscardActionCard(cardId) {
    emitSocket(socket, SOCKET_EVENTS.DISCARD_ACTION_CARD, { cardId });
    setActionHandModalOpen(false);
  }

  function handleOpenPlayerActionCards(playerId) {
    setViewedActionPlayerId(playerId);
  }

  function handleRemoveEachActionCardSelect(actionCardId) {
    if (!viewedActionPlayerId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { targetPlayerId: viewedActionPlayerId, actionCardId });
    setViewedActionPlayerId(null);
  }

  function handleDefensePrompt(useDefense) {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_DEFENSE, { useDefense });
  }

  function handleStarGroupChoice(remove) {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_GROUP_CHOICE, { remove });
  }

  function handleDrawThreeChoice(choiceIndex) {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { choiceIndex } });
  }

  function handleStealTargetSelect(targetId) {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: targetId } });
  }

  function handleStealTargetReset() {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: null } });
  }

  function handleStealCardSelect(cardId) {
    if (!stealTargetId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { targetPlayerId: stealTargetId, cardId });
  }

  function handlePlayDiscardActionSelect(cardId) {
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { cardId });
  }

  function handleOpenChat() {
    setChatModalOpen(true);
    setLastSeenChatMessageId(latestChatMessageId);
  }

  function handleSendChatMessage(text) {
    emitSocket(socket, SOCKET_EVENTS.SEND_CHAT_MESSAGE, { text });
  }

  function actionPopupFor(playerId) {
    if (!lastPlayedAction || visibleActionPlayId !== actionPlayId || lastPlayedAction.playerId !== playerId) {
      return null;
    }

    const type = lastPlayedAction.card?.type;
    return {
      id: lastPlayedAction.id,
      title: ACTION_LABELS[type] || 'Carte Action',
      artType: Object.hasOwn(ACTION_ART_URLS, type) ? type : 'drawThree',
    };
  }

  const leaveModal = (
    <LeaveRoomModal
      open={leaveModalOpen}
      onCancel={() => setLeaveModalOpen(false)}
      onConfirm={onLeaveRoom}
    />
  );
  const leaveButton = (
    <LeaveRoomButton onClick={() => setLeaveModalOpen(true)} />
  );
  const removePlayerFromLobby = (targetPlayerId) => {
    emitSocket(socket, SOCKET_EVENTS.REMOVE_PLAYER_FROM_LOBBY, { playerId: targetPlayerId });
  };
  const disconnectedPlayersModal = (
    <DisconnectedPlayersModal
      open={disconnectedPlayersModalOpen}
      players={disconnectedPlayers}
      onCancel={() => setDisconnectedPlayersModalOpen(false)}
      onConfirm={() => {
        disconnectedPlayers.forEach((player) => removePlayerFromLobby(player.id));
        setDisconnectedPlayersModalOpen(false);
      }}
    />
  );
  const chatButton = (
    <ChatButton unreadCount={unreadChatCount} onClick={handleOpenChat} />
  );
  const chatModal = (
    <ChatModal
      open={chatModalOpen}
      messages={chatMessages}
      hasMore={chatHasMore}
      myId={myId}
      onClose={closeChatModal}
      onSend={handleSendChatMessage}
      onLoadMore={onLoadOlderChat}
    />
  );
  const actionDrawModal = (
    <ActionDrawModal
      open={!!state.pendingStarClaim && starClaimModalReady}
      market={state.actionMarket}
      canDrawDeck={state.canDrawActionDeck}
      title="Choisir une carte Action"
      onSelect={handleActionCardSelect}
    />
  );
  const actionHandModal = (
    <ActionHandModal
      open={actionHandModalOpen}
      cards={actionCardsForDisplay}
      turnSerial={state.turnSerial}
      isMyTurn={isMyTurn}
      turnStage={state.turnStage}
      lastTurnLocked={lastTurnLocked}
      onClose={() => setActionHandModalOpen(false)}
      onPlay={handlePlayActionCard}
      onDiscard={handleDiscardActionCard}
    />
  );
  const playerActionCardsModal = (
    <PlayerActionCardsModal
      open={!!viewedActionPlayer}
      player={viewedActionPlayer}
      cards={viewedActionCards}
      selectable={!!pendingAction?.mustRespond
        && pendingAction.type === 'removeEach'
        && viewedActionPlayerId === currentRemoveEachTargetId}
      onSelect={handleRemoveEachActionCardSelect}
      onClose={() => setViewedActionPlayerId(null)}
    />
  );
  const defensePromptModal = (
    <DefensePromptModal
      prompt={defensePrompt}
      players={state.players}
      myId={myId}
      onResolve={handleDefensePrompt}
    />
  );
  const starGroupChoiceModal = (
    <StarGroupChoiceModal
      choice={pendingGroupChoice?.id === groupChoiceModalReadyId ? pendingGroupChoice : null}
      onResolve={handleStarGroupChoice}
    />
  );
  const peekLineChoiceModal = (
    <PeekLineChoiceModal
      choice={peekLineChoice}
      onResolve={(groupType) => emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, {
        targetPlayerId: peekLineChoice?.targetPlayerId,
        firstSlotIndex: peekLineChoice?.firstSlotIndex,
        groupType,
      })}
      onBack={() => emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { peekFirst: null } })}
    />
  );
  const drawThreeActionModal = (
    <DrawThreeActionModal
      open={showDrawThreeModal}
      cards={pendingAction?.type === 'drawThree' ? pendingAction.drawn : []}
      canRevealHidden={me?.board.some((slot) => !slot.removed && !slot.faceUp)}
      onSelect={handleDrawThreeChoice}
    />
  );
  const playDiscardActionModal = (
    <PlayDiscardActionModal
      open={showPlayDiscardModal}
      cards={playableDiscardCards}
      onSelect={handlePlayDiscardActionSelect}
    />
  );
  const stealActionPlayerModal = (
    <StealActionPlayerModal
      open={showStealPlayerModal}
      players={state.players}
      playersAction={state.playersAction}
      myId={myId}
      onSelect={handleStealTargetSelect}
    />
  );
  const stealActionCardModal = (
    <StealActionCardModal
      open={showStealCardModal}
      target={stealTarget}
      cards={stealTargetCards}
      canChangeTarget={stealTargets.length > 1}
      onBack={handleStealTargetReset}
      onSelect={handleStealCardSelect}
    />
  );
  const peekResultModal = (
    <PeekResultModal
      peek={activePeek}
      targetPlayer={activePeekTarget}
      isOwnBoard={activePeek?.targetPlayerId === myId}
      onClose={() => setDismissedPeekId(activePeek?.id || null)}
    />
  );
  const startTutorial = () => {
    setGameGuideOpen(false);
    setTutorialStep(0);
  };
  const finishTutorial = () => {
    completeGameTutorial();
    setTutorialStep(null);
  };
  const closeTutorialToGuide = () => {
    setTutorialStep(null);
    setGameGuideOpen(true);
  };
  const gameGuideModal = (
    <GameGuideModal
      open={gameGuideOpen}
      gameMode={state.gameMode}
      onClose={() => setGameGuideOpen(false)}
      onStartTutorial={startTutorial}
    />
  );
  const gameTutorial = (
    <GameTutorial
      open={tutorialStep !== null}
      gameMode={state.gameMode}
      onClose={closeTutorialToGuide}
      onFinish={finishTutorial}
    />
  );

  if (state.phase === 'lobby') {
    return (
      <>
        <div className="sj-app-shell sj-lobby-room">
          {leaveButton}
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-fade-in">
            <div className="sj-room-head">
              <span>Salle</span>
              <span className="sj-room-copy-wrap">
                <button type="button" className={`sj-room-copy ${copied ? 'sj-room-copy-copied' : ''}`} onClick={copyRoomCode}>{roomId}</button>
                {copied && (
                  <span className="sj-copy-toast" role="status" aria-live="polite" aria-label="Code copié">
                    ✓
                  </span>
                )}
              </span>
            </div>
            <p className={`sj-room-visibility-badge ${state.roomVisibility === 'public' ? 'sj-room-visibility-badge-public' : ''}`}>
              {state.roomVisibility === 'public' ? 'Salle publique' : 'Salle privée'}
            </p>
            <ul className="sj-player-list">
              {state.players.map((player) => (
                <li
                  key={player.id}
                  className={`sj-pop-in ${player.id === myId ? 'sj-player-list-current' : ''} ${!player.connected ? 'sj-player-list-disconnected' : ''}`}
                >
                  <span className={`sj-turn-dot ${player.connected ? 'sj-turn-dot-on' : ''}`} />
                  <span className="sj-player-list-name">{player.name}</span>
                  {isCreator && player.id !== myId && (
                    <button
                      type="button"
                      className="sj-player-remove-button"
                      aria-label={`Retirer ${player.name} de la salle`}
                      title={`Retirer ${player.name} de la salle`}
                      onClick={() => removePlayerFromLobby(player.id)}
                    >
                      <Trash2 aria-hidden="true" size={18} />
                    </button>
                  )}
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
                  <div key={mode.id} className={`sj-mode-option ${state.gameMode === mode.id ? 'sj-mode-option-active' : ''}`}>
                    <button
                      type="button"
                      disabled={!isCreator}
                      aria-pressed={state.gameMode === mode.id}
                      onClick={() => emitSocket(socket, SOCKET_EVENTS.SET_GAME_MODE, { gameMode: mode.id })}
                    >
                      <strong>{mode.label}</strong>
                    </button>
                  </div>
                ))}
              </div>
            </section>
            <div className="sj-lobby-start-actions">
              <GameGuideButton onClick={() => setGameGuideOpen(true)} />
              {isCreator && state.players.length >= 2 && (
                <button
                  className="sj-btn sj-btn-primary"
                  onClick={() => {
                    if (disconnectedPlayers.length > 0) {
                      setDisconnectedPlayersModalOpen(true);
                      return;
                    }
                    emitSocket(socket, SOCKET_EVENTS.START_GAME);
                  }}
                >
                  Lancer la partie
                </button>
              )}
            </div>
            {state.players.length < 2 ? (
              <p className="sj-hint">En attente d'au moins 2 joueurs</p>
            ) : !isCreator && (
              <p className="sj-hint">En attente de lancement par le créateur</p>
            )}
          </section>
        </div>
        {leaveModal}
        {disconnectedPlayersModal}
        {gameGuideModal}
        {gameTutorial}
      </>
    );
  }

  if (state.phase === 'gameEnd' && roundScoresVisible) {
    const winnerIds = Array.isArray(state.winnerIds) && state.winnerIds.length > 0
      ? state.winnerIds
      : state.winnerId ? [state.winnerId] : [];
    const winners = winnerIds
      .map((winnerId) => state.players.find((player) => player.id === winnerId))
      .filter(Boolean);
    const isDraw = winnerIds.length > 1;
    const winner = winners[0];
    const drawNames = new Intl.ListFormat('fr-FR', { style: 'long', type: 'conjunction' })
      .format(winners.map((player) => player.name));
    return (
      <>
        <div className="sj-app-shell sj-lobby-room">
          {leaveButton}
          {chatButton}
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-pop-in">
            <div className="sj-brand-mark"><SkyjoLogo label={isDraw ? 'Égalité' : `${winner?.name || 'Joueur'} gagne`} /></div>
            {isDraw && (
              <p className="sj-hint">
                {drawNames || 'Plusieurs joueurs'} terminent avec le même plus petit score.
              </p>
            )}
            <ScoreTable players={state.players} />
            {isCreator ? (
              <button className="sj-btn sj-btn-primary" onClick={() => emitSocket(socket, SOCKET_EVENTS.RETURN_TO_LOBBY)}>
                Nouvelle partie
              </button>
            ) : (
              <p className="sj-hint">En attente du créateur pour ouvrir une nouvelle partie</p>
            )}
          </section>
        </div>
        {leaveModal}
        {chatModal}
      </>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`sj-app-shell ${state.players.length === 2 ? 'sj-two-player-game' : ''} ${isActionMode ? 'sj-action-game' : ''} ${layoutClassName} ${layoutReady ? '' : 'sj-layout-pending'}`}
    >
      <CardMotionLayer
        state={state}
        enabled={layoutReady}
        onMotionBatch={handleCardMotionBatch}
      />
      <div className="sj-game-controls" aria-label="Contrôles de la partie">
        {chatButton}
        {leaveButton}
      </div>
      {isActionMode && state.phase !== 'roundEnd' && (
        <ActionHandDock
          cards={actionCardsForDisplay}
          onClick={() => setActionHandModalOpen(true)}
        />
      )}
      <GameToast key={errorSerial} message={error} />
      {state.starterTieNotice?.message && (
        <div className="sj-round-start-notice" aria-live="polite">
          {state.starterTieNotice.message}
        </div>
      )}
      {showLastTurnNotice && (
        <div className="sj-last-turn-notice" aria-live="polite">
          <span className="sj-last-turn-kicker">Dernier tour</span>
          <strong>
            {roundEnder.id === myId ? (
              'Vous avez découvert votre dernière carte.'
            ) : (
              <>
                <span className="sj-action-modal-title-name">{roundEnder.name}</span>
                {' a découvert sa dernière carte.'}
              </>
            )}
          </strong>
        </div>
      )}

      <main ref={boardAreaRef} className="sj-board-area">
        {others.length > 0 && (
          <section
            ref={opponentsRef}
            className={`sj-player-zone sj-opponents sj-opponents-count-${Math.min(others.length, 4)}`}
            aria-label="Adversaires"
          >
            {others.map((player) => (
              <PlayerBoard
                key={player.id}
                player={player}
                isMe={false}
                isActive={state.phase === 'playing' && player.id === state.currentPlayerId}
                selectableSlots={selectableByPlayer[player.id]}
                selectedSlots={selectedByPlayer[player.id]}
                actionMode={['swapPlayers', 'peekLine'].includes(pendingAction?.type) ? 'place' : null}
                actionPopup={actionPopupFor(player.id)}
                actionCardCount={isActionMode ? state.playersAction?.[player.id]?.actionCards?.length || 0 : null}
                onActionCardsClick={isActionMode && (state.playersAction?.[player.id]?.actionCards?.length || 0) > 0
                  ? () => handleOpenPlayerActionCards(player.id)
                  : undefined}
                onSlotClick={(slotIndex) => handleBoardSlotClick(player.id, slotIndex)}
              />
            ))}
          </section>
        )}

        <section ref={centerRef} className="sj-center sj-piles-zone" aria-label="Pioches">
          <div ref={actionPanelRef} className="sj-action-panel">
            <div className="sj-pile-group">
              <PileButton
                ariaLabel="Piocher dans le paquet"
                enabled={canDrawDeck}
                active={canDrawDeck}
                drawnCard={drawnFromDeck ? (drawnCard || { hidden: true }) : null}
                drawnFrom="deck"
                drawnPulse={drawnCardIsMine}
                onClick={() => emitSocket(socket, SOCKET_EVENTS.DRAW_CARD, { source: 'deck' })}
              >
                <Card faceUp={false} size="pile" pulse={canDrawDeck} motionAnchor="pile:deck" />
              </PileButton>

              <PileButton
                ariaLabel={canDiscardDrawn ? 'Défausser la carte tirée' : 'Piocher dans la défausse'}
                enabled={canDrawDiscard || canDiscardDrawn}
                active={canDrawDiscard || canDiscardDrawn}
                tone={canDiscardDrawn ? 'danger' : 'default'}
                drawnCard={drawnFromDiscard ? (drawnCard || { hidden: true }) : null}
                drawnFrom="discard"
                drawnPulse={drawnCardIsMine}
                onClick={handleDiscardClick}
              >
                {state.discardTop ? (
                  <Card value={state.discardTop.value} kind={state.discardTop.kind} faceUp size="pile" pulse={canDrawDiscard || canDiscardDrawn} tone={canDiscardDrawn ? 'danger' : undefined} motionAnchor="pile:discard" />
                ) : (
                  <Card removed size="pile" motionAnchor="pile:discard" />
                )}
              </PileButton>
            </div>
          </div>
        </section>

        <section ref={playColumnRef} className="sj-play-column">
          {me && (
            <div ref={meWrapRef} className="sj-player-zone sj-me-wrap">
              <PlayerBoard
                player={me}
                isMe
                isActive={isMyTurn}
                onSlotClick={handleMySlotClick}
                selectableSlots={selectableByPlayer[myId]}
                selectedSlots={selectedByPlayer[myId]}
                actionMode={pendingAction ? 'place' : boardActionMode}
                actionPopup={actionPopupFor(myId)}
              />
            </div>
          )}
        </section>
      </main>

      {state.phase === 'roundEnd' && roundScoresVisible && (
        <div className="sj-overlay sj-fade-in">
          <section className="sj-lobby-card sj-round-end-card sj-pop-in">
            <h2>Fin de manche {state.roundNumber}</h2>
            <ScoreTable players={state.players} />
            <div className="sj-round-countdown" aria-live="polite">
              <strong>{roundCountdown}</strong>
              <span>Prochaine manche</span>
            </div>
          </section>
        </div>
      )}
      {leaveModal}
      {chatModal}
      {actionDrawModal}
      {defensePromptModal}
      {starGroupChoiceModal}
      {peekLineChoiceModal}
      {drawThreeActionModal}
      {playDiscardActionModal}
      {stealActionPlayerModal}
      {stealActionCardModal}
      {peekResultModal}
      {playerActionCardsModal}
      {actionHandModal}
      {gameGuideModal}
      {gameTutorial}
    </div>
  );
}

function ScoreTable({ players }) {
  return (
    <table className="sj-score-table">
      <thead>
        <tr>
          <th>Joueur</th>
          <th>Manche</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {[...players].sort((a, b) => a.totalScore - b.totalScore).map((player) => (
          <tr key={player.id}>
            <td>{player.name}</td>
            <td>{player.lastRoundScore ?? '-'}</td>
            <td>{player.totalScore}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
