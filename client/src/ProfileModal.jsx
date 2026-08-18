import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Award,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Crown,
  History,
  IdCard,
  KeyRound,
  LoaderCircle,
  Mail,
  Medal,
  RotateCw,
  Save,
  ShieldCheck,
  Trash2,
  Trophy,
  UserPen,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from './authContext.js';
import { buildProgression, challengeDescription, pluralize } from './progression.js';

const PROFILE_COMPACT_QUERY = '(max-width: 1020px)';
const PROFILE_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function mediaMatches(query) {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
}

function canonicalLocale(value) {
  try {
    return Intl.getCanonicalLocales(String(value || '').replaceAll('_', '-'))[0] || '';
  } catch {
    return '';
  }
}

function formatAccountDate(value, locale) {
  if (!value) return 'Non disponible';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Non disponible';
  return new Intl.DateTimeFormat(locale || 'fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function ProfileGoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
      <path fill="#34a853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
      <path fill="#fbbc05" d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.48l3.35-2.62Z" />
      <path fill="#ea4335" d="M12 6.01c1.47 0 2.78.5 3.82 1.49l2.88-2.88A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z" />
    </svg>
  );
}

function trapDialogFocus(event, dialog) {
  const focusableElements = dialog
    ? [...dialog.querySelectorAll(PROFILE_FOCUSABLE_SELECTOR)].filter((element) => (
      !element.closest('[inert]') && element.getClientRects().length > 0
    ))
    : [];
  if (focusableElements.length === 0) {
    event.preventDefault();
    dialog?.focus({ preventScroll: true });
    return;
  }

  const firstElement = focusableElements[0];
  const lastElement = focusableElements.at(-1);
  const activeElement = document.activeElement;
  const focusIsOutside = activeElement === dialog || !dialog.contains(activeElement);
  if (event.shiftKey && (focusIsOutside || activeElement === firstElement)) {
    event.preventDefault();
    lastElement.focus();
  } else if (!event.shiftKey && (focusIsOutside || activeElement === lastElement)) {
    event.preventDefault();
    firstElement.focus();
  }
}

export function ProfileButton({ onClick }) {
  return (
    <button
      type="button"
      className="sj-account-profile-trigger"
      onClick={onClick}
      aria-label="Ouvrir votre profil"
      aria-haspopup="dialog"
      title="Votre profil"
    >
      <UserRound aria-hidden="true" size={17} />
    </button>
  );
}

export function ActivityButton({ onClick }) {
  return (
    <button
      type="button"
      className="sj-account-profile-trigger sj-account-activity-trigger"
      onClick={onClick}
      aria-label="Ouvrir vos statistiques et votre progression"
      aria-haspopup="dialog"
      title="Statistiques et progression"
    >
      <Trophy aria-hidden="true" size={17} />
    </button>
  );
}

