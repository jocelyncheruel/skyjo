import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { LogOut, MessageCircle, Send, X } from 'lucide-react';
import Card from './components/Card.jsx';
import PlayerBoard from './components/PlayerBoard.jsx';

function getServerUrl() {
  const configuredUrl = import.meta.env.VITE_SERVER_URL?.trim();
  const fallbackPort = '4000';

  if (typeof window === 'undefined') {
    return configuredUrl || `http://localhost:${fallbackPort}`;
  }

  const { protocol, hostname } = window.location;
  if (!configuredUrl) {
    return `${protocol}//${hostname}:${fallbackPort}`;
  }

  const url = new URL(configuredUrl);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const pageIsLocal = localHosts.has(hostname);

  if (localHosts.has(url.hostname) && !pageIsLocal) {
    url.hostname = hostname;
    url.protocol = protocol;
  }

  return url.toString().replace(/\/$/, '');
}

const SERVER_URL = getServerUrl();
const CARD_HEIGHT_RATIO = 122 / 88;
const OPPONENT_BOARD_GAP = 8;
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
const ACTION_LABELS = {
  removeEach: 'Retirer une carte à chaque joueur',
  swapOwn: 'Échanger deux de vos cartes',
  extraTurns: 'Jouer deux tours supplémentaires',
  drawThree: 'Piocher trois cartes',
  peekLine: 'Regarder une ligne ou une colonne',
  defense: 'Défense et tour supplémentaire',
  playDiscard: 'Jouer une Action défaussée',
  stealAction: 'Voler et jouer une Action',
  swapPlayers: 'Échanger des cartes entre joueurs',
};

const ACTION_ART_URLS = {
  removeEach: '/action-cards/remove-each.jpg',
  swapOwn: '/action-cards/swap-own.jpg',
  extraTurns: '/action-cards/extra-turns.jpg',
  drawThree: '/action-cards/draw-three.jpg',
  peekLine: '/action-cards/peek-line.jpg',
  defense: '/action-cards/defense.jpg',
  playDiscard: '/action-cards/play-discard.jpg',
  stealAction: '/action-cards/steal-action.jpg',
  swapPlayers: '/action-cards/swap-players.jpg',
};

