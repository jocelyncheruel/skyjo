import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { ChevronRight, Eye, LogOut, QrCode, ScanLine, Trash2 } from 'lucide-react';
import Card from './components/Card.jsx';
import CardMotionLayer from './components/CardMotionLayer.jsx';
import {
  ActionHandModal,
  DrawThreeActionModal,
  PlayerActionCardsModal,
  PlayDiscardActionModal,
  StealActionCardModal,
  StealActionPlayerModal,
} from './components/ActionCardModals.jsx';
import {
  DefensePromptModal,
  PeekLineChoiceModal,
  PeekResultModal,
  StarGroupChoiceModal,
} from './components/ActionResolutionModals.jsx';
import {
  ConnectionBadge,
  GameToast,
  RoomConnectionView,
  SkyjoLogo,
} from './components/AppChrome.jsx';
import { GameGuideButton, GameGuideModal, GameTutorial } from './components/GameGuide.jsx';
import {
  ActionDrawModal,
  ActionHandDock,
  PileButton,
} from './components/GameTablePieces.jsx';
import PlayerBoard from './components/PlayerBoard.jsx';
import PublicRoomPreviewModal from './components/PublicRoomPreviewModal.jsx';
import {
  RoomAdministrationButton,
  RoomAdministrationModal,
} from './components/RoomAdministration.jsx';
import RoomInviteModal from './components/RoomInviteModal.jsx';
import RoomQrScannerModal, { supportsQrScanner } from './components/RoomQrScannerModal.jsx';
import {
  ChatButton,
  ChatModal,
  countUnreadChatMessages,
  DisconnectedPlayersModal,
  LeaveRoomButton,
  LeaveRoomModal,
  SpectatorBadge,
} from './components/RoomUi.jsx';
import ProfileModal, { ProfileButton } from './ProfileModal.jsx';
import { AuthView, ConsentGate, LegalPage, ResetPasswordView } from './Auth.jsx';
import { useAuth } from './authContext.js';
import { apiFetch, AUTH_REMEMBER_KEY, SERVER_URL } from './apiClient.js';
import { connectErrorUserMessage } from './connectionError.js';
import {
  createRoomInviteUrl,
  extractRoomCodeFromInvite,
  ROOM_CODE_PATTERN,
} from './inviteCode.js';
import { isPublicRoomAvailable, publicRoomSelectionMode } from './publicRooms.js';
import { useAdaptiveBoardSizing } from './useAdaptiveBoardSizing.js';
import { useChatHistoryReload } from './useChatHistoryReload.js';
import {
  ACTION_ART_URLS,
  ACTION_LABELS,
  completeGameTutorial,
  hasCompletedGameTutorial,
} from './gameGuide.js';
import {
  getBoardActionMode,
  getPeekLineCandidates,
  getPeekLineOptions,
  getSelectableSlots,
} from './gameStateSelectors.js';
import {
  SOCKET_EVENTS,
  SOCKET_PROTOCOL_VERSION,
  socketClientPayload,
} from '../../shared/socketProtocol.js';
import { roomVariantLabel } from '../../shared/roomVariants.js';

const AUTO_RECONNECT_TIMEOUT_MS = 5000;
const ROOM_ROLE_KEY = 'sj-room-role';
const ROOM_ROLES = Object.freeze({
  PLAYER: 'player',
  SPECTATOR: 'spectator',
});
const SERIALIZED_GAME_EVENTS = new Set([
  SOCKET_EVENTS.START_GAME,
  SOCKET_EVENTS.RETURN_TO_LOBBY,
  SOCKET_EVENTS.SET_GAME_MODE,
  SOCKET_EVENTS.FLIP_INITIAL,
  SOCKET_EVENTS.DRAW_CARD,
  SOCKET_EVENTS.DECIDE_DRAWN,
  SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE,
  SOCKET_EVENTS.PLACE_CARD,
  SOCKET_EVENTS.REVEAL_CARD,
  SOCKET_EVENTS.PLAY_ACTION_CARD,
  SOCKET_EVENTS.DISCARD_ACTION_CARD,
  SOCKET_EVENTS.RESOLVE_ACTION,
  SOCKET_EVENTS.RESOLVE_DEFENSE,
  SOCKET_EVENTS.RESOLVE_GROUP_CHOICE,
  SOCKET_EVENTS.CLAIM_STAR_ACTION,
]);
const socketsWithPendingGameAction = new WeakSet();

function emitSocket(socket, eventName, payload) {
  if (!socket) return;
  const serialize = SERIALIZED_GAME_EVENTS.has(eventName);
  if (serialize && socketsWithPendingGameAction.has(socket)) return;
  if (serialize) socketsWithPendingGameAction.add(socket);
  const normalizedPayload = socketClientPayload(eventName, payload);
  if (normalizedPayload === undefined) socket.emit(eventName);
  else socket.emit(eventName, normalizedPayload);
}

function releasePendingGameAction(socket) {
  if (socket) socketsWithPendingGameAction.delete(socket);
}

function clearSocketRoomAuth(socket) {
  if (!socket) return;
  socket.auth = {
    ...socket.auth,
    protocolVersion: SOCKET_PROTOCOL_VERSION,
    roomId: '',
    roomRole: ROOM_ROLES.PLAYER,
  };
}

async function serverErrorDetails(response, fallback) {
  try {
    const payload = await response.json();
    const message = typeof payload?.error?.message === 'string'
      ? [...payload.error.message].slice(0, 200).join('')
      : fallback;
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
    const requestId = /^[0-9a-f-]{36}$/i.test(payload?.requestId || '') ? payload.requestId : '';
    return {
      code,
      message: requestId ? `${message} Référence : ${requestId}` : message,
    };
  } catch {
    return { code: '', message: fallback };
  }
}

async function serverErrorMessage(response, fallback) {
  return (await serverErrorDetails(response, fallback)).message;
}

function readRoomInviteFromFragment() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const candidate = params.get('room') || '';
  return ROOM_CODE_PATTERN.test(candidate) ? candidate : '';
}
const SHOW_ALL_ACTION_CARDS_PREVIEW = false;
const MIN_RECONNECT_SCREEN_MS = 1000;
const ACTION_PLAY_POPUP_MS = 3400;
const STARTER_TIE_TOAST_MS = 3500;
const TURN_NOTICE_MS = 3500;
const TURN_VIBRATION_MS = 200;
const MAX_PLAYER_NAME_LENGTH = 20;
const ACTION_CARD_PREVIEWS = Object.keys(ACTION_LABELS).map((type) => ({
  id: `preview-${type}`,
  type,
  preview: true,
}));

