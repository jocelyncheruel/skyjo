import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  History,
  IdCard,
  KeyRound,
  LogIn,
  LoaderCircle,
  Mail,
  Save,
  ShieldCheck,
  Trash2,
  UserPen,
  UserRound,
  X,
} from 'lucide-react';
import { useAuth } from './authContext.js';

const PROFILE_COMPACT_QUERY = '(max-width: 760px)';
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
      aria-label="Ouvrir mon profil"
      aria-haspopup="dialog"
      title="Mon profil"
    >
      <UserRound aria-hidden="true" size={17} />
    </button>
  );
}

export default function ProfileModal({ open, onClose, onProfileUpdated }) {
  const {
    user, updateProfile, requestProfilePasswordChange, deleteAccount,
  } = useAuth();
  const profileModalRef = useRef(null);
  const deleteModalRef = useRef(null);
  const discardModalRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const discardContinueRef = useRef(null);
  const firstNameRef = useRef(null);
  const deleteConfirmationRef = useRef(null);
  const wasOpenRef = useRef(false);
  const notificationSerialRef = useRef(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [busy, setBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState('');
  const [notification, setNotification] = useState(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [discardMode, setDiscardMode] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [activeSection, setActiveSection] = useState('account');
  const [compactProfile, setCompactProfile] = useState(() => mediaMatches(PROFILE_COMPACT_QUERY));
  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName.trim();
  const normalizedPlayerName = playerName.trim();
  const hasChanges = Boolean(user) && (
    normalizedFirstName !== user.firstName
    || normalizedLastName !== user.lastName
    || normalizedPlayerName !== user.playerName
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
    setSecurityBusy('');
    setNotification(null);
    setDeleteMode(false);
    setDiscardMode(false);
    setDeleteConfirmation('');
    setActiveSection('account');
    const shouldFocusForm = mediaMatches('(min-width: 761px) and (pointer: fine)');
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = shouldFocusForm ? firstNameRef.current : profileModalRef.current;
      focusTarget?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open, user]);

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
      if (deleteMode) {
        setDeleteMode(false);
        setDeleteConfirmation('');
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
  }, [busy, deleteMode, discardMode, hasChanges, onClose, open, securityBusy]);

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
  const providerLabel = hasGoogleProvider && hasEmailProvider
    ? 'Google et e-mail'
    : hasGoogleProvider ? 'Google' : 'E-mail';
  const savedDisplayName = user.displayName
    || `${user.firstName || ''} ${user.lastName || ''}`.trim()
    || user.email;

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

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const updatedUser = await updateProfile({
        firstName: normalizedFirstName,
        lastName: normalizedLastName,
        playerName: normalizedPlayerName,
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
      showNotification('error', deleteError.message || 'Impossible de supprimer le compte.');
      setSecurityBusy('');
    }
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
        className="sj-profile-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        aria-hidden={deleteMode || discardMode || undefined}
        inert={deleteMode || discardMode ? '' : undefined}
        tabIndex={-1}
      >
        <header className="sj-profile-head">
          <div>
            <span>Votre compte</span>
            <h2 id="profile-title">Mon profil</h2>
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
          {compactProfile && (
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
                <strong>Mon compte</strong>
                <small>Identité et activité</small>
              </span>
              <ChevronDown className="sj-profile-accordion-chevron" aria-hidden="true" size={17} />
            </button>
          )}
          <div
            id="profile-panel-account"
            className={`sj-profile-accordion-panel ${activeSection === 'account' ? 'sj-profile-accordion-panel-open' : ''}`}
            aria-labelledby={compactProfile ? 'profile-accordion-account' : undefined}
            aria-hidden={compactProfile ? activeSection !== 'account' : undefined}
            inert={compactProfile && activeSection !== 'account' ? '' : undefined}
            role={compactProfile ? 'region' : undefined}
          >
            <div className="sj-profile-accordion-panel-clip">
            <aside className="sj-profile-sidebar" aria-label={compactProfile ? undefined : 'Résumé du compte'}>
            <div className="sj-profile-identity">
              <strong>{savedDisplayName}</strong>
            </div>
            <span className="sj-profile-provider">
              <LogIn aria-hidden="true" size={14} /> {providerLabel}
            </span>

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
            </aside>
            </div>
          </div>

          <div className="sj-profile-main">
            {compactProfile && (
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
                  <strong>Mes informations</strong>
                  <small>Pseudonyme et identité</small>
                </span>
                <ChevronDown className="sj-profile-accordion-chevron" aria-hidden="true" size={17} />
              </button>
            )}
            <div
              id="profile-panel-profile"
              className={`sj-profile-accordion-panel ${activeSection === 'profile' ? 'sj-profile-accordion-panel-open' : ''}`}
              aria-labelledby={compactProfile ? 'profile-accordion-profile' : undefined}
              aria-hidden={compactProfile ? activeSection !== 'profile' : undefined}
              inert={compactProfile && activeSection !== 'profile' ? '' : undefined}
              role={compactProfile ? 'region' : undefined}
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

              <div className="sj-profile-form-footer">
                <button type="submit" className="sj-btn sj-btn-primary sj-profile-save" disabled={!canSave}>
                  <Save aria-hidden="true" size={17} />
                  {busy ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
            </form>
              </div>
            </div>

            {compactProfile && (
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
            <div
              id="profile-panel-security"
              className={`sj-profile-accordion-panel ${activeSection === 'security' ? 'sj-profile-accordion-panel-open' : ''}`}
              aria-labelledby={compactProfile ? 'profile-accordion-security' : undefined}
              aria-hidden={compactProfile ? activeSection !== 'security' : undefined}
              inert={compactProfile && activeSection !== 'security' ? '' : undefined}
              role={compactProfile ? 'region' : undefined}
            >
              <div className="sj-profile-accordion-panel-clip">
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
              </div>
            </div>
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
          if (event.target !== event.currentTarget || securityBusy === 'delete') return;
          setDeleteMode(false);
          setDeleteConfirmation('');
        }}
      >
        <section
          ref={deleteModalRef}
          className="sj-confirm-modal sj-profile-delete-modal sj-pop-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-delete-title"
          tabIndex={-1}
        >
          <button
            type="button"
            className="sj-profile-close sj-profile-delete-close"
            onClick={() => {
              setDeleteMode(false);
              setDeleteConfirmation('');
            }}
            disabled={securityBusy === 'delete'}
            aria-label="Fermer la confirmation"
          >
            <X aria-hidden="true" size={20} />
          </button>
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
              onClick={() => {
                setDeleteMode(false);
                setDeleteConfirmation('');
              }}
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
        </section>
      </div>
    )}
    </>
  );
}