const SHOW_ALL_ACTION_CARDS_PREVIEW = false;
const MIN_RECONNECT_SCREEN_MS = 1000;
const CHAT_GROUP_WINDOW_MS = 2 * 60 * 1000;
const ACTION_PLAY_POPUP_MS = 3400;
const ACTION_CARD_PREVIEWS = Object.keys(ACTION_LABELS).map((type) => ({
  id: `preview-${type}`,
  type,
  preview: true,
}));

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readPx(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setPxVar(element, name, value) {
  const nextValue = `${Math.round(value)}px`;
  const currentValue = element.style.getPropertyValue(name);
  const currentNumber = Number.parseFloat(currentValue);
  const nextNumber = Number.parseFloat(nextValue);

  if (Number.isFinite(currentNumber) && Math.abs(currentNumber - nextNumber) <= 1) {
    return;
  }

  if (currentValue !== nextValue) {
    element.style.setProperty(name, nextValue);
  }
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

function boardMetrics(cardWidth, {
  topMargin = true,
  bottomMargin = false,
  opponent = false,
  compactOpponent = false,
} = {}) {
  const cardWidthPx = Math.round(cardWidth);
  const cardHeight = Math.round(cardWidthPx * CARD_HEIGHT_RATIO);
  const gridGap = Math.round(clampNumber(cardWidthPx * 0.085, 2, 8));
  const pad = Math.round(clampNumber(cardWidthPx * 0.16, 5, 16));
  const blockGap = Math.round(clampNumber(cardWidthPx * 0.1, 4, 8));
  const header = compactOpponent
    ? Math.round(clampNumber(cardWidthPx * 0.56, 22, 28))
    : opponent
    ? Math.round(clampNumber(cardWidthPx * 0.62, 30, 38))
    : Math.round(clampNumber(cardWidthPx * 0.4, 26, 34));
  const scoreBadgeHeight = Math.round(clampNumber(cardWidthPx * 0.54, 30, 50));
  const flowGap = Math.round(clampNumber(cardWidthPx * 0.14, 6, 14));
  const externalTop = topMargin ? scoreBadgeHeight / 2 + flowGap : 0;
  const externalBottom = bottomMargin ? flowGap : 0;

  return {
    cardWidth: cardWidthPx,
    cardHeight,
    gridGap,
    pad,
    blockGap,
    header,
    width: cardWidthPx * 4 + gridGap * 3 + pad * 2 + 2,
    height: cardHeight * 3 + gridGap * 2 + header + blockGap + pad * 2 + 2 + externalTop + externalBottom,
  };
}

function fitBoardCardWidth(widthBudget, heightBudget, min, max, options) {
  let low = min;
  let high = max;

  for (let index = 0; index < 14; index += 1) {
    const middle = (low + high) / 2;
    const metrics = boardMetrics(middle, options);
    if (metrics.width <= widthBudget && metrics.height <= heightBudget) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return low;
}

function useAdaptiveBoardSizing(playerCount, layoutKey) {
  const shellRef = useRef(null);
  const boardAreaRef = useRef(null);
  const opponentsRef = useRef(null);
  const playColumnRef = useRef(null);
  const meWrapRef = useRef(null);
  const centerRef = useRef(null);
  const actionPanelRef = useRef(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const layoutReadyRef = useRef(false);
  const measuredViewportRef = useRef({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const frames = new Set();
    let disposed = false;

    const measure = ({ reveal = true, force = false } = {}) => {
        const shell = shellRef.current;
        const boardArea = boardAreaRef.current;
        const playColumn = playColumnRef.current;
        if (!shell || !boardArea || !playColumn) return;

        const shellRect = shell.getBoundingClientRect();
        const viewportWidth = Math.round(shellRect.width || window.innerWidth);
        const viewportHeight = Math.round(shellRect.height || window.innerHeight);
        const lastViewport = measuredViewportRef.current;
        const mobileLayout = viewportWidth < 900;
        const viewportWidthDelta = Math.abs(viewportWidth - lastViewport.width);
        const viewportHeightDelta = Math.abs(viewportHeight - lastViewport.height);
        const widthChanged = viewportWidthDelta > (mobileLayout ? 8 : 2);
        const heightChanged = viewportHeightDelta > (mobileLayout ? 16 : 2);

        if (
          !force
          && layoutReadyRef.current
          && mobileLayout
          && !widthChanged
          && !heightChanged
        ) {
          return;
        }

        measuredViewportRef.current = { width: viewportWidth, height: viewportHeight };
        const desktopPiles = viewportWidth >= 900 && viewportHeight >= 620;
        const opponentCount = Math.max(0, playerCount - 1);
        const compactMe = viewportWidth <= 640;
        const compactOpponents = viewportWidth <= 640;
        const compactTwoPlayer = compactOpponents && opponentCount === 1 && !desktopPiles;

        const playRect = playColumn.getBoundingClientRect();
        const boardAreaRect = boardArea.getBoundingClientRect();
        const meWrapRect = meWrapRef.current?.getBoundingClientRect();
        const centerRect = centerRef.current?.getBoundingClientRect();
        const actionPanelRect = actionPanelRef.current?.getBoundingClientRect();
        const playStyles = getComputedStyle(playColumn);
        const playGap = readPx(playStyles.rowGap || playStyles.gap);
        const pileCardWidth = desktopPiles
          ? clampNumber(Math.min(viewportWidth * 0.075, viewportHeight * 0.13), 62, 96)
          : clampNumber(Math.min((viewportWidth - 56) / 2.6, viewportHeight * 0.115), 46, 70);
        const estimatedPileHeight = Math.round(pileCardWidth * CARD_HEIGHT_RATIO + 20);
        const centerFlowHeight = desktopPiles
          ? 0
          : Math.max(centerRect?.height || 0, compactTwoPlayer ? estimatedPileHeight : 0);
        const pilesFlowHeight = desktopPiles ? 0 : centerFlowHeight + playGap;
        const meAvailableHeight = desktopPiles
          ? (meWrapRect?.height || playRect.height)
          : Math.max(
            meWrapRect?.height || 0,
            playRect.height - pilesFlowHeight
          );
        const meHeightBudget = Math.round(Math.max(
          96,
          meAvailableHeight - (desktopPiles ? 2 : 0)
        ));
        const sideReserve = desktopPiles
          ? (actionPanelRect?.width || 120) + clampNumber(viewportWidth * 0.05, 44, 96)
          : 0;
        const meWidthBudget = Math.round(desktopPiles
          ? viewportWidth - sideReserve
          : Math.min(boardAreaRect.width || viewportWidth, viewportWidth - sideReserve));
        const meMin = compactMe ? (viewportHeight < 560 ? 24 : 28) : viewportHeight < 560 ? 32 : viewportHeight < 700 ? 38 : 44;
        const meMax = compactMe ? 88 : desktopPiles ? 120 : 82;
        const meCardWidth = fitBoardCardWidth(meWidthBudget, meHeightBudget, meMin, meMax, {
          topMargin: false,
          bottomMargin: false,
        });
        let meMetrics = boardMetrics(meCardWidth, {
          topMargin: false,
          bottomMargin: false,
        });

        const opponentMin = compactOpponents ? (viewportHeight < 620 ? 22 : 24) : 12;
        const opponentMax = compactOpponents ? (opponentCount <= 1 ? 46 : 42) : desktopPiles ? 44 : 38;
        let opponentCardWidth = clampNumber(
          viewportHeight * (compactOpponents ? 0.052 : 0.046),
          opponentMin,
          opponentMax
        );
        const opponents = opponentsRef.current;
        if (opponents && opponentCount > 0) {
          const opponentsRect = opponents.getBoundingClientRect();
          const opponentsScrollRail = compactOpponents;
          const perRow = opponentsScrollRail ? 1 : opponentCount;
          const rowCount = 1;
          const totalOpponentsBudget = Math.min(
            boardAreaRect.height * (compactOpponents ? 0.33 : desktopPiles ? 0.4 : 0.34),
            viewportHeight * (compactOpponents ? 0.3 : desktopPiles ? 0.31 : 0.27)
          );
          const rowBudget = Math.floor(totalOpponentsBudget / rowCount);
          const boardWidthBudget = opponentsScrollRail
            ? Math.floor(Math.min(
              opponentsRect.width * (opponentCount <= 1 ? 0.9 : 0.62),
              viewportWidth * (opponentCount <= 1 ? 0.9 : 0.62),
              opponentCount <= 1 ? 260 : 230
            ))
            : Math.floor((
              opponentsRect.width - (perRow - 1) * OPPONENT_BOARD_GAP
            ) / perRow);
          opponentCardWidth = fitBoardCardWidth(
            boardWidthBudget,
            rowBudget,
            opponentMin,
            opponentMax,
            { topMargin: false, opponent: true, compactOpponent: compactOpponents }
          );
        }
        let opponentMetrics = boardMetrics(opponentCardWidth, {
          topMargin: false,
          opponent: true,
          compactOpponent: compactOpponents,
        });
        if (compactTwoPlayer) {
          const sharedHeightBudget = Math.round(Math.max(
            96,
            (boardAreaRect.height - centerFlowHeight - playGap * 2) / 2
          ));
          const sharedWidthBudget = Math.round(Math.min(
            boardAreaRect.width || viewportWidth,
            viewportWidth
          ));
          const sharedCardWidth = fitBoardCardWidth(
            sharedWidthBudget,
            sharedHeightBudget,
            meMin,
            meMax,
            { topMargin: false, bottomMargin: false }
          );
          const sharedMetrics = boardMetrics(sharedCardWidth, {
            topMargin: false,
            bottomMargin: false,
          });
          meMetrics = sharedMetrics;
          opponentMetrics = sharedMetrics;
        }

        setPxVar(shell, '--sj-me-card-width', meMetrics.cardWidth);
        setPxVar(shell, '--sj-me-card-height', meMetrics.cardHeight);
        setPxVar(shell, '--sj-me-grid-gap', meMetrics.gridGap);
        setPxVar(shell, '--sj-me-board-pad', meMetrics.pad);
        setPxVar(shell, '--sj-me-board-block-gap', meMetrics.blockGap);
        setPxVar(shell, '--sj-me-board-header-height', meMetrics.header);
        setPxVar(shell, '--sj-two-player-board-header-height', meMetrics.header);
        setPxVar(shell, '--sj-opp-card-width', opponentMetrics.cardWidth);
        setPxVar(shell, '--sj-opp-card-height', opponentMetrics.cardHeight);
        setPxVar(shell, '--sj-opp-grid-gap', opponentMetrics.gridGap);
        setPxVar(shell, '--sj-opp-board-pad', opponentMetrics.pad);
        setPxVar(shell, '--sj-opp-board-block-gap', opponentMetrics.blockGap);
        setPxVar(shell, '--sj-opp-board-header-height', opponentMetrics.header);
        setPxVar(shell, '--sj-pile-card-width', pileCardWidth);
        setPxVar(shell, '--sj-app-height', viewportHeight);
        if (reveal && !disposed && !layoutReadyRef.current) {
          layoutReadyRef.current = true;
          setLayoutReady(true);
        }
    };

    const update = ({ reveal = true, force = false } = {}) => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        measure({ reveal, force });
      });
      frames.add(frame);
    };

    measure({ reveal: layoutReadyRef.current, force: true });
    update({ reveal: true, force: true });

    const handleResize = () => update({ reveal: true });
    const handleOrientationChange = () => update({ reveal: true, force: true });

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);

    return () => {
      disposed = true;
      frames.forEach((frame) => cancelAnimationFrame(frame));
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
    };
  }, [playerCount, layoutKey]);

  return {
    shellRef,
    boardAreaRef,
    opponentsRef,
    playColumnRef,
    meWrapRef,
    centerRef,
    actionPanelRef,
    layoutReady,
  };
}