function normalizePlayerNameInput(value) {
  return String(value || '').trim().slice(0, MAX_PLAYER_NAME_LENGTH);
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

function savedRoomRole() {
  return readGameValue(ROOM_ROLE_KEY) === ROOM_ROLES.SPECTATOR
    ? ROOM_ROLES.SPECTATOR
    : ROOM_ROLES.PLAYER;
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
  const [initialRoomInvite] = useState(() => readRoomInviteFromFragment());
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
        const termsAccepted = data.termsAccepted === true || data.accepted === true;
        const privacyAccepted = data.privacyAccepted === true || data.accepted === true;
        setConsentVersions({
          termsVersion: data.termsVersion,
          privacyVersion: data.privacyVersion,
          requiredDocuments: [
            ...(!termsAccepted ? ['terms'] : []),
            ...(!privacyAccepted ? ['privacy'] : []),
          ],
        });
        setConsent(termsAccepted && privacyAccepted);
      }
    }).catch(() => {
      if (!cancelled) {
        setConsentVersions(null);
        setConsent(false);
      }
    });
    return () => { cancelled = true; };
  }, [recoveryMode, user]);

  if (!ready) {
    return initialRoomInvite
      ? <RoomConnectionView status="Vérification de votre session" />
      : (
        <RoomConnectionView
          title="Préparation du jeu"
          description="Chargement de votre espace Skyjo..."
          status="Vérification de votre session"
        />
      );
  }
  if (recoveryMode) return <ResetPasswordView />;
  if (!user) return <AuthView />;
  if (consent === null) {
    return initialRoomInvite
      ? <RoomConnectionView status="Préparation de la salle" />
      : (
        <RoomConnectionView
          title="Préparation du jeu"
          description="Chargement de votre espace Skyjo..."
          status="Finalisation de votre session"
        />
      );
  }
  if (!consent) return <ConsentGate
    busy={consentBusy}
    error={consentError}
    requiredDocuments={consentVersions?.requiredDocuments}
    onLogout={logout}
    onAccept={async () => {
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
          body: JSON.stringify({
            ...(consentVersions.requiredDocuments.includes('terms')
              ? { termsVersion: consentVersions.termsVersion }
              : {}),
            ...(consentVersions.requiredDocuments.includes('privacy')
              ? { privacyVersion: consentVersions.privacyVersion }
              : {}),
          }),
        });
        if (!response.ok) throw new Error(await serverErrorMessage(response, 'Impossible d\'enregistrer le consentement.'));
        setConsent(true);
      } catch (error) {
        setConsentError(error.message || 'Impossible d\'enregistrer le consentement.');
      } finally {
        setConsentBusy(false);
      }
    }}
  />;
  return <GameApp />;
}