export default function ProfileModal({ open, onClose, onProfileUpdated, mode = 'profile' }) {
  const {
    user,
    updateProfile,
    profileStats,
    profileStatsLoading,
    profileStatsError,
    getProfileStats,
    requestProfilePasswordChange,
    deleteAccount,
    logout,
  } = useAuth();
  const profileModalRef = useRef(null);
  const deleteModalRef = useRef(null);
  const discardModalRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const discardContinueRef = useRef(null);
  const reauthenticationButtonRef = useRef(null);
  const firstNameRef = useRef(null);
  const leaderboardFormatRef = useRef(null);
  const statisticsContentRef = useRef(null);
  const deleteConfirmationRef = useRef(null);
  const wasOpenRef = useRef(false);
  const notificationSerialRef = useRef(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [leaderboardVisible, setLeaderboardVisible] = useState(false);
  const [leaderboardNameFormat, setLeaderboardNameFormat] = useState('player_name');
  const [leaderboardFormatOpen, setLeaderboardFormatOpen] = useState(false);
  const [leaderboardFormatPlacement, setLeaderboardFormatPlacement] = useState('down');
  const [busy, setBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState('');
  const [notification, setNotification] = useState(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [discardMode, setDiscardMode] = useState(false);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [activeSection, setActiveSection] = useState('account');
  const [activeContentTab, setActiveContentTab] = useState('statistics');
  const [statisticsSubtab, setStatisticsSubtab] = useState('statistics');
  const [compactProfile, setCompactProfile] = useState(() => mediaMatches(PROFILE_COMPACT_QUERY));
  const activityMode = mode === 'activity';
  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName.trim();
  const normalizedPlayerName = playerName.trim();
  const rawLeaderboardNameOptions = [
    { value: 'player_name', label: normalizedPlayerName || 'Pseudo' },
    { value: 'first_name', label: normalizedFirstName || 'Prénom' },
    { value: 'first_initial', label: `${normalizedFirstName || 'Prénom'} ${normalizedLastName ? `${normalizedLastName[0]}.` : 'N.'}` },
    { value: 'full_name', label: [normalizedFirstName, normalizedLastName].filter(Boolean).join(' ') || 'Prénom Nom' },
  ];
  const leaderboardNameOptionsByLabel = new Map();
  rawLeaderboardNameOptions.forEach((option) => {
    const labelKey = option.label.normalize('NFKC').trim().toLocaleLowerCase('fr-FR');
    const existing = leaderboardNameOptionsByLabel.get(labelKey);
    if (!existing || option.value === leaderboardNameFormat) {
      leaderboardNameOptionsByLabel.set(labelKey, option);
    }
  });
  const leaderboardNameOptions = [...leaderboardNameOptionsByLabel.values()];
  const leaderboardNameOptionCount = leaderboardNameOptions.length;
  const selectedLeaderboardName = leaderboardNameOptions.find(
    (option) => option.value === leaderboardNameFormat,
  )?.label || leaderboardNameOptions[0].label;
  const selectStatisticsSubtab = (tab) => {
    setStatisticsSubtab(tab);
    if (statisticsContentRef.current) statisticsContentRef.current.scrollTop = 0;
  };
  const handleStatisticsTabKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')];
    const currentIndex = tabs.indexOf(event.currentTarget);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };
  const updateLeaderboardFormatPlacement = useCallback(() => {
    const trigger = leaderboardFormatRef.current?.querySelector('.sj-profile-leaderboard-format-trigger');
    if (!trigger) return;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const touchLayout = window.matchMedia?.('(pointer: coarse)').matches;
    const expectedMenuHeight = leaderboardNameOptionCount * (touchLayout ? 40 : 29) + 12;
    const availableBelow = viewportHeight - triggerRect.bottom - 12;
    const availableAbove = triggerRect.top - 12;
    setLeaderboardFormatPlacement(
      availableBelow >= expectedMenuHeight || availableBelow >= availableAbove ? 'down' : 'up',
    );
  }, [leaderboardNameOptionCount]);
  const focusLeaderboardFormatTrigger = useCallback(() => {
    window.requestAnimationFrame(() => {
      leaderboardFormatRef.current
        ?.querySelector('.sj-profile-leaderboard-format-trigger')
        ?.focus({ preventScroll: true });
    });
  }, []);
  const handleLeaderboardFormatTriggerKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (!leaderboardFormatOpen) {
      updateLeaderboardFormatPlacement();
      setLeaderboardFormatOpen(true);
    }
    window.requestAnimationFrame(() => {
      const options = [...(leaderboardFormatRef.current?.querySelectorAll('[role="option"]') || [])];
      const selectedOption = options.find((option) => option.getAttribute('aria-selected') === 'true');
      (selectedOption || (event.key === 'ArrowUp' ? options.at(-1) : options[0]))?.focus();
    });
  };
  const handleLeaderboardFormatMenuKeyDown = (event) => {
    const options = [...event.currentTarget.querySelectorAll('[role="option"]')];
    const currentIndex = options.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(options.length - 1, currentIndex + 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    else return;
    event.preventDefault();
    options[nextIndex]?.focus();
  };
  const hasChanges = Boolean(user) && (
    normalizedFirstName !== user.firstName
    || normalizedLastName !== user.lastName
    || normalizedPlayerName !== user.playerName
    || leaderboardVisible !== user.leaderboardVisible
    || leaderboardNameFormat !== user.leaderboardNameFormat
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(PROFILE_COMPACT_QUERY);
    const handleChange = () => setCompactProfile(media.matches);
    handleChange();
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const returnFocusTarget = document.activeElement;
    return () => {
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) {
          returnFocusTarget.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return undefined;
    }
    if (!user || wasOpenRef.current) return undefined;
    wasOpenRef.current = true;
    setFirstName(user.firstName || '');
    setLastName(user.lastName || '');
    setPlayerName(user.playerName || user.firstName || '');
    setLeaderboardVisible(user.leaderboardVisible === true);
    setLeaderboardNameFormat(user.leaderboardNameFormat || 'player_name');
    setLeaderboardFormatOpen(false);
    setLeaderboardFormatPlacement('down');
    setSecurityBusy('');
    setNotification(null);
    setDeleteMode(false);
    setDiscardMode(false);
    setReauthenticationRequired(false);
    setDeleteConfirmation('');
    setActiveSection('account');
    setActiveContentTab(activityMode ? 'statistics' : 'profile');
    setStatisticsSubtab('statistics');
    const shouldFocusForm = mediaMatches('(min-width: 1021px) and (pointer: fine)');
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = shouldFocusForm ? firstNameRef.current : profileModalRef.current;
      focusTarget?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activityMode, open, user]);

  useEffect(() => {
    if (!open || !user?.id) return undefined;
    getProfileStats({ force: true }).catch(() => {});
    return undefined;
  }, [getProfileStats, open, user?.id]);

  useEffect(() => {
    if (!leaderboardFormatOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!leaderboardFormatRef.current?.contains(event.target)) {
        setLeaderboardFormatOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    const handleViewportChange = () => updateLeaderboardFormatPlacement();
    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
    };
  }, [leaderboardFormatOpen, updateLeaderboardFormatPlacement]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Tab') {
        const activeDialog = deleteMode
          ? deleteModalRef.current
          : discardMode ? discardModalRef.current : profileModalRef.current;
        trapDialogFocus(event, activeDialog);
        return;
      }
      if (event.key !== 'Escape' || busy || securityBusy) return;
      if (leaderboardFormatOpen) {
        setLeaderboardFormatOpen(false);
        focusLeaderboardFormatTrigger();
      } else if (deleteMode) {
        setDeleteMode(false);
        setDeleteConfirmation('');
        setReauthenticationRequired(false);
      } else if (discardMode) {
        setDiscardMode(false);
      } else if (hasChanges) {
        setDiscardMode(true);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, deleteMode, discardMode, focusLeaderboardFormatTrigger, hasChanges, leaderboardFormatOpen, onClose, open, securityBusy]);

  useEffect(() => {
    if (!deleteMode) return undefined;
    const returnFocusTarget = deleteTriggerRef.current;
    const frame = window.requestAnimationFrame(() => deleteConfirmationRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) {
          returnFocusTarget.focus({ preventScroll: true });
        }
      });
    };
  }, [deleteMode]);

  useEffect(() => {
    if (!deleteMode || !reauthenticationRequired) return undefined;
    const frame = window.requestAnimationFrame(() => reauthenticationButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [deleteMode, reauthenticationRequired]);

  useEffect(() => {
    if (!discardMode) return undefined;
    const returnFocusTarget = document.activeElement;
    const frame = window.requestAnimationFrame(() => discardContinueRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) {
          returnFocusTarget.focus({ preventScroll: true });
        }
      });
    };
  }, [discardMode]);

  useEffect(() => {
    if (!notification) return undefined;
    const timeout = window.setTimeout(() => setNotification(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notification]);

  if (!open || !user) return null;

  const currentLocale = canonicalLocale(user.preferredLocale)
    || canonicalLocale(typeof navigator === 'undefined' ? '' : navigator.language)
    || 'fr-FR';
  const canSave = !busy && !securityBusy && !!normalizedFirstName && !!normalizedLastName
    && !!normalizedPlayerName && hasChanges;
  const providers = Array.isArray(user.providers) && user.providers.length > 0
    ? user.providers
    : [user.provider];
  const hasGoogleProvider = providers.includes('google');
  const hasEmailProvider = providers.includes('email');
  const providerLabel = [
    hasEmailProvider ? 'E-mail' : '',
    hasGoogleProvider ? 'Google' : '',
  ].filter(Boolean).join(', ');
  const savedDisplayName = user.displayName
    || `${user.firstName || ''} ${user.lastName || ''}`.trim()
    || user.email;
  const statistics = profileStats;
  const statisticsLoading = profileStatsLoading && !statistics;
  const statisticsError = statistics ? '' : profileStatsError;
  const completedGames = (statistics?.gamesWon || 0)
    + (statistics?.gamesLost || 0)
    + (statistics?.gamesDrawn || 0);
  const formatStat = (value) => new Intl.NumberFormat(currentLocale).format(Number(value || 0));
  const primaryStatistics = [
    { singular: 'Partie jouée', plural: 'Parties jouées', value: statistics?.gamesPlayed, tone: 'played' },
    { singular: 'Victoire', plural: 'Victoires', value: statistics?.gamesWon, tone: 'won' },
    { singular: 'Défaite', plural: 'Défaites', value: statistics?.gamesLost, tone: 'lost' },
    { singular: 'Égalité', plural: 'Égalités', value: statistics?.gamesDrawn, tone: 'drawn' },
    { singular: 'Abandon', plural: 'Abandons', value: statistics?.gamesAbandoned, tone: 'abandoned' },
  ];
  const progression = buildProgression(statistics || {});
  const modeGameCount = (statistics?.classicGames || 0) + (statistics?.actionGames || 0);
  const classicShare = modeGameCount > 0 ? Math.round(((statistics?.classicGames || 0) / modeGameCount) * 100) : 0;
  const actionShare = modeGameCount > 0 ? 100 - classicShare : 0;
  const rawResultSegments = [
    { key: 'won', label: 'Victoires', value: Number(statistics?.gamesWon || 0), color: '#62d27f' },
    { key: 'drawn', label: 'Égalités', value: Number(statistics?.gamesDrawn || 0), color: '#b493ef' },
    { key: 'lost', label: 'Défaites', value: Number(statistics?.gamesLost || 0), color: '#f0bd57' },
    { key: 'abandoned', label: 'Abandons', value: Number(statistics?.gamesAbandoned || 0), color: '#ef6a61' },
  ];
  const resultTotal = rawResultSegments.reduce((total, segment) => total + segment.value, 0);
  const resultPercentages = rawResultSegments.map((segment) => {
    const exact = resultTotal > 0 ? (segment.value / resultTotal) * 100 : 0;
    return { exact, rounded: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remainingResultPoints = 100 - resultPercentages.reduce((total, percentage) => total + percentage.rounded, 0);
  [...resultPercentages.keys()]
    .sort((left, right) => resultPercentages[right].remainder - resultPercentages[left].remainder)
    .forEach((index) => {
      if (remainingResultPoints <= 0 || resultTotal === 0) return;
      resultPercentages[index].rounded += 1;
      remainingResultPoints -= 1;
    });
  const resultSegments = rawResultSegments.map((segment, index) => ({
    ...segment,
    percent: resultPercentages[index].rounded,
  }));
  const trophiesPerGame = (statistics?.gamesPlayed || 0) > 0
    ? Number(statistics.competitiveRating || 0) / statistics.gamesPlayed
    : 0;
  const xpPerGame = completedGames > 0 ? progression.xp / completedGames : 0;
  const recentGames = Array.isArray(statistics?.recentGames) ? statistics.recentGames.slice(-10) : [];
  const recentWins = recentGames.filter((game) => game.outcome === 'won').length;
  const recentForm = recentGames.length > 0 ? Math.round((recentWins / recentGames.length) * 100) : 0;
  const usageMetrics = statistics?.usageMetrics || {};
  const weekdayUsage = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((label, index) => ({
    label,
    value: Number(usageMetrics.weekdays?.[index] || 0),
  }));
  const busiestWeekday = Math.max(1, ...weekdayUsage.map((day) => day.value));
  const periodUsage = ['Matin', 'Après-midi', 'Soir', 'Nuit'].map((label, index) => ({
    label,
    value: Number(usageMetrics.periods?.[index] || 0),
  }));
  const totalPeriodUsage = Math.max(1, ...periodUsage.map((period) => period.value));
  const leaderboard = Array.isArray(statistics?.leaderboard) ? statistics.leaderboard : [];
  const visibleChallenges = progression.activeChallenges;
  const showStatisticsOverview = compactProfile
    ? statisticsSubtab === 'statistics'
    : activeContentTab === 'statistics';
  const showProgression = compactProfile
    ? statisticsSubtab === 'progression'
    : activeContentTab === 'progression';
  const showLeaderboard = compactProfile
    ? statisticsSubtab === 'leaderboard'
    : activeContentTab === 'leaderboard';
  const currentLeaderboardEntry = leaderboard.find((entry) => entry.isCurrentUser);

  function showNotification(tone, message) {
    notificationSerialRef.current += 1;
    setNotification({ id: notificationSerialRef.current, tone, message });
  }

  function requestProfileClose() {
    if (hasChanges) {
      setDiscardMode(true);
      return;
    }
    onClose();
  }

  function closeDeleteConfirmation() {
    setDeleteMode(false);
    setDeleteConfirmation('');
    setReauthenticationRequired(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const updatedUser = await updateProfile({
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        playerName: normalizedPlayerName,
        leaderboardVisible,
        leaderboardNameFormat,
      });
      setFirstName(updatedUser.firstName || '');
      setLastName(updatedUser.lastName || '');
      setPlayerName(updatedUser.playerName || updatedUser.firstName || '');
      onProfileUpdated?.(updatedUser);
      showNotification('success', 'Profil mis à jour.');
    } catch (profileError) {
      showNotification('error', profileError.message || 'Impossible de mettre à jour le profil.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordChangeRequest() {
    setSecurityBusy('password');
    try {
      await requestProfilePasswordChange();
      showNotification('success', `Un e-mail a été envoyé à ${user.email}.`);
    } catch (requestError) {
      showNotification('error', requestError.message || "Impossible d'envoyer l'e-mail.");
    } finally {
      setSecurityBusy('');
    }
  }

  async function handleAccountDelete() {
    if (deleteConfirmation.trim().toLowerCase() !== user.email.toLowerCase()) return;
    setSecurityBusy('delete');
    try {
      await deleteAccount(deleteConfirmation);
    } catch (deleteError) {
      if (deleteError.code === 'recent_authentication_required') {
        setDeleteConfirmation('');
        setReauthenticationRequired(true);
      } else {
        showNotification('error', deleteError.message || 'Impossible de supprimer le compte.');
      }
      setSecurityBusy('');
    }
  }

  async function handleReauthentication() {
    setSecurityBusy('reauthentication');
    await logout();
  }

  function renderSecuritySection() {
    return (
      <section
        className="sj-profile-security"
        aria-labelledby={compactProfile ? undefined : 'profile-security-title'}
      >
        <div className="sj-profile-security-head">
          <h3 id="profile-security-title">Sécurité du compte</h3>
        </div>

        {hasEmailProvider && (
          <div className="sj-profile-security-action">
            <button
              type="button"
              className="sj-profile-security-icon sj-profile-security-trigger sj-profile-security-password-trigger"
              onClick={handlePasswordChangeRequest}
              disabled={!!securityBusy}
              aria-label="Modifier le mot de passe"
              title="Modifier le mot de passe"
            >
              {securityBusy === 'password'
                ? <LoaderCircle className="sj-profile-security-spinner" aria-hidden="true" size={17} />
                : <KeyRound aria-hidden="true" size={18} />}
            </button>
            <div>
              <strong>Mot de passe</strong>
              <small>Recevez un lien sécurisé par e-mail pour le modifier.</small>
            </div>
          </div>
        )}

        <div className="sj-profile-security-action sj-profile-security-danger">
          <button
            ref={deleteTriggerRef}
            type="button"
            className="sj-profile-security-icon sj-profile-security-trigger sj-profile-security-delete-trigger"
            onClick={() => {
              setReauthenticationRequired(false);
              setDeleteMode(true);
            }}
            disabled={!!securityBusy || deleteMode}
            aria-label="Supprimer le compte"
            title="Supprimer le compte"
          >
            <Trash2 aria-hidden="true" size={17} />
          </button>
          <div>
            <strong>Supprimer le compte</strong>
            <small>Cette action supprimera définitivement votre compte et ses informations.</small>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
    {notification && (
      <div
        key={notification.id}
        className={`sj-game-toast sj-profile-toast sj-game-toast-${notification.tone}`}
        role={notification.tone === 'error' ? 'alert' : 'status'}
        aria-live={notification.tone === 'error' ? 'assertive' : 'polite'}
      >
        <span className="sj-game-toast-icon" aria-hidden="true">
          {notification.tone === 'success' ? <Check size={15} /> : '!'}
        </span>
        <span className="sj-game-toast-text">{notification.message}</span>
      </div>
    )}
    <div
      className="sj-modal-overlay sj-profile-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !securityBusy) requestProfileClose();
      }}
    >
      <section
        ref={profileModalRef}
        className={`sj-profile-modal ${activityMode ? 'sj-profile-modal-activity' : 'sj-profile-modal-account'} sj-pop-in`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        aria-hidden={deleteMode || discardMode || undefined}
        inert={deleteMode || discardMode ? '' : undefined}
        tabIndex={-1}
      >
        <header className="sj-profile-head">
          <div>
            <span>{activityMode ? 'Votre activité' : 'Votre compte'}</span>
            <h2 id="profile-title">{activityMode ? 'Statistiques et progression' : 'Votre profil'}</h2>
          </div>
          <button
            type="button"
            className="sj-profile-close"
            onClick={requestProfileClose}
            disabled={!!busy || !!securityBusy}
            aria-label="Fermer le profil"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <div className="sj-profile-layout">
          {!activityMode && compactProfile && (
            <button
              id="profile-accordion-account"
              type="button"
              className="sj-profile-accordion-trigger"
              aria-expanded={activeSection === 'account'}
              aria-controls="profile-panel-account"
              onClick={() => setActiveSection((section) => (
                section === 'account' ? null : 'account'
              ))}
            >
              <span className="sj-profile-accordion-icon"><IdCard aria-hidden="true" size={17} /></span>
              <span className="sj-profile-accordion-copy">
                <strong>Votre compte</strong>
                <small>Identité et activité</small>
              </span>
              <ChevronDown className="sj-profile-accordion-chevron" aria-hidden="true" size={17} />
            </button>
          )}
          {!activityMode && <div
            id="profile-panel-account"
            className={`sj-profile-accordion-panel ${activeSection === 'account' ? 'sj-profile-accordion-panel-open' : ''}`}
            aria-labelledby={compactProfile ? 'profile-accordion-account' : undefined}
            aria-hidden={compactProfile ? activeSection !== 'account' : undefined}
            inert={compactProfile && activeSection !== 'account' ? '' : undefined}
            role={compactProfile ? 'region' : undefined}
          >
            <div className="sj-profile-accordion-panel-clip">
            <aside className="sj-profile-sidebar" aria-label={compactProfile ? undefined : 'Résumé du compte'}>
            <div className="sj-profile-account-summary">
              <div className="sj-profile-identity">
                <strong>{savedDisplayName}</strong>
              </div>
              <span
                className="sj-profile-provider"
                aria-label={`Méthodes de connexion : ${providerLabel}`}
              >
                <span className="sj-profile-provider-icons" aria-hidden="true">
                  {hasEmailProvider && (
                    <span className="sj-profile-provider-icon sj-profile-provider-icon-email">
                      <Mail size={17} strokeWidth={1.8} />
                    </span>
                  )}
                  {hasGoogleProvider && (
                    <span className="sj-profile-provider-icon sj-profile-provider-icon-google">
                      <ProfileGoogleIcon />
                    </span>
                  )}
                </span>
                <span className="sj-profile-provider-label">{providerLabel}</span>
              </span>
            </div>

            <dl className="sj-profile-account-data">
              <div>
                <dt><Mail aria-hidden="true" size={16} /> Adresse e-mail</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt><CalendarDays aria-hidden="true" size={16} /> Compte créé</dt>
                <dd>{formatAccountDate(user.createdAt, currentLocale)}</dd>
              </div>
              <div>
                <dt><History aria-hidden="true" size={16} /> Dernière connexion</dt>
                <dd>{formatAccountDate(user.lastSignInAt, currentLocale)}</dd>
              </div>
            </dl>
            {!compactProfile && renderSecuritySection()}
            </aside>
            </div>
          </div>}

          <div className="sj-profile-main">
            {activityMode && !compactProfile && (
              <div className="sj-profile-main-tabs" role="tablist" aria-label="Contenu du profil">
                {[
                  ['statistics', 'Statistiques', BarChart3],
                  ['progression', 'Progression', Award],
                  ['leaderboard', 'Classement', Crown],
                ].map(([tabId, label, Icon]) => (
                  <button
                    key={tabId}
                    type="button"
                    role="tab"
                    aria-selected={activeContentTab === tabId}
                    aria-controls={tabId === 'profile' ? 'profile-panel-profile' : 'profile-panel-statistics'}
                    onClick={() => setActiveContentTab(tabId)}
                  >
                    <Icon aria-hidden="true" size={15} /> {label}
                  </button>
                ))}
              </div>
            )}
            {activityMode && <div
              id="profile-panel-statistics"
              className="sj-profile-accordion-panel sj-profile-accordion-panel-open"
              role={compactProfile ? 'region' : undefined}
              aria-label={compactProfile ? 'Statistiques, progression et classement' : undefined}
              hidden={!compactProfile && activeContentTab === 'profile'}
            >
              <div className="sj-profile-accordion-panel-clip">
                <section
                  className="sj-profile-statistics"
                  aria-label="Statistiques de jeu"
                  aria-busy={statisticsLoading}
                >
                  {compactProfile && (
                    <div className="sj-profile-statistics-tabs" role="tablist" aria-label="Statistiques, progression et classement">
                      <button
                        id="profile-statistics-tab-statistics"
                        type="button"
                        role="tab"
                        aria-selected={statisticsSubtab === 'statistics'}
                        aria-controls="profile-statistics-subpanel"
                        onClick={() => selectStatisticsSubtab('statistics')}
                        onKeyDown={handleStatisticsTabKeyDown}
                      >
                        <BarChart3 aria-hidden="true" size={14} /> Statistiques
                      </button>
                      <button
                        id="profile-statistics-tab-progression"
                        type="button"
                        role="tab"
                        aria-selected={statisticsSubtab === 'progression'}
                        aria-controls="profile-statistics-subpanel"
                        onClick={() => selectStatisticsSubtab('progression')}
                        onKeyDown={handleStatisticsTabKeyDown}
                      >
                        <Award aria-hidden="true" size={14} /> Progression
                      </button>
                      <button
                        id="profile-statistics-tab-leaderboard"
                        type="button"
                        role="tab"
                        aria-selected={statisticsSubtab === 'leaderboard'}
                        aria-controls="profile-statistics-subpanel"
                        onClick={() => selectStatisticsSubtab('leaderboard')}
                        onKeyDown={handleStatisticsTabKeyDown}
                      >
                        <Crown aria-hidden="true" size={14} /> Classement
                      </button>
                    </div>
                  )}
                  <div
                    id={compactProfile ? 'profile-statistics-subpanel' : undefined}
                    className="sj-profile-statistics-content"
                    ref={statisticsContentRef}
                    role={compactProfile ? 'tabpanel' : undefined}
                    aria-labelledby={compactProfile ? `profile-statistics-tab-${statisticsSubtab}` : undefined}
                  >
                  {statisticsError ? (
                    <div className="sj-profile-statistics-state" role="status">
                      <p>{statisticsError}</p>
                      <button
                        type="button"
                        className="sj-profile-statistics-retry"
                        onClick={() => getProfileStats({ force: true }).catch(() => {})}
                      >
                        <RotateCw aria-hidden="true" size={14} /> Réessayer
                      </button>
                    </div>
                  ) : (
                    <>
                      <div hidden={!showStatisticsOverview} className={`sj-profile-statistics-grid ${statisticsLoading ? 'sj-profile-statistics-grid-loading' : ''}`}>
                        {primaryStatistics.map((statistic) => (
                          <article key={statistic.tone} className={`sj-profile-stat sj-profile-stat-${statistic.tone}`}>
                            <strong>{statisticsLoading ? '—' : formatStat(statistic.value)}</strong>
                            <span>{pluralize(statistic.value, statistic.singular, statistic.plural)}</span>
                          </article>
                        ))}
                      </div>
                      {showStatisticsOverview && !statisticsLoading && (statistics?.gamesPlayed || 0) > 0 && (
                        <div className="sj-stat-insights" aria-label="Analyses de votre façon de jouer">
                          <article className="sj-stat-insight sj-stat-modes">
                            <div
                              className="sj-stat-donut"
                              style={{ '--sj-chart-value': `${classicShare}%` }}
                              role="img"
                              aria-label={`${classicShare}% de parties classiques et ${actionShare}% de parties Action`}
                            >
                              <span>{classicShare}%</span>
                            </div>
                            <div>
                              <strong>Style de jeu</strong>
                              <span><i className="sj-chart-dot sj-chart-dot-classic" /> Classique <strong>{classicShare}%</strong></span>
                              <span><i className="sj-chart-dot sj-chart-dot-action" /> Action <strong>{actionShare}%</strong></span>
                            </div>
                          </article>
                          <article className="sj-stat-insight sj-stat-recent-form">
                            <div className="sj-stat-insight-head">
                              <span>Forme récente</span>
                              <strong>{recentForm}%</strong>
                            </div>
                            <div className="sj-stat-form-dots" aria-label={`${recentWins} victoires sur les ${recentGames.length} dernières parties`}>
                              {recentGames.map((game, index) => (
                                <i key={`${index}-${game.outcome}`} className={`sj-stat-form-${game.outcome}`} title={game.outcome === 'won' ? 'Victoire' : game.outcome === 'lost' ? 'Défaite' : 'Égalité'} />
                              ))}
                            </div>
                            <small>{recentWins} {pluralize(recentWins, 'victoire', 'victoires')} sur {recentGames.length} parties récentes</small>
                          </article>
                          <article className="sj-stat-insight sj-stat-results">
                            <strong className="sj-stat-results-title">Profil de résultats</strong>
                            <div className="sj-stat-result-bar" aria-label="Répartition de vos résultats">
                              {resultSegments.filter((segment) => segment.value > 0).map((segment) => (
                                <i
                                  key={segment.key}
                                  style={{ flexGrow: segment.value, background: segment.color }}
                                  title={`${segment.label} : ${segment.percent}%`}
                                />
                              ))}
                            </div>
                            <div className="sj-stat-result-legend">
                              {resultSegments.map((segment) => (
                                <span key={segment.key}>
                                  <i style={{ background: segment.color }} />
                                  {segment.label} <strong>{segment.percent}%</strong>
                                </span>
                              ))}
                            </div>
                          </article>
                          <article className="sj-stat-insight sj-stat-efficiency">
                            <div className="sj-stat-gauge" style={{ '--sj-gauge-value': `${Math.min(100, trophiesPerGame * 5)}%` }} aria-hidden="true">
                              <span>🏆</span>
                            </div>
                            <div>
                              <strong>{trophiesPerGame.toLocaleString(currentLocale, { maximumFractionDigits: 1 })}</strong>
                              <span>{pluralize(trophiesPerGame, 'trophée moyen', 'trophées moyens')}</span>
                              <small>gagné par partie</small>
                            </div>
                          </article>
                          <article className="sj-stat-insight sj-stat-xp-pace">
                            <div className="sj-stat-xp-spark" aria-hidden="true">
                              <i /><i /><i /><i /><i />
                            </div>
                            <div>
                              <strong>{formatStat(Math.round(xpPerGame))} XP</strong>
                              <span>Rythme de progression</span>
                              <small>XP moyenne par partie terminée</small>
                            </div>
                          </article>
                          <article className="sj-stat-insight sj-stat-weekly-usage">
                            <strong>Vos jours de jeu</strong>
                            <div className="sj-stat-week-bars">
                              {weekdayUsage.map((day, index) => (
                                <div key={`${day.label}-${index}`}><i style={{ height: `${Math.max(6, (day.value / busiestWeekday) * 100)}%` }} /><span>{day.label}</span></div>
                              ))}
                            </div>
                            <small>Répartition de toutes vos parties par jour de la semaine</small>
                          </article>
                          <article className="sj-stat-insight sj-stat-period-usage">
                            <strong>Moments préférés</strong>
                            {periodUsage.map((period) => (
                              <div key={period.label}><span>{period.label}</span><i><b style={{ width: `${(period.value / totalPeriodUsage) * 100}%` }} /></i><strong>{period.value}</strong></div>
                            ))}
                          </article>
                          <article className="sj-stat-insight sj-stat-frequency">
                            <div><strong>{formatStat(usageMetrics.last7 || 0)}</strong><span>7 derniers jours</span></div>
                            <div><strong>{formatStat(usageMetrics.last30 || 0)}</strong><span>30 derniers jours</span></div>
                            <div><strong>{formatStat(usageMetrics.activeDays30 || 0)}</strong><span>jours actifs</span></div>
                          </article>
                        </div>
                      )}
                      {showStatisticsOverview && !statisticsLoading && (statistics?.gamesPlayed || 0) === 0 && (
                        <p className="sj-profile-statistics-empty">
                          <Trophy aria-hidden="true" size={15} /> Vos prochaines parties apparaîtront ici.
                        </p>
                      )}
                      {showProgression && !statisticsLoading && (
                        <div className="sj-progression" aria-label="Progression du joueur">
                          <section className="sj-level-road" aria-label={`Niveau ${progression.level}, ${formatStat(progression.xp)} XP`}>
                            <div className="sj-level-road-head">
                              <div>
                                <strong>Niveau {progression.level}</strong>
                              </div>
                              <span>{formatStat(progression.xp)} XP</span>
                            </div>
                            <div className="sj-level-timeline">
                              <div className="sj-level-timeline-line" aria-hidden="true">
                                <span style={{ width: `${Math.min(100, Math.round(progression.timelineProgress * 100))}%` }} />
                              </div>
                              {progression.levelTimeline.map((milestone) => (
                                <div
                                  key={milestone.level}
                                  className={`sj-level-milestone ${milestone.completed ? 'sj-level-milestone-complete' : ''} ${milestone.current ? 'sj-level-milestone-current' : ''}`}
                                >
                                  <span>{milestone.level}</span>
                                  <small>{formatStat(milestone.xp)} XP</small>
                                </div>
                              ))}
                            </div>
                            <small>{formatStat(progression.nextLevelXp - progression.xp)} XP avant le niveau {progression.level + 1}</small>
                          </section>

                          <section className="sj-progression-block" aria-labelledby="profile-challenges-title">
                            <div className="sj-progression-title">
                              <span><Award aria-hidden="true" size={15} /><strong id="profile-challenges-title">Prochains défis</strong></span>
                              <small>{formatStat(progression.completedChallenges)} {pluralize(progression.completedChallenges, 'succès débloqué', 'succès débloqués')}</small>
                            </div>
                            <div className="sj-challenge-list">
                              {visibleChallenges.map((challenge) => {
                                const percent = Math.round((challenge.current / challenge.target) * 100);
                                return (
                                  <article key={challenge.id} className={`sj-challenge ${challenge.completed ? 'sj-challenge-complete' : ''}`}>
                                    <div className="sj-challenge-head">
                                      <span className="sj-challenge-icon" aria-hidden="true">{challenge.completed ? '✓' : <Medal size={15} />}</span>
                                      <div className="sj-challenge-copy">
                                        <strong>{challenge.title}</strong>
                                        <small>{challengeDescription(challenge)}</small>
                                      </div>
                                      <span className="sj-challenge-reward">+{formatStat(challenge.xp)} XP</span>
                                    </div>
                                    <div className="sj-challenge-progress">
                                      <div className="sj-challenge-track"><span style={{ width: `${percent}%` }} /></div>
                                      <small>{formatStat(challenge.current)} / {formatStat(challenge.target)}</small>
                                    </div>
                                  </article>
                                );
                              })}
                              {visibleChallenges.length === 0 && (
                                <p className="sj-challenge-complete-all"><Trophy aria-hidden="true" size={17} /> Tous les défis sont terminés.</p>
                              )}
                            </div>
                          </section>

                        </div>
                      )}
                      {showLeaderboard && !statisticsLoading && (
                        <div className="sj-competitive" aria-label="Classement compétitif">
                          <div className="sj-competitive-hero">
                            <span className="sj-competitive-emblem" aria-hidden="true"><Crown size={25} /></span>
                            <div>
                              <small>Votre classement</small>
                              <strong>{currentLeaderboardEntry ? `#${currentLeaderboardEntry.rank}` : 'Non classé'}</strong>
                              <span>🏆 {formatStat(statistics?.competitiveRating)} {pluralize(statistics?.competitiveRating, 'trophée', 'trophées')}</span>
                              {(statistics?.currentWinStreak || 0) >= 2 && (
                                <span className="sj-competitive-streak">🔥 Série de {formatStat(statistics.currentWinStreak)} victoires</span>
                              )}
                            </div>
                          </div>

                          <div className="sj-competitive-scoring" aria-label="Règles des points compétitifs">
                            <span><strong>+20</strong> 1er</span>
                            <span><strong>−5</strong> Dernier</span>
                            <span><strong>−8</strong> Abandon</span>
                          </div>

                          <section className="sj-leaderboard-card" aria-labelledby="profile-leaderboard-title">
                            <div className="sj-leaderboard-head">
                              <div>
                                <Trophy aria-hidden="true" size={16} />
                                <strong id="profile-leaderboard-title">Classement mondial</strong>
                              </div>
                              <span>Top 100</span>
                            </div>
                            {leaderboard.length > 0 ? (
                              <ol className="sj-leaderboard">
                                {leaderboard.map((entry) => (
                                  <li key={`${entry.rank}-${entry.playerName}`} className={entry.isCurrentUser ? 'sj-leaderboard-me' : ''}>
                                    <span className={`sj-leaderboard-rank sj-leaderboard-rank-${Math.min(entry.rank, 4)}`}>
                                      {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
                                    </span>
                                    <span className="sj-leaderboard-player">
                                      <strong>{entry.playerName}{entry.isCurrentUser ? ' (vous)' : ''}</strong>
                                      <small>{formatStat(entry.gamesPlayed)} {pluralize(entry.gamesPlayed, 'partie', 'parties')} · {formatStat(entry.gamesWon)} {pluralize(entry.gamesWon, 'victoire', 'victoires')}</small>
                                    </span>
                                    <strong className="sj-leaderboard-points">🏆 {formatStat(entry.rating)}</strong>
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <div className="sj-leaderboard-empty">
                                <span aria-hidden="true"><Trophy size={23} /></span>
                                <strong>Votre ascension commence ici</strong>
                                <p>Terminez une partie pour rejoindre le classement.</p>
                              </div>
                            )}
                          </section>
                          <p className="sj-leaderboard-rule">Votre rang rapporte de −5 à +20 trophées. Série de victoires : jusqu’à +5.</p>
                        </div>
                      )}
                    </>
                  )}
                  </div>
                </section>
              </div>
            </div>}

            {!activityMode && <div className="sj-profile-main-separator" aria-hidden="true" />}

            {!activityMode && compactProfile && (
              <button
                id="profile-accordion-profile"
                type="button"
                className="sj-profile-accordion-trigger"
                aria-expanded={activeSection === 'profile'}
                aria-controls="profile-panel-profile"
                onClick={() => setActiveSection((section) => (
                  section === 'profile' ? null : 'profile'
                ))}
              >
                <span className="sj-profile-accordion-icon"><UserPen aria-hidden="true" size={17} /></span>
                <span className="sj-profile-accordion-copy">
                  <strong>Vos informations</strong>
                  <small>Pseudonyme et identité</small>
                </span>
                <ChevronDown className="sj-profile-accordion-chevron" aria-hidden="true" size={17} />
              </button>
            )}
            {!activityMode && <div
              id="profile-panel-profile"
              className={`sj-profile-accordion-panel ${activeSection === 'profile' ? 'sj-profile-accordion-panel-open' : ''}`}
              aria-labelledby={compactProfile ? 'profile-accordion-profile' : undefined}
              aria-hidden={compactProfile ? activeSection !== 'profile' : undefined}
              inert={compactProfile && activeSection !== 'profile' ? '' : undefined}
              role={compactProfile ? 'region' : undefined}
              hidden={!compactProfile && activeContentTab !== 'profile'}
            >
              <div className="sj-profile-accordion-panel-clip">
            <form
              className="sj-profile-form"
              onSubmit={handleSubmit}
            >
              <div className="sj-profile-form-head">
                <h3>Informations personnelles</h3>
                <p><span aria-hidden="true">*</span> Champs obligatoires</p>
              </div>

              <label>
                <span>
                  Pseudonyme de jeu par défaut
                  <span className="sj-profile-required" aria-hidden="true">*</span>
                </span>
                <input
                  value={playerName}
                  onChange={(event) => {
                    setPlayerName(event.target.value.slice(0, 20));
                  }}
                  autoComplete="nickname"
                  maxLength={20}
                  required
                />
              </label>

              <div className="sj-profile-name-grid">
                <label>
                  <span>
                    Prénom
                    <span className="sj-profile-required" aria-hidden="true">*</span>
                  </span>
                  <input
                    ref={firstNameRef}
                    value={firstName}
                    onChange={(event) => {
                      setFirstName(event.target.value.slice(0, 50));
                    }}
                    autoComplete="given-name"
                    maxLength={50}
                    required
                  />
                </label>
                <label>
                  <span>
                    Nom
                    <span className="sj-profile-required" aria-hidden="true">*</span>
                  </span>
                  <input
                    value={lastName}
                    onChange={(event) => {
                      setLastName(event.target.value.slice(0, 50));
                    }}
                    autoComplete="family-name"
                    maxLength={50}
                    required
                  />
                </label>
              </div>

              <fieldset className="sj-profile-leaderboard-settings">
                <legend>Classement</legend>
                <div className="sj-profile-switch-row">
                  <span>
                    <strong>Apparaître dans le classement</strong>
                    <small>{leaderboardVisible ? 'Votre nom et votre position sont visibles.' : 'Votre profil est masqué du classement.'}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={leaderboardVisible}
                    className={`sj-profile-switch ${leaderboardVisible ? 'sj-profile-switch-on' : ''}`}
                    onClick={() => setLeaderboardVisible((visible) => !visible)}
                  >
                    <span aria-hidden="true" />
                    <small>{leaderboardVisible ? 'Oui' : 'Non'}</small>
                  </button>
                </div>
                <div className="sj-profile-leaderboard-format" ref={leaderboardFormatRef}>
                  <span>Nom affiché</span>
                  <button
                    type="button"
                    className="sj-profile-leaderboard-format-trigger"
                    aria-haspopup="listbox"
                    aria-expanded={leaderboardFormatOpen}
                    aria-controls="profile-leaderboard-format-menu"
                    disabled={!leaderboardVisible}
                    onKeyDown={handleLeaderboardFormatTriggerKeyDown}
                    onClick={() => {
                      if (!leaderboardFormatOpen) updateLeaderboardFormatPlacement();
                      setLeaderboardFormatOpen((current) => !current);
                    }}
                  >
                    <span>{selectedLeaderboardName}</span>
                    <ChevronDown aria-hidden="true" size={15} />
                  </button>
                  {leaderboardFormatOpen && leaderboardVisible && (
                    <div
                      id="profile-leaderboard-format-menu"
                      className={`sj-profile-leaderboard-format-menu sj-profile-leaderboard-format-menu-${leaderboardFormatPlacement}`}
                      role="listbox"
                      aria-label="Nom affiché dans le classement"
                      onKeyDown={handleLeaderboardFormatMenuKeyDown}
                    >
                      {leaderboardNameOptions.map((option) => {
                        const selected = option.value === leaderboardNameFormat;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={selected ? 'sj-profile-leaderboard-format-option-selected' : ''}
                            onClick={() => {
                              setLeaderboardNameFormat(option.value);
                              setLeaderboardFormatOpen(false);
                              focusLeaderboardFormatTrigger();
                            }}
                          >
                            <span className="sj-profile-leaderboard-format-check" aria-hidden="true">
                              {selected && <Check size={14} />}
                            </span>
                            <span>{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </fieldset>

              <div className="sj-profile-form-footer">
                <button type="submit" className="sj-btn sj-btn-primary sj-profile-save" disabled={!canSave}>
                  <Save aria-hidden="true" size={17} />
                  {busy ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
            </form>
              </div>
            </div>}

            {!activityMode && compactProfile && (
              <button
                id="profile-accordion-security"
                type="button"
                className="sj-profile-accordion-trigger"
                aria-expanded={activeSection === 'security'}
                aria-controls="profile-panel-security"
                onClick={() => setActiveSection((section) => (
                  section === 'security' ? null : 'security'
                ))}
              >
                <span className="sj-profile-accordion-icon"><ShieldCheck aria-hidden="true" size={17} /></span>
                <span className="sj-profile-accordion-copy">
                  <strong>Sécurité</strong>
                  <small>Mot de passe et suppression</small>
                </span>
                <ChevronDown className="sj-profile-accordion-chevron" aria-hidden="true" size={17} />
              </button>
            )}
            {!activityMode && <div
              id="profile-panel-security"
              className={`sj-profile-accordion-panel ${activeSection === 'security' ? 'sj-profile-accordion-panel-open' : ''}`}
              aria-labelledby={compactProfile ? 'profile-accordion-security' : undefined}
              aria-hidden={compactProfile ? activeSection !== 'security' : undefined}
              inert={compactProfile && activeSection !== 'security' ? '' : undefined}
              role={compactProfile ? 'region' : undefined}
            >
              <div className="sj-profile-accordion-panel-clip">
                {compactProfile && renderSecuritySection()}
              </div>
            </div>}
          </div>
        </div>
      </section>
    </div>
    {discardMode && (
      <div
        className="sj-modal-overlay sj-profile-confirm-overlay sj-fade-in"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDiscardMode(false);
        }}
      >
        <section
          ref={discardModalRef}
          className="sj-confirm-modal sj-profile-discard-modal sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-discard-title"
          aria-describedby="profile-discard-description"
          tabIndex={-1}
        >
          <button
            type="button"
            className="sj-profile-close sj-profile-discard-close"
            onClick={() => setDiscardMode(false)}
            aria-label="Continuer à modifier le profil"
          >
            <X aria-hidden="true" size={20} />
          </button>
          <span className="sj-profile-discard-modal-icon" aria-hidden="true">
            <Save size={22} />
          </span>
          <h2 id="profile-discard-title">Abandonner les modifications ?</h2>
          <p id="profile-discard-description">
            Les informations saisies depuis le dernier enregistrement seront perdues.
          </p>
          <div className="sj-modal-actions sj-profile-discard-actions">
            <button
              ref={discardContinueRef}
              type="button"
              className="sj-btn"
              onClick={() => setDiscardMode(false)}
            >
              Continuer
            </button>
            <button
              type="button"
              className="sj-btn sj-btn-danger"
              onClick={() => {
                setDiscardMode(false);
                onClose();
              }}
            >
              Abandonner
            </button>
          </div>
        </section>
      </div>
    )}
    {deleteMode && (
      <div
        className="sj-modal-overlay sj-profile-delete-overlay sj-fade-in"
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget || securityBusy) return;
          closeDeleteConfirmation();
        }}
      >
        <section
          ref={deleteModalRef}
          className="sj-confirm-modal sj-profile-delete-modal sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-delete-title"
          aria-describedby={reauthenticationRequired ? 'profile-reauthentication-description' : undefined}
          tabIndex={-1}
        >
          <button
            type="button"
            className="sj-profile-close sj-profile-delete-close"
            onClick={closeDeleteConfirmation}
            disabled={!!securityBusy}
            aria-label="Fermer la confirmation"
          >
            <X aria-hidden="true" size={20} />
          </button>
          {reauthenticationRequired ? (
            <>
              <span className="sj-profile-delete-modal-icon sj-profile-reauthentication-icon" aria-hidden="true">
                <KeyRound size={23} />
              </span>
              <h2 id="profile-delete-title">Reconnectez-vous</h2>
              <p id="profile-reauthentication-description">
                Pour protéger votre compte, une connexion récente est nécessaire avant sa suppression.
              </p>
              <div className="sj-modal-actions sj-profile-delete-actions">
                <button
                  type="button"
                  className="sj-btn"
                  onClick={closeDeleteConfirmation}
                  disabled={!!securityBusy}
                >
                  Annuler
                </button>
                <button
                  ref={reauthenticationButtonRef}
                  type="button"
                  className="sj-btn sj-btn-primary"
                  onClick={handleReauthentication}
                  disabled={!!securityBusy}
                >
                  {securityBusy === 'reauthentication' ? 'Déconnexion…' : 'Se reconnecter'}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="sj-profile-delete-modal-icon" aria-hidden="true">
                <Trash2 size={23} />
              </span>
              <h2 id="profile-delete-title">Supprimer votre compte ?</h2>
              <label className="sj-profile-delete-field">
                <span>
                  Pour confirmer, saisissez <strong>{user.email}</strong>
                </span>
                <input
                  ref={deleteConfirmationRef}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value.slice(0, 254))}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="Adresse e-mail"
                  disabled={securityBusy === 'delete'}
                />
              </label>
              <div className="sj-modal-actions sj-profile-delete-actions">
                <button
                  type="button"
                  className="sj-btn"
                  onClick={closeDeleteConfirmation}
                  disabled={securityBusy === 'delete'}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="sj-btn sj-btn-danger"
                  onClick={handleAccountDelete}
                  disabled={securityBusy === 'delete'
                    || deleteConfirmation.trim().toLowerCase() !== user.email.toLowerCase()}
                >
                  {securityBusy === 'delete' ? 'Suppression…' : 'Supprimer'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    )}
    </>
  );
}