function usePersistentId() {
  const [id, setId] = useState(() => localStorage.getItem('sj-player-id') || sessionStorage.getItem('sj-player-id') || '');
  const save = (value) => {
    if (value) {
      localStorage.setItem('sj-player-id', value);
      sessionStorage.setItem('sj-player-id', value);
    } else {
      localStorage.removeItem('sj-player-id');
      sessionStorage.removeItem('sj-player-id');
    }
    setId(value);
  };
  return [id, save];
}

function readPlayerSessionToken() {
  return localStorage.getItem('sj-player-token') || sessionStorage.getItem('sj-player-token') || '';
}

function savePlayerSessionToken(value) {
  if (value) {
    localStorage.setItem('sj-player-token', value);
    sessionStorage.setItem('sj-player-token', value);
  } else {
    localStorage.removeItem('sj-player-token');
    sessionStorage.removeItem('sj-player-token');
  }
}

export default function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [roomId, setRoomId] = useState(() => localStorage.getItem('sj-room-id') || sessionStorage.getItem('sj-room-id') || '');
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('sj-player-name') || sessionStorage.getItem('sj-player-name') || '');
  const [playerId, setPlayerId] = usePersistentId();
  const [autoReconnectPending, setAutoReconnectPending] = useState(() => {
    const savedRoomId = localStorage.getItem('sj-room-id') || sessionStorage.getItem('sj-room-id') || '';
    const savedPlayerId = localStorage.getItem('sj-player-id') || sessionStorage.getItem('sj-player-id') || '';
    return !!savedRoomId && !!savedPlayerId;
  });
  const [joinRoomInput, setJoinRoomInput] = useState('');
  const [nameInput, setNameInput] = useState(playerName);
  const [roomVisibilityInput, setRoomVisibilityInput] = useState('private');
  const [publicRooms, setPublicRooms] = useState([]);
  const [publicRoomsLoading, setPublicRoomsLoading] = useState(false);
  const [homePanel, setHomePanel] = useState('home');
  const [homePanelHeight, setHomePanelHeight] = useState(0);
  const [state, setState] = useState(null);
  const [pendingReconnectState, setPendingReconnectState] = useState(null);
  const [error, setError] = useState('');
  const [errorSerial, setErrorSerial] = useState(0);
  const autoReconnectPendingRef = useRef(autoReconnectPending);
  const autoReconnectStartedAtRef = useRef(autoReconnectPending ? Date.now() : 0);
  const errorTimerRef = useRef(null);
  const publicRoomsRequestRef = useRef(0);
  const homeCardRef = useRef(null);

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
      const res = await fetch(`${SERVER_URL}/api/rooms/public`);
      if (!res.ok) throw new Error('Impossible de charger les salles publiques.');
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

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      document.activeElement?.blur?.();
    };

    const handlePointerUp = (event) => {
      if (!(event.target instanceof Element)) return;
      const focusableControl = event.target.closest('button, [role="button"], a[href], summary');
      if (!focusableControl) return;
      window.requestAnimationFrame(() => focusableControl.blur?.());
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
    };
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
    const savedRoomId = localStorage.getItem('sj-room-id') || sessionStorage.getItem('sj-room-id') || '';
    const savedPlayerId = localStorage.getItem('sj-player-id') || sessionStorage.getItem('sj-player-id') || '';
    const savedPlayerName = localStorage.getItem('sj-player-name') || sessionStorage.getItem('sj-player-name') || '';
    const savedSessionToken = readPlayerSessionToken();
    const nextSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      auth: {
        roomId: savedRoomId,
        playerId: savedPlayerId,
        playerName: savedPlayerName,
        sessionToken: savedSessionToken,
      },
    });
    setSocket(nextSocket);
    nextSocket.on('connect', () => setConnected(true));
    nextSocket.on('disconnect', () => setConnected(false));
    nextSocket.on('errorMsg', (message) => {
      showError(message);
      if (autoReconnectPendingRef.current && (
        message === "Cette salle n'existe pas."
        || message === 'La partie a déjà commencé.'
        || message === 'Session invalide. Rejoignez à nouveau la salle.'
      )) {
        localStorage.removeItem('sj-room-id');
        sessionStorage.removeItem('sj-room-id');
        savePlayerSessionToken('');
        setRoomId('');
        setPlayerId('');
        setAutoReconnectPending(false);
        setPendingReconnectState(null);
      }
    });
    nextSocket.on('joined', ({ roomId: rid, playerId: pid, sessionToken }) => {
      setRoomId(rid);
      setPlayerId(pid);
      if (sessionToken) savePlayerSessionToken(sessionToken);
      localStorage.setItem('sj-room-id', rid);
      sessionStorage.setItem('sj-room-id', rid);
      nextSocket.auth = {
        roomId: rid,
        playerId: pid,
        sessionToken: sessionToken || readPlayerSessionToken(),
        playerName: localStorage.getItem('sj-player-name') || sessionStorage.getItem('sj-player-name') || playerName || nameInput,
      };
    });
    nextSocket.on('state', (nextState) => {
      if (autoReconnectPendingRef.current) {
        setPendingReconnectState(nextState);
      } else {
        setState(nextState);
      }
    });
    return () => nextSocket.disconnect();
  }, []);

  useEffect(() => {
    if (socket && connected && roomId && playerId) {
      const sessionToken = readPlayerSessionToken();
      socket.auth = { roomId, playerId, sessionToken, playerName: playerName || nameInput };
      socket.emit('joinRoom', { roomId, playerId, sessionToken, playerName: playerName || nameInput });
    }
  }, [socket, connected, roomId, playerId]);

  async function createRoom() {
    if (!socket || !connected) return;
    const name = nameInput.trim();
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    clearError();
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomVisibility: roomVisibilityInput }),
      });
      if (!res.ok) throw new Error('Impossible de créer la salle.');
      const data = await res.json();
      setPlayerName(name);
      localStorage.setItem('sj-player-name', name);
      sessionStorage.setItem('sj-player-name', name);
      socket.emit('joinRoom', { roomId: data.roomId, playerName: name });
    } catch (err) {
      showError(err.message || 'Serveur indisponible.');
    }
  }

  function joinRoomById(targetRoomId) {
    if (!socket || !connected) return;
    const name = nameInput.trim();
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
    const normalizedRoomId = String(targetRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (normalizedRoomId.length !== 6) {
      showError('Le code de salle doit contenir 6 chiffres.');
      return;
    }
    setPlayerName(name);
    localStorage.setItem('sj-player-name', name);
    sessionStorage.setItem('sj-player-name', name);
    socket.emit('joinRoom', { roomId: normalizedRoomId, playerName: name });
  }

  function joinRoom() {
    joinRoomById(joinRoomInput);
  }

  function openPublicRoomsPanel() {
    const name = nameInput.trim();
    if (!name) {
      showError('Votre nom est obligatoire.');
      return;
    }
    clearError();
    const currentHeight = homeCardRef.current?.getBoundingClientRect?.().height || 0;
    setHomePanelHeight(Math.round(currentHeight));
    setHomePanel('public');
    loadPublicRooms();
  }

  function leaveRoom() {
    socket?.emit('leaveRoom');
    localStorage.removeItem('sj-room-id');
    sessionStorage.removeItem('sj-room-id');
    savePlayerSessionToken('');
    setRoomId('');
    setPlayerId('');
    setState(null);
    setJoinRoomInput('');
    setHomePanel('home');
    clearError();
    setAutoReconnectPending(false);
    setPendingReconnectState(null);
  }

  if (!state) {
    if (autoReconnectPending && roomId && playerId) {
      return (
        <div className="sj-lobby">
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-reconnect-card sj-pop-in">
            <div className="sj-brand-mark"><SkyjoLogo /></div>
            <div className="sj-reconnect-spinner" aria-hidden="true" />
            <h1>Reconnexion</h1>
            <p className="sj-lobby-copy">Retour dans la salle {roomId}…</p>
            <p className={`sj-connection ${connected ? 'sj-connection-ok' : ''}`}>
              {connected ? 'Synchronisation de la partie' : 'Connexion au serveur'}
            </p>
          </section>
        </div>
      );
    }

    const canJoinRoom = connected && joinRoomInput.length === 6;
    const canJoinPublicRoom = connected;

    return (
      <div className="sj-app-shell sj-lobby-room">
        <GameToast key={errorSerial} message={error} />
        {homePanel === 'public' ? (
          <section
            key="public-rooms"
            className="sj-lobby-card sj-home-card sj-public-search-card"
            style={homePanelHeight ? { '--sj-home-panel-height': `${homePanelHeight}px` } : undefined}
          >
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
                  {publicRoomsLoading ? 'Chargement des parties publiques…' : 'Aucune partie publique disponible.'}
                </p>
              )}
            </section>

            <button type="button" className="sj-public-search-trigger sj-public-search-trigger-back" onClick={() => setHomePanel('home')}>
              Retour à l’accueil
              <span aria-hidden="true">←</span>
            </button>
          </section>
        ) : (
          <section key="home" ref={homeCardRef} className="sj-lobby-card sj-home-card">
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
                  setNameInput(event.target.value);
                  if (error === 'Votre nom est obligatoire.' && event.target.value.trim()) clearError();
                }}
                placeholder="Pseudo"
                autoComplete="nickname"
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

              <label htmlFor="room-code">Code de la salle</label>
              <input
                id="room-code"
                value={joinRoomInput}
                onChange={(event) => setJoinRoomInput(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                pattern="[0-9]*"
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
        )}
      </div>
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
      .map((slot, index) => (!slot.removed ? index : -1))
      .filter((index) => index >= 0);
  }

  if (first.playerId !== player.id) return [];

  const rowIndex = Math.floor(first.slotIndex / BOARD_COLUMNS);
  const columnIndex = first.slotIndex % BOARD_COLUMNS;
  const candidateIndexes = new Set([
    ...BOARD_ROWS[rowIndex],
    ...BOARD_COLUMN_GROUPS[columnIndex],
  ]);
  candidateIndexes.delete(first.slotIndex);

  return [...candidateIndexes].filter((index) => !player.board[index]?.removed);
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
  myId,
  onClose,
  onSend,
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