function GameApp() {
  const { user, logout } = useAuth();
  const accountPlayerName = normalizePlayerNameInput(user?.playerName || user?.firstName || user?.displayName || '');
  const [initialRoomInvite] = useState(() => readRoomInviteFromFragment());
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState(() => (
    initialRoomInvite ? '' : readGameValue('sj-room-id')
  ));
  const [playerName, setPlayerName] = useState(() => normalizePlayerNameInput(readGameValue('sj-player-name') || accountPlayerName));
  const [playerId, setPlayerId] = useState('');
  const [roomRole, setRoomRole] = useState(savedRoomRole);
  const [autoReconnectPending, setAutoReconnectPending] = useState(() => {
    if (initialRoomInvite) return false;
    const savedRoomId = readGameValue('sj-room-id');
    return !!savedRoomId;
  });
  const [joinRoomInput, setJoinRoomInput] = useState(initialRoomInvite);
  const [nameInput, setNameInput] = useState(accountPlayerName || playerName);
  const [roomVisibilityInput, setRoomVisibilityInput] = useState('private');
  const [maxPlayersInput, setMaxPlayersInput] = useState(8);
  const [publicRooms, setPublicRooms] = useState([]);
  const [publicRoomsLoading, setPublicRoomsLoading] = useState(false);
  const [selectedPublicRoom, setSelectedPublicRoom] = useState(null);
  const [publicRoomPreview, setPublicRoomPreview] = useState(null);
  const [publicRoomPreviewLoading, setPublicRoomPreviewLoading] = useState(false);
  const [publicRoomPreviewError, setPublicRoomPreviewError] = useState('');
  const [homePanel, setHomePanel] = useState('home');
  const [profileOpen, setProfileOpen] = useState(false);
  const [qrScannerSupported, setQrScannerSupported] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [state, setState] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatHasMore, setChatHasMore] = useState(false);
  const [chatBefore, setChatBefore] = useState(null);
  const [pendingReconnectState, setPendingReconnectState] = useState(null);
  const [inviteJoinPending, setInviteJoinPending] = useState(() => Boolean(
    initialRoomInvite && normalizePlayerNameInput(accountPlayerName || playerName),
  ));
  const [error, setError] = useState('');
  const [errorSerial, setErrorSerial] = useState(0);
  const autoReconnectPendingRef = useRef(autoReconnectPending);
  const roomRoleRef = useRef(roomRole);
  const autoReconnectStartedAtRef = useRef(0);
  const errorTimerRef = useRef(null);
  const publicRoomsRequestRef = useRef(0);
  const publicRoomPreviewRequestRef = useRef(0);
  const selectedPublicRoomRef = useRef(selectedPublicRoom);
  const inviteJoinAttemptedRef = useRef(false);
  const inviteJoinPendingRef = useRef(inviteJoinPending);
  const initialInvitePlayerNameRef = useRef(normalizePlayerNameInput(accountPlayerName || playerName));
  const closeQrScanner = useCallback(() => setQrScannerOpen(false), []);

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
      setPublicRooms(Array.isArray(data.rooms)
        ? data.rooms.filter(isPublicRoomAvailable)
        : []);
    } catch {
      if (publicRoomsRequestRef.current !== requestId) return;
      setPublicRooms([]);
    } finally {
      if (publicRoomsRequestRef.current === requestId) {
        setPublicRoomsLoading(false);
      }
    }
  }, []);

  const loadPublicRoomPreview = useCallback(async (targetRoomId, { silent = false } = {}) => {
    const requestId = publicRoomPreviewRequestRef.current + 1;
    publicRoomPreviewRequestRef.current = requestId;
    if (!silent) {
      setPublicRoomPreview(null);
      setPublicRoomPreviewError('');
      setPublicRoomPreviewLoading(true);
    }
    try {
      const response = await apiFetch(`/api/rooms/public/${encodeURIComponent(targetRoomId)}/preview`);
      if (!response.ok) {
        const details = await serverErrorDetails(
          response,
          'Impossible de prévisualiser cette partie.',
        );
        if (details.code === 'spectators_disabled') {
          if (publicRoomPreviewRequestRef.current !== requestId) return;
          setSelectedPublicRoom(null);
          setPublicRoomPreview(null);
          setPublicRoomPreviewError('');
          setPublicRoomPreviewLoading(false);
          setPublicRooms((current) => current
            .map((room) => room.roomId === targetRoomId
              ? { ...room, allowSpectators: false }
              : room)
            .filter(isPublicRoomAvailable));
          return;
        }
        throw new Error(details.message);
      }
      const payload = await response.json();
      if (publicRoomPreviewRequestRef.current !== requestId) return;
      setPublicRoomPreview(payload.room || null);
      setPublicRoomPreviewError('');
    } catch (previewError) {
      if (publicRoomPreviewRequestRef.current !== requestId || silent) return;
      setPublicRoomPreviewError(
        previewError instanceof Error
          ? previewError.message
          : 'Impossible de prévisualiser cette partie.',
      );
    } finally {
      if (publicRoomPreviewRequestRef.current === requestId && !silent) {
        setPublicRoomPreviewLoading(false);
      }
    }
  }, []);

  const closePublicRoomPreview = useCallback(() => {
    publicRoomPreviewRequestRef.current += 1;
    setSelectedPublicRoom(null);
    setPublicRoomPreview(null);
    setPublicRoomPreviewError('');
    setPublicRoomPreviewLoading(false);
  }, []);

  useEffect(() => () => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    supportsQrScanner().then((supported) => {
      if (active) setQrScannerSupported(supported);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!initialRoomInvite || !window.location.hash) return;
    window.history.replaceState(
      {},
      document.title,
      `${window.location.pathname}${window.location.search}`,
    );
  }, [initialRoomInvite]);

  useEffect(() => {
    const handleRoomInviteNavigation = () => {
      const invitedRoomId = extractRoomCodeFromInvite(window.location.hash);
      if (invitedRoomId) window.location.reload();
    };
    window.addEventListener('hashchange', handleRoomInviteNavigation);
    return () => window.removeEventListener('hashchange', handleRoomInviteNavigation);
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
    roomRoleRef.current = roomRole;
  }, [roomRole]);

  useEffect(() => {
    if (state || autoReconnectPending || homePanel !== 'public') return undefined;
    const interval = window.setInterval(() => loadPublicRooms({ silent: true }), 5000);
    return () => window.clearInterval(interval);
  }, [autoReconnectPending, homePanel, loadPublicRooms, state]);

  useEffect(() => {
    selectedPublicRoomRef.current = selectedPublicRoom;
  }, [selectedPublicRoom]);

  useEffect(() => {
    const previewRoomId = selectedPublicRoom?.roomId;
    if (!previewRoomId) return undefined;
    loadPublicRoomPreview(previewRoomId);
    if (socket && connected && selectedPublicRoom.allowSpectators !== false) {
      emitSocket(socket, SOCKET_EVENTS.SUBSCRIBE_PUBLIC_PREVIEW, { roomId: previewRoomId });
    }
    return () => {
      if (socket?.connected) {
        emitSocket(socket, SOCKET_EVENTS.UNSUBSCRIBE_PUBLIC_PREVIEW, { roomId: previewRoomId });
      }
    };
  }, [connected, loadPublicRoomPreview, selectedPublicRoom, socket]);

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
    const savedRoomId = initialRoomInvite ? '' : readGameValue('sj-room-id');
    const savedPlayerName = normalizePlayerNameInput(readGameValue('sj-player-name'));
    const initialRoomRole = savedRoomRole();
    let nextSocket;
    let reconnectTimeout;

    const stopReconnectScreen = () => {
      if (!autoReconnectPendingRef.current) return;
      autoReconnectPendingRef.current = false;
      saveGameValue('sj-room-id', '');
      saveGameValue(ROOM_ROLE_KEY, '');
      if (reconnectTimeout) {
        window.clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (nextSocket) {
        nextSocket.auth = {
          ...nextSocket.auth,
          roomId: '',
          roomRole: ROOM_ROLES.PLAYER,
        };
        if (nextSocket.connected || nextSocket.active) {
          nextSocket.disconnect();
          nextSocket.connect();
        }
      }
      setRoomId('');
      setPlayerId('');
      setRoomRole(ROOM_ROLES.PLAYER);
      roomRoleRef.current = ROOM_ROLES.PLAYER;
      setChatMessages([]);
      setChatHasMore(false);
      setChatBefore(null);
      setPendingReconnectState(null);
      setAutoReconnectPending(false);
    };

    const resetRevokedRoomAccess = (message) => {
      saveGameValue('sj-room-id', '');
      saveGameValue(ROOM_ROLE_KEY, '');
      nextSocket.auth = {
        ...nextSocket.auth,
        roomId: '',
        roomRole: ROOM_ROLES.PLAYER,
      };
      setRoomId('');
      setPlayerId('');
      setRoomRole(ROOM_ROLES.PLAYER);
      roomRoleRef.current = ROOM_ROLES.PLAYER;
      setState(null);
      setChatMessages([]);
      setChatHasMore(false);
      setChatBefore(null);
      setJoinRoomInput('');
      setHomePanel('home');
      setAutoReconnectPending(false);
      setPendingReconnectState(null);
      showError(message, 5000);
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
        roomRole: initialRoomRole,
        discoverActiveRoom: !initialRoomInvite && !savedRoomId,
      },
    });
    setSocket(nextSocket);
    nextSocket.on(SOCKET_EVENTS.CONNECT, () => setConnected(true));
    nextSocket.on(SOCKET_EVENTS.DISCONNECT, () => {
      releasePendingGameAction(nextSocket);
      setConnected(false);
    });
    nextSocket.on(SOCKET_EVENTS.CONNECT_ERROR, (connectError) => {
      console.error('[Skyjo] Échec de connexion Socket.IO', connectError);
      const rawMessage = typeof connectError?.message === 'string' ? connectError.message : '';
      showError(connectErrorUserMessage(connectError));
      if (/session invalide|session expirée/iu.test(rawMessage)) void logout();
    });
    nextSocket.on(SOCKET_EVENTS.ERROR, (payload) => {
      releasePendingGameAction(nextSocket);
      const rawMessage = typeof payload === 'string' ? payload : payload?.message;
      const baseMessage = typeof rawMessage === 'string' ? [...rawMessage].slice(0, 200).join('') : 'Action impossible.';
      const requestId = /^[0-9a-f-]{36}$/i.test(payload?.requestId || '') ? payload.requestId : '';
      const message = requestId ? `${baseMessage} Référence : ${requestId}` : baseMessage;
      const code = typeof payload === 'object' ? payload?.code : '';
      showError(message);
      if (selectedPublicRoomRef.current && [
        'room_unavailable',
        'spectators_disabled',
        'room_banned',
      ].includes(code)) {
        setPublicRoomPreview(null);
        setPublicRoomPreviewLoading(false);
        setPublicRoomPreviewError(code === 'spectators_disabled' ? '' : message);
        if (code === 'spectators_disabled' || code === 'room_unavailable') {
          const affectedRoomId = selectedPublicRoomRef.current.roomId;
          setSelectedPublicRoom(null);
          setPublicRooms((current) => current
            .map((room) => code === 'spectators_disabled' && room.roomId === affectedRoomId
              ? { ...room, allowSpectators: false }
              : room)
            .filter((room) => code !== 'room_unavailable' || room.roomId !== affectedRoomId)
            .filter(isPublicRoomAvailable));
        } else if (code === 'room_banned') {
          setSelectedPublicRoom(null);
        }
      }
      if (inviteJoinPendingRef.current && inviteJoinAttemptedRef.current) {
        inviteJoinPendingRef.current = false;
        setInviteJoinPending(false);
      }
      if (code === 'invalid_session') {
        void logout();
        return;
      }
      if (autoReconnectPendingRef.current && (
        code === 'room_unavailable'
        || code === 'seat_unavailable'
        || code === 'room_banned'
        || code === 'spectators_disabled'
        || message === "Impossible de rejoindre cette salle."
      )) {
        stopReconnectScreen();
      } else if (autoReconnectPendingRef.current && code === 'reconnect_failed') {
        stopReconnectScreen();
      }
    });
    nextSocket.on(SOCKET_EVENTS.JOINED, ({ roomId: rid, playerId: pid, role }) => {
      const joinedRole = role === ROOM_ROLES.SPECTATOR
        ? ROOM_ROLES.SPECTATOR
        : ROOM_ROLES.PLAYER;
      setRoomId(rid);
      setPlayerId(joinedRole === ROOM_ROLES.PLAYER ? pid : '');
      setRoomRole(joinedRole);
      roomRoleRef.current = joinedRole;
      saveGameValue('sj-room-id', rid);
      saveGameValue(ROOM_ROLE_KEY, joinedRole);
      nextSocket.auth = {
        protocolVersion: SOCKET_PROTOCOL_VERSION,
        roomId: rid,
        playerName: normalizePlayerNameInput(readGameValue('sj-player-name')),
        roomRole: joinedRole,
        discoverActiveRoom: false,
      };
    });
    const applyRoomState = (nextState) => {
      releasePendingGameAction(nextSocket);
      if (inviteJoinPendingRef.current) {
        inviteJoinPendingRef.current = false;
        setInviteJoinPending(false);
      }
      if (autoReconnectPendingRef.current) {
        setPendingReconnectState(nextState);
      } else {
        setState(nextState);
      }
    };
    nextSocket.on(SOCKET_EVENTS.STATE, applyRoomState);
    nextSocket.on(SOCKET_EVENTS.SPECTATOR_STATE, (nextState) => {
      if (roomRoleRef.current === ROOM_ROLES.SPECTATOR) applyRoomState(nextState);
    });
    nextSocket.on(SOCKET_EVENTS.PUBLIC_PREVIEW_STATE, (nextState) => {
      if (!nextState?.roomId || selectedPublicRoomRef.current?.roomId !== nextState.roomId) return;
      publicRoomPreviewRequestRef.current += 1;
      setPublicRoomPreview(nextState);
      setPublicRoomPreviewError('');
      setPublicRoomPreviewLoading(false);
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
      saveGameValue(ROOM_ROLE_KEY, '');
      setRoomId('');
      setPlayerId('');
      setRoomRole(ROOM_ROLES.PLAYER);
      roomRoleRef.current = ROOM_ROLES.PLAYER;
      setState(null);
      setChatMessages([]);
      showError('Cette salle a expiré après 24 heures d\'inactivité.');
    });
    nextSocket.on(SOCKET_EVENTS.REMOVED_FROM_ROOM, () => {
      resetRevokedRoomAccess('Le propriétaire vous a retiré de la salle.');
    });
    nextSocket.on(SOCKET_EVENTS.ROOM_ACCESS_REVOKED, (payload) => {
      const message = typeof payload?.message === 'string'
        ? [...payload.message].slice(0, 200).join('')
        : 'Votre accès à cette salle a été retiré.';
      resetRevokedRoomAccess(message);
    });
    return () => {
      if (reconnectTimeout) window.clearTimeout(reconnectTimeout);
      nextSocket?.disconnect();
    };
  }, [initialRoomInvite, logout, showError]);

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
        body: JSON.stringify({
          roomVisibility: roomVisibilityInput,
          playerName: name,
          maxPlayers: maxPlayersInput,
        }),
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

  const joinRoomById = useCallback((targetRoomId, role = ROOM_ROLES.PLAYER) => {
    if (!socket || !connected) return;
    const name = normalizePlayerNameInput(nameInput);
    const normalizedRole = role === ROOM_ROLES.SPECTATOR
      ? ROOM_ROLES.SPECTATOR
      : ROOM_ROLES.PLAYER;
    if (normalizedRole === ROOM_ROLES.PLAYER && !name) {
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
    if (normalizedRole === ROOM_ROLES.PLAYER) {
      setPlayerName(name);
      saveGameValue('sj-player-name', name);
    }
    emitSocket(socket, SOCKET_EVENTS.JOIN_ROOM, {
      roomId: normalizedRoomId,
      playerName: normalizedRole === ROOM_ROLES.PLAYER ? name : '',
      role: normalizedRole,
    });
  }, [connected, nameInput, showError, socket]);

  function joinRoom() {
    joinRoomById(joinRoomInput);
  }

  function spectateRoom() {
    joinRoomById(joinRoomInput, ROOM_ROLES.SPECTATOR);
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

  const handleRoomQrScan = useCallback((scannedValue) => {
    const roomCode = extractRoomCodeFromInvite(scannedValue);
    if (!roomCode) return false;
    setJoinRoomInput(roomCode);
    setQrScannerOpen(false);
    joinRoomById(roomCode);
    return true;
  }, [joinRoomById]);

  useEffect(() => {
    const invitePlayerName = initialInvitePlayerNameRef.current;
    if (!initialRoomInvite
      || !invitePlayerName
      || inviteJoinAttemptedRef.current
      || !socket
      || !connected
      || state
      || autoReconnectPending) return;

    inviteJoinAttemptedRef.current = true;
    clearError();
    setPlayerName(invitePlayerName);
    saveGameValue('sj-player-name', invitePlayerName);
    emitSocket(socket, SOCKET_EVENTS.JOIN_ROOM, {
      roomId: initialRoomInvite,
      playerName: invitePlayerName,
    });
  }, [autoReconnectPending, clearError, connected, initialRoomInvite, socket, state]);

  function openPublicRoomsPanel() {
    clearError();
    setHomePanel('public');
    loadPublicRooms();
  }

  function selectPublicRoom(publicRoom) {
    clearError();
    const selectionMode = publicRoomSelectionMode(publicRoom);
    if (selectionMode === 'join') {
      joinRoomById(publicRoom.roomId);
      return;
    }
    if (selectionMode === 'preview') setSelectedPublicRoom(publicRoom);
  }

  function leaveRoom() {
    clearSocketRoomAuth(socket);
    emitSocket(socket, SOCKET_EVENTS.LEAVE_ROOM);
    saveGameValue('sj-room-id', '');
    saveGameValue(ROOM_ROLE_KEY, '');
    setRoomId('');
    setPlayerId('');
    setRoomRole(ROOM_ROLES.PLAYER);
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
    saveGameValue(ROOM_ROLE_KEY, '');
    saveGameValue('sj-player-name', '');
    await logout();
  }

  if (!state) {
    if ((autoReconnectPending && roomId) || inviteJoinPending) {
      return (
        <RoomConnectionView
          connected={connected}
          error={error}
          errorSerial={errorSerial}
          reconnectRoomId={inviteJoinPending ? '' : roomId}
          status={connected && !inviteJoinPending ? 'Synchronisation de la partie' : ''}
        />
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
                      onClick={() => selectPublicRoom(publicRoom)}
                    >
                      <span className="sj-public-room-main">
                        <span className="sj-public-room-title">
                          <strong>{publicRoom.gameMode === 'action' ? 'Skyjo Action' : 'Skyjo classique'}</strong>
                          <span>{roomVariantLabel(publicRoom)}</span>
                        </span>
                        <small>
                          {publicRoom.phase === 'lobby' ? 'Salle d’attente' : 'Partie en cours'}
                          {' · '}
                          administrée par {publicRoom.creatorName || 'un joueur'}
                          {publicRoom.locked ? ' · verrouillée' : ''}
                        </small>
                      </span>
                      <span className="sj-public-room-meta">
                        <strong>{publicRoom.playerCount}/{publicRoom.maxPlayers}</strong>
                      </span>
                      <ChevronRight className="sj-public-room-chevron" aria-hidden="true" size={18} />
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

              <label className="sj-create-room-capacity" htmlFor="create-room-max-players">
                <span>Nombre maximal de joueurs</span>
                <select
                  id="create-room-max-players"
                  value={maxPlayersInput}
                  onChange={(event) => setMaxPlayersInput(Number(event.target.value))}
                >
                  {Array.from({ length: 7 }, (_, index) => index + 2).map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </label>

              <button className="sj-btn sj-btn-primary" disabled={!connected} onClick={createRoom}>
                Créer une salle {roomVisibilityInput === 'public' ? 'publique' : 'privée'}
              </button>

              <div className="sj-divider"><span>ou</span></div>

              <label htmlFor="room-code">Code de la salle à 6 chiffres</label>
              <div className={`sj-room-code-field ${qrScannerSupported ? 'sj-room-code-field-scannable' : ''}`}>
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
                {qrScannerSupported && (
                  <button
                    type="button"
                    className="sj-room-scan-trigger"
                    aria-label="Scanner le QR code d’une salle"
                    title="Scanner une invitation"
                    onClick={() => setQrScannerOpen(true)}
                  >
                    <ScanLine aria-hidden="true" size={21} />
                  </button>
                )}
              </div>
              <div className="sj-room-join-actions">
                <button className="sj-btn" disabled={!canJoinRoom} onClick={joinRoom}>
                  Rejoindre
                </button>
                <button className="sj-btn sj-btn-spectator" disabled={!canJoinRoom} onClick={spectateRoom}>
                  <Eye aria-hidden="true" size={17} />
                  Regarder
                </button>
              </div>

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
      <RoomQrScannerModal
        open={qrScannerOpen}
        onScan={handleRoomQrScan}
        onClose={closeQrScanner}
      />
      {selectedPublicRoom && selectedPublicRoom.allowSpectators !== false && (
        <PublicRoomPreviewModal
          roomMetadata={selectedPublicRoom}
          preview={publicRoomPreview}
          loading={publicRoomPreviewLoading}
          error={publicRoomPreviewError}
          connected={canJoinPublicRoom}
          onClose={closePublicRoomPreview}
          onJoin={() => {
            const targetRoomId = selectedPublicRoom.roomId;
            closePublicRoomPreview();
            joinRoomById(targetRoomId);
          }}
          onWatch={() => {
            const targetRoomId = selectedPublicRoom.roomId;
            closePublicRoomPreview();
            joinRoomById(targetRoomId, ROOM_ROLES.SPECTATOR);
          }}
        />
      )}
      </>
    );
  }

  return (
    <GameScreen
      socket={socket}
      state={state}
      myId={playerId}
      isSpectator={roomRole === ROOM_ROLES.SPECTATOR}
      connected={connected}
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
  socket, state, myId, roomId, isSpectator = false, connected = true,
  error, errorSerial, onLeaveRoom,
  chatMessages = [], chatHasMore = false, onLoadOlderChat,
}) {
  const [copied, setCopied] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [disconnectedPlayersModalOpen, setDisconnectedPlayersModalOpen] = useState(false);
  const [gameGuideOpen, setGameGuideOpen] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(null);
  const [actionHandModalOpen, setActionHandModalOpen] = useState(false);
  const [viewedActionPlayerId, setViewedActionPlayerId] = useState(null);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [roomAdministrationOpen, setRoomAdministrationOpen] = useState(false);
  const [visibleActionPlayId, setVisibleActionPlayId] = useState(null);
  const [roundScoresReady, setRoundScoresReady] = useState(true);
  const [starterTieToast, setStarterTieToast] = useState(null);
  const [peekNow, setPeekNow] = useState(() => Date.now());
  const [dismissedPeekId, setDismissedPeekId] = useState(null);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState(null);
  const [visibleLastTurnNoticeId, setVisibleLastTurnNoticeId] = useState(null);
  const [visibleMyTurnNoticeId, setVisibleMyTurnNoticeId] = useState(null);
  const [roundCountdown, setRoundCountdown] = useState(10);
  const [starClaimModalReady, setStarClaimModalReady] = useState(false);
  const tutorialCheckedRef = useRef(false);
  const [groupChoiceModalReadyId, setGroupChoiceModalReadyId] = useState(null);
  const [cardMotionEndsAt, setCardMotionEndsAt] = useState(0);
  const [visibleRoundRevealId, setVisibleRoundRevealId] = useState(null);
  const [roundRevealEndsAt, setRoundRevealEndsAt] = useState(0);
  const initializedChatRoomRef = useRef('');
  const starterTieToastTimerRef = useRef(null);
  const closeChatModal = useCallback(() => setChatModalOpen(false), []);
  const reloadChatHistory = useCallback(() => {
    emitSocket(socket, SOCKET_EVENTS.LOAD_CHAT_HISTORY, { before: null });
  }, [socket]);
  const closeInviteModal = useCallback(() => setInviteModalOpen(false), []);
  const handleCardMotionBatch = useCallback((endsAt) => {
    if (!Number.isFinite(endsAt)) return;
    setCardMotionEndsAt((current) => Math.max(current, endsAt));
  }, []);
  const inviteUrl = typeof window === 'undefined'
    ? ''
    : createRoomInviteUrl(roomId, window.location.origin);

  const cardMoves = state.cardMoves?.length > 0
    ? state.cardMoves
    : state.lastCardMove ? [state.lastCardMove] : [];
  const starterTieNoticeId = state.starterTieNotice?.id || null;
  const starterTieNoticeMessage = state.starterTieNotice?.message || '';
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
  const spectatorFocusPlayerId = isSpectator
    ? state.currentPlayerId
      || state.order?.[state.turnIndex]
      || state.creatorId
      || boardPlayers[0]?.id
    : null;
  const primaryPlayerId = isSpectator ? spectatorFocusPlayerId : myId;
  const me = boardPlayers.find((player) => player.id === primaryPlayerId);
  const others = boardPlayers.filter((player) => player.id !== primaryPlayerId);
  const isCreator = state.creatorId === myId;
  const chatEnabled = state.roomSettings?.chatEnabled !== false;
  const spectatorCount = Number.isInteger(state.spectatorCount)
    ? Math.max(0, state.spectatorCount)
    : 0;
  useChatHistoryReload({ roomId, enabled: chatEnabled, onReload: reloadChatHistory });
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
  const myTurnNoticeId = isMyTurn && !isSpectator
    ? `${state.roundNumber || 0}-${state.turnSerial ?? `seat-${state.turnIndex}`}-${myId}`
    : null;
  const showMyTurnNotice = !!myTurnNoticeId
    && visibleMyTurnNoticeId === myTurnNoticeId;
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
  const hasActionHandDock = !isSpectator
    && isActionMode
    && state.phase !== 'roundEnd'
    && actionCardsForDisplay.length > 0;
  const viewedActionPlayer = viewedActionPlayerId
    ? state.players.find((player) => player.id === viewedActionPlayerId)
    : null;
  const viewedActionCards = viewedActionPlayerId
    ? state.playersAction?.[viewedActionPlayerId]?.actionCards || []
    : [];
  const pendingAction = state.pendingAction;
  const remainingRemoveEachTargetIds = new Set(
    pendingAction?.type === 'removeEach' ? pendingAction.remaining || [] : [],
  );
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
  if (!isSpectator && myId) selectableByPlayer[myId] = selectableSlots || [];
  if (pendingAction?.mustRespond) {
    if (pendingAction.type === 'removeEach') {
      selectableByPlayer[myId] = [];
      for (const player of state.players) {
        if (!remainingRemoveEachTargetIds.has(player.id)) continue;
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
    spectatorFocusPlayerId,
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
  } = useAdaptiveBoardSizing(state.players.length, layoutKey);

  useEffect(() => {
    if (isSpectator) return;
    if (!['initialFlip', 'playing'].includes(state.phase) || tutorialCheckedRef.current) return;
    tutorialCheckedRef.current = true;
    if (!hasCompletedGameTutorial()) setTutorialStep(0);
  }, [isSpectator, state.phase]);

  useEffect(() => {
    if (!starterTieNoticeId || !starterTieNoticeMessage) {
      if (starterTieToastTimerRef.current) {
        window.clearTimeout(starterTieToastTimerRef.current);
        starterTieToastTimerRef.current = null;
      }
      setStarterTieToast(null);
      return;
    }

    if (starterTieToastTimerRef.current) {
      window.clearTimeout(starterTieToastTimerRef.current);
    }
    setStarterTieToast({
      id: starterTieNoticeId,
      message: starterTieNoticeMessage,
    });
    starterTieToastTimerRef.current = window.setTimeout(() => {
      setStarterTieToast((current) => current?.id === starterTieNoticeId ? null : current);
      starterTieToastTimerRef.current = null;
    }, STARTER_TIE_TOAST_MS);
  }, [starterTieNoticeId, starterTieNoticeMessage]);

  useEffect(() => () => {
    if (starterTieToastTimerRef.current) {
      window.clearTimeout(starterTieToastTimerRef.current);
    }
  }, []);

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
    }, TURN_NOTICE_MS);

    return () => window.clearTimeout(timeout);
  }, [lastTurnNoticeId, state.phase]);

  useEffect(() => {
    if (!myTurnNoticeId) {
      setVisibleMyTurnNoticeId(null);
      return undefined;
    }

    setVisibleMyTurnNoticeId(myTurnNoticeId);
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(TURN_VIBRATION_MS);
      } catch {
        // Certains navigateurs exposent l'API sans autoriser la vibration.
      }
    }

    const timeout = window.setTimeout(() => {
      setVisibleMyTurnNoticeId((currentId) => (
        currentId === myTurnNoticeId ? null : currentId
      ));
    }, TURN_NOTICE_MS);

    return () => window.clearTimeout(timeout);
  }, [myTurnNoticeId]);

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
    if (isSpectator) return;
    if (!invalidPeekFirst) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { peekFirst: null } });
  }, [invalidPeekFirst, isSpectator, socket]);

  useEffect(() => {
    if (isSpectator) return;
    if (!pendingAction?.mustRespond || pendingAction.type !== 'stealAction' || !autoStealTargetId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: autoStealTargetId } });
  }, [autoStealTargetId, isSpectator, pendingAction?.mustRespond, pendingAction?.type, socket]);

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
  }, [latestCardMoveType, motionSequenceEndsAt, state.pendingStarClaim, state.pendingStarClaimId]);

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

  useEffect(() => {
    if (chatEnabled) return;
    setChatModalOpen(false);
  }, [chatEnabled]);

  async function copyRoomCode() {
    const text = inviteUrl;
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

  async function shareRoomInvite() {
    if (!inviteUrl) return;
    const shareData = {
      title: 'Invitation Skyjo',
      text: `Rejoignez ma salle Skyjo ${roomId}.`,
      url: inviteUrl,
    };

    let canUseNativeShare = typeof navigator.share === 'function';
    if (canUseNativeShare && typeof navigator.canShare === 'function') {
      try {
        canUseNativeShare = navigator.canShare(shareData);
      } catch {
        canUseNativeShare = false;
      }
    }

    if (canUseNativeShare) {
      try {
        await navigator.share(shareData);
        return;
      } catch (shareError) {
        if (shareError?.name === 'AbortError') return;
      }
    }

    await copyRoomCode();
  }

  function handleBoardSlotClick(playerId, slotIndex) {
    if (isSpectator) return;
    if (pendingAction?.mustRespond && pendingAction.type === 'removeEach') {
      if (playerId !== myId && remainingRemoveEachTargetIds.has(playerId)) {
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
    if (isSpectator) return;
    if (canDiscardDrawn) {
      emitSocket(socket, SOCKET_EVENTS.DECIDE_DRAWN, { keep: false });
    } else if (canDrawDiscard) {
      emitSocket(socket, SOCKET_EVENTS.DRAW_CARD, { source: 'discard' });
    }
  }

  function handleActionCardSelect(payload) {
    if (isSpectator) return;
    if (state.pendingStarClaim) {
      emitSocket(socket, SOCKET_EVENTS.CLAIM_STAR_ACTION, payload);
    }
  }

  function handlePlayActionCard(cardId) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.PLAY_ACTION_CARD, { cardId });
    setActionHandModalOpen(false);
  }

  function handleDiscardActionCard(cardId) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.DISCARD_ACTION_CARD, { cardId });
    setActionHandModalOpen(false);
  }

  function handleOpenPlayerActionCards(playerId) {
    setViewedActionPlayerId(playerId);
  }

  function handleRemoveEachActionCardSelect(actionCardId) {
    if (isSpectator || !viewedActionPlayerId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { targetPlayerId: viewedActionPlayerId, actionCardId });
    setViewedActionPlayerId(null);
  }

  function handleDefensePrompt(useDefense) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_DEFENSE, { useDefense });
  }

  function handleStarGroupChoice(remove) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_GROUP_CHOICE, { remove });
  }

  function handleDrawThreeChoice(choiceIndex) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { choiceIndex } });
  }

  function handleStealTargetSelect(targetId) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: targetId } });
  }

  function handleStealTargetReset() {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { draft: { stealTargetId: null } });
  }

  function handleStealCardSelect(cardId) {
    if (isSpectator || !stealTargetId) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { targetPlayerId: stealTargetId, cardId });
  }

  function handlePlayDiscardActionSelect(cardId) {
    if (isSpectator) return;
    emitSocket(socket, SOCKET_EVENTS.RESOLVE_ACTION, { cardId });
  }

  function handleOpenChat() {
    if (!chatEnabled) return;
    reloadChatHistory();
    setChatModalOpen(true);
    setLastSeenChatMessageId(latestChatMessageId);
  }

  function handleSendChatMessage(text) {
    if (isSpectator || state.roomSettings?.chatEnabled === false) return;
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
      isSpectator={isSpectator}
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
  const chatButton = chatEnabled ? (
    <ChatButton unreadCount={unreadChatCount} onClick={handleOpenChat} />
  ) : null;
  const roomAdministrationButton = isCreator ? (
    <RoomAdministrationButton onClick={() => setRoomAdministrationOpen(true)} />
  ) : null;
  const roomAdministrationModal = isCreator ? (
    <RoomAdministrationModal
      open={roomAdministrationOpen}
      state={state}
      myId={myId}
      onClose={() => setRoomAdministrationOpen(false)}
      onSave={(settings) => emitSocket(socket, SOCKET_EVENTS.UPDATE_ROOM_SETTINGS, settings)}
      onTransfer={(targetPlayerId) => emitSocket(
        socket,
        SOCKET_EVENTS.TRANSFER_ROOM_OWNERSHIP,
        { playerId: targetPlayerId },
      )}
      onKick={(targetPlayerId) => emitSocket(
        socket,
        SOCKET_EVENTS.KICK_ROOM_PLAYER,
        { playerId: targetPlayerId },
      )}
      onBan={(targetPlayerId) => emitSocket(
        socket,
        SOCKET_EVENTS.BAN_ROOM_PLAYER,
        { playerId: targetPlayerId },
      )}
    />
  ) : null;
  const spectatorBadge = spectatorCount > 0 ? (
    <SpectatorBadge connected={connected} count={spectatorCount} />
  ) : null;
  const chatModal = (
    <ChatModal
      open={chatEnabled && chatModalOpen}
      messages={chatMessages}
      hasMore={chatHasMore}
      myId={myId}
      onClose={closeChatModal}
      onSend={handleSendChatMessage}
      onLoadMore={onLoadOlderChat}
      readOnly={isSpectator}
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
        && remainingRemoveEachTargetIds.has(viewedActionPlayerId)}
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
        <div className="sj-app-shell sj-lobby-room sj-room-controls-layout">
          {leaveButton}
          {chatButton}
          {roomAdministrationButton}
          {spectatorBadge}
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-fade-in">
            <div className="sj-room-head">
              <span>Salle</span>
              <span className="sj-room-copy-wrap">
                <span className="sj-room-code-copy">
                  <button type="button" className={`sj-room-copy ${copied ? 'sj-room-copy-copied' : ''}`} onClick={copyRoomCode}>{roomId}</button>
                  {copied && (
                    <span className="sj-copy-toast" role="status" aria-live="polite" aria-label="Lien d’invitation copié">
                      ✓
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="sj-room-qr-trigger"
                  aria-label="Afficher le QR code d’invitation"
                  title="Afficher le QR code d’invitation"
                  onClick={() => setInviteModalOpen(true)}
                >
                  <QrCode aria-hidden="true" size={20} />
                </button>
              </span>
            </div>
            <p className={`sj-room-visibility-badge ${state.roomVisibility === 'public' ? 'sj-room-visibility-badge-public' : ''}`}>
              {state.roomVisibility === 'public' ? 'Salle publique' : 'Salle privée'}
              {' · '}
              {state.players.length}/{state.roomSettings?.maxPlayers || 8} joueurs
              {' · '}
              {roomVariantLabel(state.roomSettings)}
              {state.roomSettings?.locked ? ' · Verrouillée' : ''}
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
            ) : isSpectator ? (
              <p className="sj-hint">Vous regardez la salle en lecture seule.</p>
            ) : !isCreator && (
              <p className="sj-hint">En attente de lancement par le créateur</p>
            )}
          </section>
        </div>
        {leaveModal}
        {chatModal}
        {roomAdministrationModal}
        {disconnectedPlayersModal}
        {gameGuideModal}
        {gameTutorial}
        <RoomInviteModal
          open={inviteModalOpen}
          roomId={roomId}
          inviteUrl={inviteUrl}
          copied={copied}
          onCopy={copyRoomCode}
          onShare={shareRoomInvite}
          onClose={closeInviteModal}
        />
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
        <div className="sj-app-shell sj-lobby-room sj-room-controls-layout">
          {leaveButton}
          {chatButton}
          {roomAdministrationButton}
          {spectatorBadge}
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
        {roomAdministrationModal}
      </>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`sj-app-shell ${state.players.length === 2 ? 'sj-two-player-game' : ''} ${isActionMode ? 'sj-action-game' : ''} ${hasActionHandDock ? 'sj-action-hand-visible' : ''} ${layoutClassName} ${layoutReady ? '' : 'sj-layout-pending'}`}
    >
      <CardMotionLayer
        state={state}
        enabled={layoutReady}
        onMotionBatch={handleCardMotionBatch}
        anchorRootRef={shellRef}
        coordinateRootRef={shellRef}
        portalRootRef={shellRef}
      />
      <div className="sj-game-controls" aria-label="Contrôles de la partie">
        {spectatorBadge}
        {chatButton}
        {roomAdministrationButton}
        {leaveButton}
      </div>
      {hasActionHandDock && (
        <ActionHandDock
          cards={actionCardsForDisplay}
          onClick={() => setActionHandModalOpen(true)}
        />
      )}
      <GameToast
        key={error ? `error-${errorSerial}` : `starter-${starterTieToast?.id || 'none'}`}
        message={error || starterTieToast?.message}
        tone={error ? 'error' : 'info'}
      />
      {(showLastTurnNotice || showMyTurnNotice) && (
        <div className="sj-turn-notice-stack">
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
          {showMyTurnNotice && (
            <div className="sj-last-turn-notice sj-my-turn-notice" aria-live="assertive">
              <span className="sj-last-turn-kicker">À votre tour</span>
              <strong>C’est à vous de jouer !</strong>
            </div>
          )}
        </div>
      )}

      <main ref={boardAreaRef} className="sj-board-area">
        {others.length > 0 && (
          <section
            ref={opponentsRef}
            className={`sj-player-zone sj-opponents sj-opponents-count-${Math.min(others.length, 4)}`}
            aria-label={isSpectator ? 'Joueurs' : 'Adversaires'}
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
                isActive={isSpectator
                  ? state.phase === 'playing' && me.id === state.currentPlayerId
                  : isMyTurn}
                onSlotClick={handleMySlotClick}
                selectableSlots={isSpectator ? [] : selectableByPlayer[myId]}
                selectedSlots={isSpectator ? [] : selectedByPlayer[myId]}
                actionMode={isSpectator ? null : pendingAction ? 'place' : boardActionMode}
                actionPopup={actionPopupFor(me.id)}
                actionCardCount={isSpectator && isActionMode
                  ? state.playersAction?.[me.id]?.actionCards?.length || 0
                  : null}
                onActionCardsClick={isSpectator
                  && isActionMode
                  && (state.playersAction?.[me.id]?.actionCards?.length || 0) > 0
                  ? () => handleOpenPlayerActionCards(me.id)
                  : undefined}
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
      {roomAdministrationModal}
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