function PeekResultModal({ peek, onClose }) {
  if (!peek) return null;

  const groupLabel = peek.groupType === 'row' ? 'ligne' : 'colonne';

  return (
    <div className="sj-modal-overlay sj-fade-in">
      <section
        className="sj-confirm-modal sj-peek-result-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="peek-result-title"
      >
        <h2 id="peek-result-title">
          {groupLabel === 'ligne' ? 'Ligne' : 'Colonne'} de {peek.targetPlayerName}
        </h2>
        <div className={`sj-star-group-snapshot sj-star-group-${peek.groupType}`} aria-label={`Aperçu privé de la ${groupLabel}`}>
          {peek.cards.map((card) => (
            <Card
              key={card.slotIndex}
              value={card.value}
              kind={card.kind}
              faceUp={!card.removed}
              removed={card.removed}
              size="pile"
            />
          ))}
        </div>
        <div className="sj-modal-actions">
          <button type="button" className="sj-btn sj-btn-primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </section>
    </div>
  );
}

function ActionDrawModal({
  open,
  market = [],
  onSelect,
  onClose,
  title = 'Choisir une carte Action',
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
        className="sj-action-draw-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-draw-title"
        tabIndex={-1}
      >
        <div className="sj-action-draw-modal-head">
          <div>
            <h2 id="action-draw-title">{title}</h2>
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
            <div className="sj-action-hand-modal-item">
              <button
                type="button"
                className="sj-action-deck"
                onClick={() => onSelect({ source: 'deck' })}
              >
                <span>Face cachée</span>
                <strong>Pioche Action</strong>
              </button>
            </div>
            {market.map((card, index) => (
              <div key={card.id} className="sj-action-hand-modal-item">
                <ActionTile
                  card={card}
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

function ActionHandDock({ cards, onClick }) {
  const visibleCards = cards.slice(0, 7);

  if (cards.length === 0) return null;

  return (
    <button
      type="button"
      className="sj-action-hand-dock"
      style={{ '--sj-action-tab-stack': `${Math.max(0, visibleCards.length - 1) * 12}px` }}
      aria-label={`Ouvrir vos ${cards.length} carte${cards.length > 1 ? 's' : ''} Action`}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      {visibleCards.map((card, index) => (
        <span
          key={card.id}
          className="sj-action-hand-tab"
          style={{ '--sj-action-tab-top': `${index * 12}px` }}
          aria-hidden="true"
        />
      ))}
      <strong className="sj-action-hand-count">{cards.length}</strong>
    </button>
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
          <div className="sj-action-hand-modal-grid">
            {cards.map((card) => {
              const playable = !card.preview
                && isMyTurn
                && turnStage === 'choose'
                && !lastTurnLocked
                && card.availableAt <= turnSerial;
              const discardable = playable;

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
            <div className="sj-action-hand-modal-grid sj-action-player-cards-grid">
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
          <div className="sj-action-hand-modal-grid sj-action-steal-card-grid">
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
          onClick={() => onSelect(null)}
        >
          Aucune
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
            <div className="sj-action-hand-modal-grid sj-action-steal-card-grid">
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

function ActionTile({ card, onClick, disabled = false, compact = false, interactive = true }) {
  const artUrl = ACTION_ART_URLS[card.type] || ACTION_ART_URLS.drawThree;
  const className = `sj-action-card ${compact ? 'sj-action-card-compact' : ''} ${!interactive ? 'sj-action-card-static' : ''}`.trim();
  const content = (
    <>
      <span
        className="sj-action-card-art"
        style={{ backgroundImage: `url('${artUrl}')` }}
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
    >
      {content}
    </button>
  );
}

function GameScreen({ socket, state, myId, roomId, error, errorSerial, onLeaveRoom }) {
  const [copied, setCopied] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  const [actionHandModalOpen, setActionHandModalOpen] = useState(false);
  const [viewedActionPlayerId, setViewedActionPlayerId] = useState(null);
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [visibleActionPlayId, setVisibleActionPlayId] = useState(null);
  const [roundScoresReady, setRoundScoresReady] = useState(true);
  const [peekNow, setPeekNow] = useState(Date.now());
  const [dismissedPeekId, setDismissedPeekId] = useState(null);
  const [lastSeenChatMessageId, setLastSeenChatMessageId] = useState(null);
  const [visibleLastTurnNoticeId, setVisibleLastTurnNoticeId] = useState(null);
  const [roundCountdown, setRoundCountdown] = useState(10);
  const initializedChatRoomRef = useRef('');
  const closeChatModal = useCallback(() => setChatModalOpen(false), []);

  const roundScorePhase = ['roundEnd', 'gameEnd'].includes(state.phase);
  const roundScoresVisible = !roundScorePhase
    || !state.roundScoresAt
    || (roundScoresReady && Date.now() >= state.roundScoresAt);
  const roundScorePreviewActive = roundScorePhase && !roundScoresVisible;
  const boardPlayers = roundScorePreviewActive
    ? state.players.map((player) => ({
      ...player,
      hasTotalScore: false,
      hideTotalScore: true,
      lastRoundScore: null,
    }))
    : state.players;
  const me = boardPlayers.find((player) => player.id === myId);
  const others = boardPlayers.filter((player) => player.id !== myId);
  const isCreator = state.creatorId === myId;
  const connectedPlayerCount = state.players.filter((player) => player.connected).length;
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
  const chatMessages = state.chatMessages || [];
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
  const drawnFromDeck = !!drawnCard && state.drawnCard?.from === 'deck';
  const drawnFromDiscard = !!drawnCard && state.drawnCard?.from === 'discard';
  const drawnCardIsMine = !!drawnCard && state.currentPlayerId === myId;
  const defensePrompt = pendingAction?.defensePrompt || null;
  const hasDrawThreeChoice = Object.prototype.hasOwnProperty.call(actionSelection, 'choiceIndex');
  const showDrawThreeModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'drawThree'
    && !hasDrawThreeChoice;
  const showPlayDiscardModal = !!pendingAction?.mustRespond
    && pendingAction.type === 'playDiscard';
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
  } = useAdaptiveBoardSizing(state.players.length, layoutKey);

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
    if (!['roundEnd', 'gameEnd'].includes(state.phase) || !state.roundScoresAt) {
      setRoundScoresReady(true);
      return undefined;
    }

    const updateScoresReady = () => {
      setRoundScoresReady(Date.now() >= state.roundScoresAt);
    };

    updateScoresReady();
    const delay = Math.max(0, state.roundScoresAt - Date.now());
    const timeout = window.setTimeout(updateScoresReady, delay);
    return () => window.clearTimeout(timeout);
  }, [state.phase, state.roundScoresAt]);

  useEffect(() => {
    if (!myActionState.peek?.expiresAt) return undefined;

    setPeekNow(Date.now());
    const delay = Math.max(0, myActionState.peek.expiresAt - Date.now());
    const timeout = window.setTimeout(() => setPeekNow(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [myActionState.peek?.id, myActionState.peek?.expiresAt]);

  useEffect(() => {
    if (!pendingAction?.mustRespond || pendingAction.type !== 'stealAction' || !autoStealTargetId) return;
    socket.emit('resolveAction', { draft: { stealTargetId: autoStealTargetId } });
  }, [autoStealTargetId, pendingAction?.mustRespond, pendingAction?.type, socket]);

  useEffect(() => {
    if (state.phase !== 'playing' || state.currentPlayerId === myId) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const activeBoard = opponentsRef.current?.querySelector('.sj-board-active');
      if (!activeBoard) return;
      activeBoard.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [myId, state.currentPlayerId, state.phase, state.players.length]);

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
    const text = String(roomId || '');
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
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.opacity = '0';
      textarea.style.userSelect = 'text';
      textarea.style.webkitUserSelect = 'text';
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
        socket.emit('resolveAction', { targetPlayerId: playerId, slotIndex });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'swapOwn' && playerId === myId) {
      const firstSlot = actionSelection.slots?.[0];
      if (Number.isInteger(firstSlot) && firstSlot !== slotIndex) {
        socket.emit('resolveAction', { slotIndex });
      } else if (!Number.isInteger(firstSlot)) {
        socket.emit('resolveAction', { draft: { slots: [slotIndex] } });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'drawThree' && playerId === myId) {
      if (actionSelection.choiceIndex === null) socket.emit('resolveAction', { revealSlot: slotIndex });
      else if (Number.isInteger(actionSelection.choiceIndex)) {
        socket.emit('resolveAction', { slotIndex });
      }
      return;
    }
    if (pendingAction?.mustRespond && pendingAction.type === 'peekLine') {
      const first = actionSelection.peekFirst;
      if (!first) {
        socket.emit('resolveAction', { draft: { peekFirst: { playerId, slotIndex } } });
      } else if (first.playerId === playerId && first.slotIndex !== slotIndex) {
        socket.emit('resolveAction', {
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
        socket.emit('resolveAction', { second: target });
      } else if (!first) {
        socket.emit('resolveAction', { draft: { targets: [target] } });
      }
      return;
    }

    if (playerId !== myId) return;
    if (state.phase === 'initialFlip') {
      socket.emit('flipInitial', { slotIndex });
    } else if (state.turnStage === 'decide') {
      socket.emit('keepDrawnAndPlace', { slotIndex });
    } else if (state.turnStage === 'place') {
      socket.emit('placeCard', { slotIndex });
    } else if (state.turnStage === 'reveal') {
      socket.emit('revealCard', { slotIndex });
    }
  }

  function handleMySlotClick(slotIndex) {
    handleBoardSlotClick(myId, slotIndex);
  }

  function handleDiscardClick() {
    if (canDiscardDrawn) {
      socket.emit('decideDrawn', { keep: false });
    } else if (canDrawDiscard) {
      socket.emit('drawCard', { source: 'discard' });
    }
  }

  function handleActionCardSelect(payload) {
    if (state.pendingStarClaim) {
      socket.emit('claimStarAction', payload);
    }
  }

  function handlePlayActionCard(cardId) {
    socket.emit('playActionCard', { cardId });
    setActionHandModalOpen(false);
  }

  function handleDiscardActionCard(cardId) {
    socket.emit('discardActionCard', { cardId });
    setActionHandModalOpen(false);
  }

  function handleOpenPlayerActionCards(playerId) {
    setViewedActionPlayerId(playerId);
  }

  function handleRemoveEachActionCardSelect(actionCardId) {
    if (!viewedActionPlayerId) return;
    socket.emit('resolveAction', { targetPlayerId: viewedActionPlayerId, actionCardId });
    setViewedActionPlayerId(null);
  }

  function handleDefensePrompt(useDefense) {
    socket.emit('resolveDefense', { useDefense });
  }

  function handleStarGroupChoice(remove) {
    socket.emit('resolveGroupChoice', { remove });
  }

  function handleDrawThreeChoice(choiceIndex) {
    socket.emit('resolveAction', { draft: { choiceIndex } });
  }

  function handleStealTargetSelect(targetId) {
    socket.emit('resolveAction', { draft: { stealTargetId: targetId } });
  }

  function handleStealTargetReset() {
    socket.emit('resolveAction', { draft: { stealTargetId: null } });
  }

  function handleStealCardSelect(cardId) {
    if (!stealTargetId) return;
    socket.emit('resolveAction', { targetPlayerId: stealTargetId, cardId });
  }

  function handlePlayDiscardActionSelect(cardId) {
    socket.emit('resolveAction', { cardId });
  }

  function handleOpenChat() {
    setChatModalOpen(true);
    setLastSeenChatMessageId(latestChatMessageId);
  }

  function handleSendChatMessage(text) {
    socket.emit('sendChatMessage', { text });
  }

  function actionPopupFor(playerId) {
    if (!lastPlayedAction || visibleActionPlayId !== actionPlayId || lastPlayedAction.playerId !== playerId) {
      return null;
    }

    const type = lastPlayedAction.card?.type;
    return {
      id: lastPlayedAction.id,
      title: ACTION_LABELS[type] || 'Carte Action',
      artUrl: ACTION_ART_URLS[type] || ACTION_ART_URLS.drawThree,
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
  const chatButton = (
    <ChatButton unreadCount={unreadChatCount} onClick={handleOpenChat} />
  );
  const chatModal = (
    <ChatModal
      open={chatModalOpen}
      messages={chatMessages}
      myId={myId}
      onClose={closeChatModal}
      onSend={handleSendChatMessage}
    />
  );
  const actionDrawModal = (
    <ActionDrawModal
      open={!!state.pendingStarClaim}
      market={state.actionMarket}
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
      choice={pendingGroupChoice}
      onResolve={handleStarGroupChoice}
    />
  );
  const drawThreeActionModal = (
    <DrawThreeActionModal
      open={showDrawThreeModal}
      cards={pendingAction?.type === 'drawThree' ? pendingAction.drawn : []}
      onSelect={handleDrawThreeChoice}
    />
  );
  const playDiscardActionModal = (
    <PlayDiscardActionModal
      open={showPlayDiscardModal}
      cards={state.actionDiscard || []}
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
      onClose={() => setDismissedPeekId(activePeek?.id || null)}
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
                  className={`sj-pop-in ${player.id === myId ? 'sj-player-list-current' : ''}`}
                >
                  <span className={`sj-turn-dot ${player.connected ? 'sj-turn-dot-on' : ''}`} />
                  <span>{player.name}</span>
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
                      onClick={() => socket.emit('setGameMode', { gameMode: mode.id })}
                    >
                      <strong>{mode.label}</strong>
                    </button>
                  </div>
                ))}
              </div>
            </section>
            {isCreator && connectedPlayerCount >= 2 ? (
              <button className="sj-btn sj-btn-primary" onClick={() => socket.emit('startGame')}>
                Lancer la partie
              </button>
            ) : connectedPlayerCount < 2 ? (
              <p className="sj-hint">En attente d'au moins 2 joueurs</p>
            ) : (
              <p className="sj-hint">En attente de lancement par le créateur</p>
            )}
          </section>
        </div>
        {leaveModal}
      </>
    );
  }

  if (state.phase === 'gameEnd' && roundScoresVisible) {
    const winner = state.players.find((player) => player.id === state.winnerId);
    return (
      <>
        <div className="sj-app-shell sj-lobby-room">
          {leaveButton}
          {chatButton}
          <GameToast key={errorSerial} message={error} />
          <section className="sj-lobby-card sj-pop-in">
            <div className="sj-brand-mark"><SkyjoLogo label={`${winner?.name || 'Joueur'} gagne`} /></div>
            <ScoreTable players={state.players} />
            {isCreator && connectedPlayerCount >= 2 ? (
              <button className="sj-btn sj-btn-primary" onClick={() => socket.emit('startGame')}>
                Nouvelle partie
              </button>
            ) : connectedPlayerCount < 2 ? (
              <p className="sj-hint">Les autres joueurs ont quitté la salle</p>
            ) : (
              <p className="sj-hint">En attente du créateur pour relancer une partie</p>
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
      className={`sj-app-shell ${state.players.length === 2 ? 'sj-two-player-game' : ''} ${isActionMode ? 'sj-action-game' : ''} ${layoutReady ? '' : 'sj-layout-pending'}`}
    >
      {leaveButton}
      {chatButton}
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
            className={`sj-opponents sj-opponents-count-${Math.min(others.length, 4)}`}
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
                suppressRevealAnimation={state.phase === 'initialFlip'}
                onSlotClick={(slotIndex) => handleBoardSlotClick(player.id, slotIndex)}
              />
            ))}
          </section>
        )}

        <section ref={playColumnRef} className="sj-play-column">
          <div ref={centerRef} className="sj-center">
            <div ref={actionPanelRef} className="sj-action-panel">
              <div className="sj-pile-group">
                <PileButton
                  ariaLabel="Piocher dans le paquet"
                  enabled={canDrawDeck}
                  active={canDrawDeck}
                  drawnCard={drawnFromDeck ? drawnCard : null}
                  drawnFrom="deck"
                  drawnPulse={drawnCardIsMine}
                  onClick={() => socket.emit('drawCard', { source: 'deck' })}
                >
                  <Card faceUp={false} size="pile" pulse={canDrawDeck} />
                </PileButton>

                <PileButton
                  ariaLabel={canDiscardDrawn ? 'Défausser la carte tirée' : 'Piocher dans la défausse'}
                  enabled={canDrawDiscard || canDiscardDrawn}
                  active={canDrawDiscard || canDiscardDrawn}
                  tone={canDiscardDrawn ? 'danger' : 'default'}
                  drawnCard={drawnFromDiscard ? drawnCard : null}
                  drawnFrom="discard"
                  drawnPulse={drawnCardIsMine}
                  onClick={handleDiscardClick}
                >
                  {state.discardTop ? (
                    <Card value={state.discardTop.value} kind={state.discardTop.kind} faceUp size="pile" pulse={canDrawDiscard || canDiscardDrawn} tone={canDiscardDrawn ? 'danger' : undefined} />
                  ) : (
                    <Card removed size="pile" />
                  )}
                </PileButton>
              </div>
            </div>
          </div>

          {me && (
            <div ref={meWrapRef} className="sj-me-wrap">
              <PlayerBoard
                player={me}
                isMe
                isActive={isMyTurn}
                onSlotClick={handleMySlotClick}
                selectableSlots={selectableByPlayer[myId]}
                selectedSlots={selectedByPlayer[myId]}
                actionMode={pendingAction ? 'place' : boardActionMode}
                actionPopup={actionPopupFor(myId)}
                suppressRevealAnimation={state.phase === 'initialFlip'}
              />
            </div>
          )}
        </section>
      </main>

      {state.phase === 'roundEnd' && roundScoresVisible && (
        <div className="sj-overlay sj-fade-in">
          <section className="sj-lobby-card sj-pop-in">
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
      {drawThreeActionModal}
      {playDiscardActionModal}
      {stealActionPlayerModal}
      {stealActionCardModal}
      {peekResultModal}
      {playerActionCardsModal}
      {actionHandModal}
    </div>
  );
}

function PileButton({ ariaLabel, enabled, active, tone = 'default', drawnCard, drawnFrom, drawnPulse = false, onClick, children }) {
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
            faceUp
            size="pile"
            pulse={drawnPulse && drawnFrom === 'deck'}
            tone={tone === 'danger' ? 'danger' : undefined}
            animateFlip={drawnFrom === 'deck'}
          />
        </span>
      )}
    </button>
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
