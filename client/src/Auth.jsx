import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FileText,
  LockKeyhole,
  LogOut,
  Mail,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  apiFetch,
  AUTH_REMEMBER_KEY,
  clearBrowserAuthArtifacts,
  SERVER_URL,
  setCsrfToken,
} from "./apiClient.js";
import { AuthContext, useAuth } from "./authContext.js";

const LAST_EMAIL_KEY = "skyjo_last_email";
const AUTH_CONFIGURATION_ERROR =
  "La connexion n'est pas configurée. Ajoute l'URL publique du serveur Render au client.";
const EMAIL_ACTION_PATH = "/auth/confirm";
const OAUTH_CALLBACK_PATH = "/auth/callback";
const EMAIL_ACTION_TYPES = new Set(["email", "recovery"]);
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || "";
const TURNSTILE_CONFIGURATION_ERROR = "La protection anti-robot n'est pas configurée.";
let capturedEmailAction = null;

function normalizeEmail(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase().slice(0, 254);
}

function normalizeAuthName(value) {
  return [...String(value || "").normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ").trim()].slice(0, 50).join("");
}

function takeEmailActionFromUrl() {
  if (capturedEmailAction || typeof window === "undefined") return capturedEmailAction;

  const url = new URL(window.location.href);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path !== EMAIL_ACTION_PATH) return null;

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const tokenHash = fragment.get("token_hash") || "";
  const type = fragment.get("type") || "";

  url.pathname = url.pathname.replace(/\/auth\/confirm\/?$/, "/");
  url.search = "";
  url.hash = "";
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}`);

  if (!tokenHash || !EMAIL_ACTION_TYPES.has(type)) {
    capturedEmailAction = { invalid: true, type };
    return capturedEmailAction;
  }
  capturedEmailAction = { tokenHash, type, invalid: false };
  return capturedEmailAction;
}

function takeOAuthResultFromUrl() {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path !== OAUTH_CALLBACK_PATH) return "";
  const status = url.searchParams.get("status") || "";
  window.history.replaceState({}, document.title, "/");
  return ["success", "failed"].includes(status) ? status : "failed";
}

function requireAuthConfiguration(setError) {
  if (SERVER_URL) return;
  const configurationError = new Error(AUTH_CONFIGURATION_ERROR);
  setError(configurationError.message);
  throw configurationError;
}

function getAuthErrorMessage(error) {
  if (error?.friendlyMessage) return error.friendlyMessage;
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();

  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "Ton adresse e-mail n'est pas encore confirmée.";
  }
  if (
    code === "authentication_failed" || code === "invalid_credentials"
    || code === "user_already_exists" || code === "email_exists"
    || message.includes("invalid login credentials")
  ) {
    return "Impossible de finaliser l'authentification avec ces informations.";
  }
  if (code === "signup_disabled") {
    return "La création de compte est temporairement indisponible.";
  }
  if (
    code === "provider_disabled" ||
    code === "oauth_provider_not_supported" ||
    message.includes("provider is not enabled")
  ) {
    return "La connexion avec Google n'est pas disponible pour le moment.";
  }
  if (code === "bad_oauth_state") {
    return "La connexion avec Google a expiré. Réessaie.";
  }
  if (code === "rate_limited" || code === "over_request_rate_limit" || message.includes("rate limit")) {
    return "Trop de tentatives. Réessaie dans quelques minutes.";
  }
  if (code === "captcha_failed" || code === "csrf_failed") {
    return "La vérification de sécurité a échoué. Recharge la page puis réessaie.";
  }
  if (code === "weak_password") {
    return "Ce mot de passe n'est pas assez robuste.";
  }
  if (code === "same_password") {
    return "Choisis un mot de passe différent de l'ancien.";
  }
  if (code === "invalid_profile") {
    return String(error?.message || "Vérifie les informations de ton profil.").slice(0, 200);
  }
  if ([
    "active_rooms",
    "invalid_account_confirmation",
    "password_unavailable",
    "recent_authentication_required",
  ].includes(code)) {
    return String(error?.message || "Cette action ne peut pas être effectuée.").slice(0, 200);
  }
  if (code === "invalid_password" || code === "recent_recovery_required") {
    return String(error?.message || "Demande un nouveau lien de réinitialisation.").slice(0, 200);
  }
  if (code === "otp_expired") {
    return "Ce lien a expiré. Demande un nouvel e-mail de réinitialisation.";
  }

  return "Une erreur d'authentification est survenue. Réessaie dans un instant.";
}

async function authApi(path, options, fallback = "Une erreur d'authentification est survenue.") {
  const response = await apiFetch(path, options);
  let data = null;
  try { data = response.status === 204 ? null : await response.json(); }
  catch { data = null; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || fallback);
    error.code = data?.error?.code || "auth_failed";
    throw error;
  }
  return data;
}

function saveRememberPreference(remember) {
  localStorage.setItem(AUTH_REMEMBER_KEY, String(Boolean(remember)));
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [pendingEmailAction, setPendingEmailAction] = useState(null);

  useEffect(() => {
    if (!SERVER_URL) {
      setError(AUTH_CONFIGURATION_ERROR);
      setReady(true);
      return undefined;
    }
    let cancelled = false;

    async function initializeAuth() {
      try {
        const oauthResult = takeOAuthResultFromUrl();

        const emailAction = takeEmailActionFromUrl();
        if (emailAction) {
          if (!cancelled) setPendingEmailAction(emailAction);
          return;
        }

        const data = await authApi('/api/auth/session', undefined, 'Impossible de vérifier la session.');
        if (!cancelled) {
          setCsrfToken(data?.csrfToken);
          setUser(data?.user || null);
          setRecoveryMode(data?.recovery === true);
          if (oauthResult === "failed") setError("La connexion avec Google a échoué. Réessaie.");
        }
      } catch (authError) {
        if (!cancelled) {
          setUser(null);
          setRecoveryMode(false);
          setError(getAuthErrorMessage(authError));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    initializeAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const expire = () => {
      clearBrowserAuthArtifacts();
      setUser(null);
      setRecoveryMode(false);
    };
    window.addEventListener('skyjo:session-expired', expire);
    return () => window.removeEventListener('skyjo:session-expired', expire);
  }, []);

  const confirmEmailAction = useCallback(async () => {
    if (!pendingEmailAction || pendingEmailAction.invalid) {
      const message = "Ce lien de confirmation est invalide ou incomplet.";
      setError(message);
      throw new Error(message);
    }
    const { tokenHash, type } = pendingEmailAction;
    try {
      const data = await authApi('/api/auth/email/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenHash,
          type,
          remember: localStorage.getItem(AUTH_REMEMBER_KEY) === 'true',
        }),
      });
      capturedEmailAction = null;
      setPendingEmailAction(null);
      setCsrfToken(data?.csrfToken);
      if (data?.recovery) setRecoveryMode(true);
      setUser(data?.user || null);
    } catch (actionError) {
      const message = getAuthErrorMessage(actionError);
      setError(message);
      throw new Error(message);
    }
  }, [pendingEmailAction]);

  const login = useCallback(async (email, password, remember, captchaToken) => {
    setError("");
    requireAuthConfiguration(setError);
    saveRememberPreference(remember);
    try {
      const data = await authApi('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          remember,
          captchaToken,
          preferredLocale: navigator.language,
        }),
      });
      setCsrfToken(data?.csrfToken);
      setUser(data?.user || null);
      if (remember) localStorage.setItem(LAST_EMAIL_KEY, email);
      else localStorage.removeItem(LAST_EMAIL_KEY);
      return data?.user || null;
    } catch (authError) {
      const message = getAuthErrorMessage(authError);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const register = useCallback(
    async ({ email, password, firstName, lastName, captchaToken, remember = false }) => {
      setError("");
      requireAuthConfiguration(setError);
      saveRememberPreference(remember);
      try {
        const data = await authApi('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password,
            firstName,
            lastName,
            captchaToken,
            remember,
            preferredLocale: navigator.language,
          }),
        });
        if (remember) localStorage.setItem(LAST_EMAIL_KEY, email);
        else localStorage.removeItem(LAST_EMAIL_KEY);
        if (data?.user) {
          setCsrfToken(data.csrfToken);
          setUser(data.user);
        }
        return { confirmationRequired: data?.confirmationRequired !== false };
      } catch (authError) {
        const message = getAuthErrorMessage(authError);
        setError(message);
        throw new Error(message);
      }
    },
    [],
  );

  const loginWithGoogle = useCallback(async (remember = false, captchaToken = "") => {
    setError("");
    requireAuthConfiguration(setError);
    saveRememberPreference(remember);
    try {
      const data = await authApi('/api/auth/google/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remember,
          captchaToken,
          preferredLocale: navigator.language,
        }),
      });
      if (!data?.url) throw new Error("La connexion avec Google n'est pas disponible.");
      window.location.assign(data.url);
    } catch (authError) {
      const message = getAuthErrorMessage(authError);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const requestPasswordReset = useCallback(async (email, captchaToken) => {
    setError("");
    requireAuthConfiguration(setError);
    try {
      await authApi('/api/auth/password/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, captchaToken }),
      });
    } catch (requestError) {
      const message = requestError instanceof TypeError
        ? "Impossible de contacter le service d'authentification. Vérifie ta connexion."
        : getAuthErrorMessage(requestError);
      setError(message);
      throw requestError;
    }
  }, []);

  const updatePassword = useCallback(async (password) => {
    setError("");
    requireAuthConfiguration(setError);
    try {
      await authApi('/api/auth/password/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch (authError) {
      const message = getAuthErrorMessage(authError);
      setError(message);
      throw new Error(message);
    }
    clearBrowserAuthArtifacts();
    localStorage.removeItem(LAST_EMAIL_KEY);
    setUser(null);
    setRecoveryMode(false);
  }, []);

  const updateProfile = useCallback(async ({ firstName, lastName, playerName }) => {
    setError("");
    requireAuthConfiguration(setError);
    try {
      const data = await authApi('/api/auth/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, playerName }),
      }, 'Impossible de mettre à jour le profil.');
      if (!data?.user) throw new Error('Le profil mis à jour est indisponible.');
      setUser(data.user);
      return data.user;
    } catch (profileError) {
      const message = profileError instanceof TypeError
        ? "Impossible de contacter le service d'authentification. Vérifie ta connexion."
        : getAuthErrorMessage(profileError);
      throw new Error(message);
    }
  }, []);

  const requestProfilePasswordChange = useCallback(async () => {
    try {
      await authApi('/api/auth/password/change-request', { method: 'POST' }, "Impossible d'envoyer l'e-mail de modification.");
    } catch (requestError) {
      const message = requestError instanceof TypeError
        ? "Impossible de contacter le service d'authentification. Vérifie ta connexion."
        : getAuthErrorMessage(requestError);
      throw new Error(message);
    }
  }, []);

  const deleteAccount = useCallback(async (confirmationEmail) => {
    try {
      await authApi('/api/auth/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationEmail }),
      }, 'Impossible de supprimer le compte.');
      clearBrowserAuthArtifacts();
      localStorage.removeItem(LAST_EMAIL_KEY);
      setUser(null);
      setRecoveryMode(false);
    } catch (deleteError) {
      const message = deleteError instanceof TypeError
        ? "Impossible de contacter le service d'authentification. Vérifie ta connexion."
        : getAuthErrorMessage(deleteError);
      const profileError = new Error(message);
      profileError.code = String(deleteError?.code || '');
      throw profileError;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      if (SERVER_URL) await authApi('/api/auth/logout', { method: 'POST' });
    } catch {
      setError("La session locale est fermée, mais la révocation globale n'a pas pu être confirmée.");
    } finally {
      clearBrowserAuthArtifacts();
      localStorage.removeItem(LAST_EMAIL_KEY);
      setUser(null);
      setRecoveryMode(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      error,
      recoveryMode,
      pendingEmailAction,
      confirmEmailAction,
      login,
      loginWithGoogle,
      register,
      requestPasswordReset,
      updatePassword,
      updateProfile,
      requestProfilePasswordChange,
      deleteAccount,
      logout,
      clearError: () => setError(""),
    }),
    [
      user,
      ready,
      error,
      recoveryMode,
      pendingEmailAction,
      confirmEmailAction,
      login,
      loginWithGoogle,
      register,
      requestPasswordReset,
      updatePassword,
      updateProfile,
      requestProfilePasswordChange,
      deleteAccount,
      logout,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function AuthField({ label, icon: Icon, action, ...props }) {
  return (
    <label className="auth-field">
      <span>{label}</span>
      <div>
        {Icon && (
          <Icon className="auth-field-icon" aria-hidden="true" size={16} />
        )}
        <input className={Icon ? "has-icon" : ""} {...props} />
        {action && <span className="auth-field-action">{action}</span>}
      </div>
    </label>
  );
}

let turnstileScriptPromise = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-skyjo-turnstile]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.turnstile), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.skyjoTurnstile = "true";
    script.onload = () => resolve(window.turnstile);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

function TurnstileWidget({ onToken, resetSignal }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setVisible(container.getBoundingClientRect().height > 0);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !containerRef.current) return undefined;
    let cancelled = false;
    loadTurnstile().then((turnstile) => {
      if (cancelled || !turnstile || !containerRef.current) return;
      widgetIdRef.current = turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "light",
        language: "fr",
        size: containerRef.current.getBoundingClientRect().width < 300 ? "compact" : "flexible",
        appearance: "interaction-only",
        callback: (token) => onToken(token),
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
        "timeout-callback": () => onToken(""),
      });
    }).catch(() => onToken(""));
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
  }, [onToken]);

  useEffect(() => {
    if (widgetIdRef.current !== null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      onToken("");
    }
  }, [resetSignal, onToken]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div className={`auth-turnstile${visible ? " is-visible" : ""}`} ref={containerRef} aria-label="Vérification anti-robot" />;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.41Z" />
      <path fill="#34a853" d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
      <path fill="#fbbc05" d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.48l3.35-2.62Z" />
      <path fill="#ea4335" d="M12 6.01c1.47 0 2.78.5 3.82 1.49l2.88-2.88A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z" />
    </svg>
  );
}

function AuthLogoMark() {
  return (
    <div className="auth-logo-frame" aria-hidden="true">
      <img
        className="auth-logo-image"
        src="/skyjo-logo.svg"
        alt=""
        width="116"
        height="116"
      />
    </div>
  );
}

function AuthMobileBrand({ heading = false }) {
  return (
    <div className={`auth-mobile-brand${heading ? " auth-home-brand" : ""}`}>
      <AuthLogoMark />
      {heading ? <h1>Skyjo en ligne</h1> : <span>Skyjo en ligne</span>}
    </div>
  );
}

function LegalConsent({
  accepted,
  canAccept,
  onChange,
  onOpen,
  readDocuments,
}) {
  return (
    <div className="auth-terms">
      <input
        id="accept-terms"
        type="checkbox"
        name="acceptTerms"
        checked={accepted}
        onChange={onChange}
        disabled={!canAccept}
      />
      <span>
        <label htmlFor="accept-terms">J'accepte les </label>
        <button
          type="button"
          className={readDocuments.terms ? "auth-legal-link-read" : ""}
          onClick={() => onOpen("terms")}
        >
          conditions d'utilisation
        </button>
        {readDocuments.terms && (
          <span className="auth-legal-read-check" aria-label="lu">
            {" "}✓
          </span>
        )}
        <label htmlFor="accept-terms"> et la </label>
        <button
          type="button"
          className={readDocuments.privacy ? "auth-legal-link-read" : ""}
          onClick={() => onOpen("privacy")}
        >
          politique de confidentialité
        </button>
        {readDocuments.privacy && (
          <span className="auth-legal-read-check" aria-label="lu">
            {" "}✓
          </span>
        )}
        <label htmlFor="accept-terms">.</label>
      </span>
    </div>
  );
}

function AuthMessageToast({
  message,
  type = "error",
  onDismiss,
  duration = 4500,
}) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!message || duration <= 0) return undefined;
    const timeout = window.setTimeout(() => {
      onDismissRef.current?.();
    }, duration);
    return () => window.clearTimeout(timeout);
  }, [duration, message]);

  if (!message) return null;
  const isError = type === "error";
  return (
    <div
      className={`sj-game-toast auth-page-toast ${isError ? "sj-game-toast-error auth-error-toast" : "auth-success-toast"}`}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <span className="sj-game-toast-icon" aria-hidden="true">
        {isError ? "!" : <Check size={15} />}
      </span>
      <span className="sj-game-toast-text">{message}</span>
    </div>
  );
}

const LEGAL_DOCUMENTS = {
  terms: {
    eyebrow: "Règles du service",
    title: "Conditions d'utilisation",
    sections: [
      [
        "Service proposé",
        "Skyjo en ligne permet, après authentification, de créer ou rejoindre une salle privée ou publique et de jouer. Une salle accueille jusqu'à huit joueurs et propose les modes Classique et Action.",
      ],
      [
        "Compte et accès",
        "Tu peux créer ton compte avec une adresse e-mail et un mot de passe ou continuer avec ton compte Google. Tu dois fournir des informations exactes, protéger tes moyens de connexion et ne pas utiliser le compte ou la place de jeu d'une autre personne. Tu es responsable des actions réalisées depuis ta session.",
      ],
      [
        "Salles publiques et privées",
        "Une salle publique apparaît dans la recherche avec le pseudonyme de son créateur, son mode et son nombre de joueurs. Une salle privée est accessible avec son code d'invitation aléatoire : partage ce code uniquement avec les personnes que tu souhaites inviter.",
      ],
      [
        "Messages et pseudonymes",
        "Les pseudonymes et messages du chat sont visibles par les participants de la salle. Tous les messages acceptés sont enregistrés séparément de l'état du jeu jusqu'à la suppression de la salle. Tu restes responsable de leur contenu. Les propos illicites, injurieux, menaçants, discriminatoires, le harcèlement et l'usurpation d'identité sont interdits.",
      ],
      [
        "Utilisation loyale",
        "Il est interdit de contourner l'authentification, d'accéder à la session d'un autre joueur, d'automatiser abusivement les requêtes, de perturber une partie ou de tenter de compromettre le client, le serveur ou la base de données. Des limites de requêtes peuvent temporairement bloquer les abus.",
      ],
      [
        "Conservation des salles",
        "Une activité ou une reconnexion met à jour la salle. Après 24 heures d'inactivité, la salle, son historique et tous ses messages sont supprimés lors du prochain nettoyage automatique du serveur.",
      ],
      [
        "Disponibilité",
        "Le service peut évoluer ou être temporairement indisponible en raison d'une maintenance, d'une panne du serveur, du réseau ou d'un prestataire d'hébergement. Aucune disponibilité permanente ni conservation au-delà des durées annoncées n'est garantie.",
      ],
    ],
  },
  privacy: {
    eyebrow: "Tes données",
    title: "Politique de confidentialité",
    sections: [
      [
        "Données du compte",
        "Le service traite ton adresse e-mail, ton prénom, ton nom, ton pseudonyme de jeu par défaut, ton identifiant Supabase et les informations techniques de ta session d'authentification. Render transmet les identifiants de connexion à Supabase Auth sans enregistrer le mot de passe. Si tu continues avec Google, Google transmet à Supabase les informations de base autorisées pour ton compte, notamment ton identité et ton adresse e-mail. Le mot de passe n'est jamais enregistré dans l'état des salles.",
      ],
      [
        "Données de jeu",
        "Pour faire fonctionner une salle, le serveur enregistre son code, sa visibilité, son mode, les identifiants de compte et de joueur, les pseudonymes, les connexions, les cartes, les tours, les scores, l'historique nécessaire à la partie et, dans une table séparée, tous les messages acceptés pendant toute la durée de conservation de la salle.",
      ],
      [
        "Données techniques et stockage local",
        "L'adresse IP est utilisée temporairement en mémoire pour limiter les requêtes abusives. Le navigateur reçoit uniquement un identifiant de session aléatoire dans un cookie HttpOnly, Secure et SameSite, inaccessible au JavaScript. Les jetons Supabase restent chiffrés côté serveur. Si tu choisis « Se souvenir de moi », le cookie peut persister jusqu'à sept jours ; sinon il disparaît à la fermeture du navigateur. Le navigateur peut conserver la préférence, le pseudonyme et le code de la dernière salle. Aucun jeton de reconnexion joueur distinct n'est utilisé.",
      ],
      [
        "Finalités",
        "Ces données servent uniquement à créer et sécuriser le compte, authentifier les requêtes, créer et rejoindre les salles, synchroniser les parties, permettre la reconnexion, afficher le chat et limiter les abus.",
      ],
      [
        "Hébergement",
        <>
          Les comptes et données persistantes sont stockés chez{" "}
          <a href="https://supabase.com/" target="_blank" rel="noreferrer">Supabase</a>.
          Le serveur est hébergé chez{" "}
          <a href="https://render.com/" target="_blank" rel="noreferrer">Render</a>{" "}
          et le client est publié sur{" "}
          <a href="https://pages.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare Pages</a>.
        </>,
      ],
      [
        "Conservation",
        "Le compte est conservé jusqu'à sa suppression. Une session BFF expire après 24 heures d'inactivité et au plus tard après sept jours ; elle est aussi supprimée lors d'une déconnexion globale. Avec la configuration actuelle, une salle devient éligible à la suppression après 24 heures sans activité enregistrée ; elle est supprimée avec son historique et ses messages lors du prochain nettoyage automatique. Une reconnexion ou une action avant ce nettoyage actualise sa date d'activité. Les limites de requêtes sont conservées uniquement en mémoire pendant leur courte fenêtre de contrôle. Les données du navigateur restent présentes jusqu'à la déconnexion, la sortie de salle ou leur effacement manuel, selon leur nature.",
      ],
      [
        "Visibilité et destinataires",
        "Les participants d'une salle reçoivent les informations nécessaires à la partie et les messages du chat. Pour une salle publique, les utilisateurs authentifiés peuvent voir le pseudonyme du créateur, le mode et le nombre de joueurs. Supabase, Render et Cloudflare traitent les données techniques nécessaires à leurs services. Google intervient uniquement lorsque tu choisis cette méthode de connexion. Les données ne sont pas vendues.",
      ],
      [
        "Sécurité",
        "Les accès au jeu exigent une session BFF encore valide, adossée à une session Supabase confirmée et active. Chaque place est liée côté serveur à l'identifiant du compte ; les rôles ou identifiants transmis par le navigateur ne font pas autorité.",
      ],
      [
        "Tes choix et tes droits",
        <>
          Tu peux modifier les informations de ton profil et supprimer ton compte directement depuis l'application après avoir quitté tes salles. Tu peux également refuser la mémorisation durable de ta session ou te déconnecter. Pour toute autre demande d'accès, de rectification, de limitation ou d'opposition lorsque ces droits s'appliquent, écris à{" "}
          <a href="mailto:support@jocelyncheruel.dev">support@jocelyncheruel.dev</a>.
        </>,
      ],
    ],
  },
};

export function LegalPage({ documentId }) {
  const document = LEGAL_DOCUMENTS[documentId];

  useEffect(() => {
    if (!document) return undefined;
    const previousTitle = window.document.title;
    window.document.title = `${document.title} | Skyjo en ligne`;
    return () => {
      window.document.title = previousTitle;
    };
  }, [document]);

  if (!document) return null;

  return (
    <main className="legal-page">
      <article className="legal-page-card">
        <header className="legal-page-header">
          <a className="legal-page-brand" href="/" aria-label="Retour à Skyjo">
            <AuthMobileBrand />
          </a>
          <p>{document.eyebrow}</p>
          <h1>{document.title}</h1>
          <p className="legal-page-date">Dernière mise à jour : 15 juillet 2026</p>
        </header>
        <div className="legal-page-content">
          {document.sections.map(([title, content]) => (
            <section key={title}>
              <h2>{title}</h2>
              <p>{content}</p>
            </section>
          ))}
        </div>
        <footer className="legal-page-footer">
          <a href={documentId === "privacy" ? "/terms" : "/privacy"}>
            {documentId === "privacy"
              ? "Consulter les conditions d'utilisation"
              : "Consulter la politique de confidentialité"}
          </a>
          <a href="/">Retour à Skyjo</a>
        </footer>
      </article>
    </main>
  );
}

function LegalModal({ documentId, onClose, onAcknowledge }) {
  const document = LEGAL_DOCUMENTS[documentId];
  const contentRef = useRef(null);
  const [hasReachedEnd, setHasReachedEnd] = useState(false);

  const checkReadingProgress = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const reachedEnd =
      content.scrollTop + content.clientHeight >= content.scrollHeight - 4;
    if (reachedEnd) setHasReachedEnd(true);
  }, []);

  useEffect(() => {
    setHasReachedEnd(false);
    const frame = window.requestAnimationFrame(checkReadingProgress);
    return () => window.cancelAnimationFrame(frame);
  }, [documentId, checkReadingProgress]);

  useEffect(() => {
    if (!document) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document, onClose]);

  if (!document) return null;
  return (
    <div className="auth-legal-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-legal-modal" role="dialog" aria-modal="true" aria-labelledby="auth-legal-title">
        <header className="auth-legal-header">
          <div>
            <p>{document.eyebrow}</p>
            <h2 id="auth-legal-title">{document.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <p className="auth-legal-date">Dernière mise à jour : 15 juillet 2026</p>
        <div
          ref={contentRef}
          className="auth-legal-content"
          onScroll={checkReadingProgress}
        >
          {document.sections.map(([title, content]) => (
            <section key={title}>
              <h3>{title}</h3>
              <p>{content}</p>
            </section>
          ))}
        </div>
        <button
          type="button"
          className="auth-legal-close"
          disabled={!hasReachedEnd}
          onClick={() => onAcknowledge(documentId)}
        >
          J'ai lu
        </button>
      </section>
    </div>
  );
}

function AuthStoryPanel() {
  return (
    <aside className="auth-story">
      <div className="auth-grain" />
      <div className="auth-brand">
        <AuthLogoMark /> Skyjo en ligne
      </div>
      <div className="auth-copy">
        <p className="auth-kicker">Jeu de cartes multijoueur</p>
        <h1>Skyjo en ligne</h1>
        <p>
          Skyjo en ligne permet de créer une salle privée ou publique,
          d'inviter ses proches et de jouer ensemble à distance.
        </p>
      </div>
      <p className="auth-quote">
        « Le 12 est quand même plus joli chez l’adversaire. »
      </p>
    </aside>
  );
}

export function AuthLoadingView({ label = "Chargement" }) {
  return (
    <main className="auth-page" aria-label={label} aria-busy="true">
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <section className="auth-shell" aria-label="Authentification Skyjo">
        <AuthStoryPanel />
        <div className="auth-form-panel auth-loading-form-panel">
          <div className="auth-form-inner">
            <AuthMobileBrand heading />
            <p className="auth-loading-description">
              Skyjo en ligne permet de créer une salle privée ou publique,
              d'inviter ses proches et de jouer ensemble à distance.
            </p>
            <div className="auth-loading-status" role="status">
              <span aria-hidden="true" />
              <p>Chargement...</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export function ConsentGate({ onAccept, onLogout, error = "", busy = false }) {
  const [legalDocument, setLegalDocument] = useState(null);
  const [readDocuments, setReadDocuments] = useState({ terms: false, privacy: false });
  const ready = readDocuments.terms && readDocuments.privacy;
  return (
    <main className="auth-page">
      <AuthMessageToast message={error} />
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <section className="auth-shell auth-consent-shell" aria-label="Consentement Skyjo">
        <AuthStoryPanel />
        <div className="auth-form-panel auth-consent-form-panel is-animated">
          <div className="auth-form-inner auth-consent-panel is-animated">
            <AuthMobileBrand />
            <div className="auth-heading auth-consent-heading">
              <p className="auth-eyebrow">Avant de rejoindre la table</p>
              <h2>Valide les documents</h2>
              <p>Consulte les versions actuelles pour accéder au jeu.</p>
            </div>
            <div className="auth-consent-actions">
              <div className={`auth-consent-document${readDocuments.terms ? " is-read" : ""}`}>
                <button type="button" onClick={() => setLegalDocument("terms")}>
                  <span className="auth-consent-document-icon" aria-hidden="true"><FileText size={19} /></span>
                  <span className="auth-consent-document-copy">
                    <strong>Conditions d'utilisation</strong>
                    {!readDocuments.terms && <small>Ouvrir et lire jusqu'en bas</small>}
                  </span>
                  <ArrowRight className="auth-consent-document-arrow" size={18} aria-hidden="true" />
                </button>
                {readDocuments.terms && (
                  <span className="auth-consent-read-badge" aria-label="Conditions d'utilisation lues">
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
              </div>
              <div className={`auth-consent-document${readDocuments.privacy ? " is-read" : ""}`}>
                <button type="button" onClick={() => setLegalDocument("privacy")}>
                  <span className="auth-consent-document-icon" aria-hidden="true"><ShieldCheck size={19} /></span>
                  <span className="auth-consent-document-copy">
                    <strong>Politique de confidentialité</strong>
                    {!readDocuments.privacy && <small>Ouvrir et lire jusqu'en bas</small>}
                  </span>
                  <ArrowRight className="auth-consent-document-arrow" size={18} aria-hidden="true" />
                </button>
                {readDocuments.privacy && (
                  <span className="auth-consent-read-badge" aria-label="Politique de confidentialité lue">
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
              </div>
            </div>
            <button className="auth-submit auth-consent-submit" type="button" disabled={!ready || busy} onClick={onAccept}>
              {busy ? "Enregistrement..." : "J'accepte et j'accède au jeu"}
              {!busy && <ArrowRight size={17} aria-hidden="true" />}
            </button>
            <button className="auth-consent-logout" type="button" disabled={busy} onClick={onLogout}>
              <LogOut size={15} aria-hidden="true" />
              <span>Se déconnecter</span>
            </button>
          </div>
        </div>
      </section>
      <LegalModal
        documentId={legalDocument}
        onClose={() => setLegalDocument(null)}
        onAcknowledge={(documentId) => {
          setReadDocuments((current) => ({ ...current, [documentId]: true }));
          setLegalDocument(null);
        }}
      />
    </main>
  );
}

export function AuthView() {
  const {
    login,
    loginWithGoogle,
    register,
    requestPasswordReset,
    pendingEmailAction,
    confirmEmailAction,
    error,
    clearError,
  } = useAuth();
  const [mode, setMode] = useState("login");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const [legalDocument, setLegalDocument] = useState(null);
  const [readLegalDocuments, setReadLegalDocuments] = useState({
    terms: false,
    privacy: false,
  });
  const [emailPrefilled, setEmailPrefilled] = useState(() =>
    Boolean(localStorage.getItem(LAST_EMAIL_KEY)),
  );
  const [form, setForm] = useState({
    email: localStorage.getItem(LAST_EMAIL_KEY) || "",
    password: "",
    firstName: "",
    lastName: "",
    confirmPassword: "",
    acceptTerms: false,
    remember: false,
  });
  const score = useMemo(
    () =>
      [
        form.password.length >= 12,
        /[A-Z]/.test(form.password),
        /[0-9]/.test(form.password),
        /[^A-Za-z0-9]/.test(form.password),
      ].filter(Boolean).length,
    [form.password],
  );
  const strength = ["Très faible", "Faible", "Correct", "Fort", "Très fort"][
    score
  ];
  const canContinue =
    form.firstName.trim() &&
    form.lastName.trim() &&
    form.email.length <= 254 && /^\S+@\S+\.\S+$/.test(form.email);
  const canAcceptTerms =
    readLegalDocuments.terms && readLegalDocuments.privacy;
  const securityReady = TURNSTILE_SITE_KEY
    ? Boolean(captchaToken)
    : !import.meta.env.PROD;

  function updateField(event) {
    const { name, value, type, checked } = event.target;
    clearError();
    setLocalError("");
    setNotice("");
    if (name === "email") setEmailPrefilled(false);
    setForm((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
  }
  function goNext() {
    if (!canContinue)
      return setLocalError(
        "Renseigne ton prénom, ton nom et une adresse e-mail valide.",
      );
    setLocalError("");
    setStep(2);
  }
  async function submit(event) {
    event.preventDefault();
    clearError();
    setLocalError("");
    setNotice("");
    if (mode === "register" && step === 1) return goNext();
    const submittedData = new FormData(event.currentTarget);
    const submittedForm = {
      ...form,
      password: String(submittedData.get("password") || form.password),
      confirmPassword: String(
        submittedData.get("confirmPassword") || form.confirmPassword,
      ),
    };
    if (
      submittedForm.password !== form.password ||
      submittedForm.confirmPassword !== form.confirmPassword
    ) {
      setForm(submittedForm);
    }
    if (mode === "register" && (submittedForm.password.length < 12 || submittedForm.password.length > 128))
      return setLocalError("Choisis un mot de passe de 12 à 128 caractères.");
    if (
      mode === "register" &&
      submittedForm.password !== submittedForm.confirmPassword
    )
      return setLocalError("Les mots de passe ne correspondent pas.");
    if (mode === "register" && !canAcceptTerms)
      return setLocalError(
        "Lis les conditions d'utilisation et la politique de confidentialité.",
      );
    if (mode === "register" && !form.acceptTerms)
      return setLocalError(
        "Tu dois accepter les conditions pour créer ton compte.",
      );
    if (import.meta.env.PROD && !TURNSTILE_SITE_KEY)
      return setLocalError(TURNSTILE_CONFIGURATION_ERROR);
    if (TURNSTILE_SITE_KEY && !captchaToken)
      return setLocalError("Termine la vérification anti-robot.");
    setBusy(true);
    try {
      if (mode === "login")
        await login(normalizeEmail(form.email), submittedForm.password, form.remember, captchaToken);
      else {
        const result = await register({
          ...submittedForm,
          email: normalizeEmail(submittedForm.email),
          firstName: normalizeAuthName(submittedForm.firstName),
          lastName: normalizeAuthName(submittedForm.lastName),
          captchaToken,
          remember: form.remember,
        });
        if (result.confirmationRequired)
          setNotice(
            "Compte créé. Un e-mail de confirmation vient d'être envoyé.",
          );
      }
    } catch {
      return;
    } finally {
      setBusy(false);
      setCaptchaReset((value) => value + 1);
    }
  }
  async function forgotPassword() {
    clearError();
    setLocalError("");
    setNotice("");
    if (!/^\S+@\S+\.\S+$/.test(form.email))
      return setLocalError(
        "Indique ton adresse e-mail.",
      );
    if (import.meta.env.PROD && !TURNSTILE_SITE_KEY)
      return setLocalError(TURNSTILE_CONFIGURATION_ERROR);
    if (TURNSTILE_SITE_KEY && !captchaToken)
      return setLocalError("Termine la vérification anti-robot.");
    setBusy(true);
    try {
      await requestPasswordReset(normalizeEmail(form.email), captchaToken);
      setNotice(
        "Si cette adresse peut recevoir un lien, un e-mail vient d'être envoyé.",
      );
    } catch {
      return;
    } finally {
      setBusy(false);
      setCaptchaReset((value) => value + 1);
    }
  }
  async function continueWithGoogle() {
    clearError();
    setLocalError("");
    setNotice("");
    if (import.meta.env.PROD && !TURNSTILE_SITE_KEY)
      return setLocalError(TURNSTILE_CONFIGURATION_ERROR);
    setGoogleBusy(true);
    try {
      await loginWithGoogle(form.remember, captchaToken);
    } catch {
      setGoogleBusy(false);
      setCaptchaToken("");
      setCaptchaReset((value) => value + 1);
    }
  }
  function changeMode(next) {
    clearError();
    setLocalError("");
    setNotice("");
    setStep(1);
    setMode(next);
    setGoogleBusy(false);
  }

  if (pendingEmailAction) {
    return (
      <main className="auth-page">
        <AuthMessageToast message={error} onDismiss={clearError} />
        <section className="auth-reset-card">
          <AuthMobileBrand />
          <div className="auth-heading">
            <p className="auth-eyebrow">Lien personnel</p>
            <h2>{pendingEmailAction.type === "recovery" ? "Réinitialiser le mot de passe" : "Confirmer l'adresse e-mail"}</h2>
            <p>Le lien ne sera utilisé qu'après ta confirmation.</p>
          </div>
          <button className="auth-submit" type="button" disabled={busy || pendingEmailAction.invalid} onClick={async () => {
            setBusy(true);
            try { await confirmEmailAction(); } catch { return; }
            finally { setBusy(false); }
          }}>
            {busy ? "Vérification..." : pendingEmailAction.type === "recovery" ? "Continuer" : "Confirmer mon adresse"}
          </button>
          {pendingEmailAction.invalid && <p className="auth-switch">Ce lien est invalide ou incomplet.</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="auth-page">
      <AuthMessageToast
        message={localError || error}
        onDismiss={() => {
          setLocalError("");
          clearError();
        }}
      />
      <AuthMessageToast
        message={localError || error ? "" : notice}
        type="success"
        duration={5000}
        onDismiss={() => setNotice("")}
      />
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <section
        className="auth-shell"
        aria-label="Authentification Skyjo"
      >
        <AuthStoryPanel />
        <div className="auth-form-panel">
          <div className="auth-form-inner">
            <AuthMobileBrand heading />
            <div className="auth-heading">
              <p className="auth-eyebrow">
                {mode === "register"
                  ? "Bienvenue dans l'aventure"
                  : "Heureux de te revoir"}
              </p>
              <h2>
                {mode === "register"
                  ? "Crée ton compte"
                  : "Bon retour parmi nous"}
              </h2>
            </div>
            <form className="auth-form" onSubmit={submit}>
              <TurnstileWidget onToken={setCaptchaToken} resetSignal={captchaReset} />
              {(mode === "login" || step === 1) && (
                <div className="auth-oauth-block">
                  <button
                    className="auth-google-button"
                    type="button"
                    onClick={continueWithGoogle}
                    disabled={busy || googleBusy || !securityReady}
                  >
                    <GoogleIcon />
                    <span>
                      {googleBusy ? "Redirection..." : "Continuer avec Google"}
                    </span>
                  </button>
                  <div className="auth-divider" aria-hidden="true">
                    <span>ou avec e-mail</span>
                  </div>
                </div>
              )}
              <div className="auth-form-stage">
                {mode === "register" && step === 1 ? (
                  <div className="auth-step auth-step-identity auth-reveal">
                    <div className="auth-step-progress">
                      <span>Étape 1 sur 2</span>
                      <div>
                        <i />
                        <i />
                      </div>
                    </div>
                    <div className="auth-name-grid">
                      <AuthField
                        label="Prénom"
                        name="firstName"
                        value={form.firstName}
                        onChange={updateField}
                        autoComplete="given-name"
                        maxLength={50}
                        required
                      />
                      <AuthField
                        label="Nom"
                        name="lastName"
                        value={form.lastName}
                        onChange={updateField}
                        autoComplete="family-name"
                        maxLength={50}
                        required
                      />
                    </div>
                    <AuthField
                      icon={Mail}
                      label="Adresse e-mail"
                      name="email"
                      type="email"
                      value={form.email}
                      onChange={updateField}
                      placeholder="toi@exemple.fr"
                      autoComplete="email"
                      maxLength={254}
                      data-prefilled={emailPrefilled || undefined}
                      required
                    />
                    <button
                      className="auth-submit"
                      type="button"
                      onClick={goNext}
                      disabled={!canContinue}
                    >
                      <span>Continuer</span>
                      <ArrowRight size={17} />
                    </button>
                  </div>
                ) : (
                  <div
                    className={`auth-step auth-reveal ${mode === "register" ? "auth-step-security" : "auth-step-login"}`}
                  >
                    {mode === "register" && (
                      <div className="auth-step-progress">
                        <span>Étape 2 sur 2</span>
                        <div>
                          <i className="done" />
                          <i />
                        </div>
                      </div>
                    )}
                    {mode === "login" && (
                      <AuthField
                        icon={Mail}
                        label="Adresse e-mail"
                        name="email"
                        type="email"
                        value={form.email}
                        onChange={updateField}
                        placeholder="toi@exemple.fr"
                        autoComplete="username"
                        maxLength={254}
                        data-prefilled={emailPrefilled || undefined}
                        required
                      />
                    )}
                    {mode === "register" && (
                      <input
                        className="auth-username-field"
                        type="email"
                        name="username"
                        value={form.email}
                        autoComplete="username"
                        tabIndex={-1}
                        aria-hidden="true"
                        readOnly
                      />
                    )}
                    <AuthField
                      icon={LockKeyhole}
                      label="Mot de passe"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={updateField}
                      onInput={updateField}
                      placeholder="••••••••"
                      autoComplete={
                        mode === "register"
                          ? "new-password"
                          : "current-password"
                      }
                      minLength={mode === "register" ? 12 : undefined}
                      maxLength={128}
                      required
                      action={
                        <button
                          type="button"
                          tabIndex={-1}
                          onFocus={(event) => event.currentTarget.blur()}
                          onClick={() => setShowPassword((value) => !value)}
                          aria-label={
                            showPassword
                              ? "Masquer le mot de passe"
                              : "Afficher le mot de passe"
                          }
                        >
                          {showPassword ? (
                            <EyeOff size={16} />
                          ) : (
                            <Eye size={16} />
                          )}
                        </button>
                      }
                    />
                    {mode === "register" && (
                      <>
                        <div className="password-strength">
                          <div className="password-strength-label">
                            <span>Robustesse</span>
                            <strong className={`score-${score}`}>
                              {strength}
                            </strong>
                          </div>
                          <div
                            className="password-meter"
                            role="progressbar"
                            aria-label="Robustesse du mot de passe"
                            aria-valuenow={score}
                            aria-valuemin="0"
                            aria-valuemax="4"
                          >
                            {[1, 2, 3, 4].map((n) => (
                              <span
                                key={n}
                                className={
                                  score >= n ? `filled score-${score}` : ""
                                }
                              />
                            ))}
                          </div>
                        </div>
                        <AuthField
                          icon={LockKeyhole}
                          label="Confirmer le mot de passe"
                          name="confirmPassword"
                          type={showPassword ? "text" : "password"}
                          value={form.confirmPassword}
                          onChange={updateField}
                          onInput={updateField}
                          autoComplete="new-password"
                          minLength={12}
                          maxLength={128}
                          required
                        />
                      </>
                    )}
                    {mode === "login" ? (
                      <div className="auth-options">
                        <label>
                          <input
                            type="checkbox"
                            name="remember"
                            checked={form.remember}
                            onChange={updateField}
                          />
                          <span>Se souvenir de moi</span>
                        </label>
                        <button
                          type="button"
                          onClick={forgotPassword}
                          disabled={busy || googleBusy || !securityReady}
                        >
                          Mot de passe oublié ?
                        </button>
                      </div>
                    ) : (
                      <LegalConsent
                        accepted={form.acceptTerms}
                        canAccept={canAcceptTerms}
                        onChange={updateField}
                        onOpen={setLegalDocument}
                        readDocuments={readLegalDocuments}
                      />
                    )}
                    {mode === "register" ? (
                      <div className="auth-actions">
                        <button
                          className="auth-back"
                          type="button"
                          onClick={() => setStep(1)}
                        >
                          ← Retour
                        </button>
                        <button
                          className="auth-submit"
                          type="submit"
                          disabled={busy || googleBusy || !securityReady}
                        >
                          {busy ? "Un instant..." : "Créer mon compte"}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="auth-submit"
                        type="submit"
                        disabled={busy || googleBusy || !securityReady}
                      >
                        {busy ? "Un instant..." : "Se connecter"}
                        {!busy && <ArrowRight size={17} />}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <p className="auth-switch">
                {mode === "register"
                  ? "Tu as déjà un compte ?"
                  : "Nouveau sur Skyjo ?"}{" "}
                <button
                  type="button"
                  onClick={() =>
                    changeMode(mode === "register" ? "login" : "register")
                  }
                >
                  {mode === "register" ? "Se connecter" : "Créer un compte"}
                </button>
              </p>
            </form>
            <nav className="auth-public-links" aria-label="Informations légales">
              <a href="/privacy">Politique de confidentialité</a>
              <a href="/terms">Conditions d'utilisation</a>
            </nav>
          </div>
        </div>
      </section>
      <LegalModal
        documentId={legalDocument}
        onClose={() => setLegalDocument(null)}
        onAcknowledge={(documentId) => {
          setReadLegalDocuments((current) => ({
            ...current,
            [documentId]: true,
          }));
          setLegalDocument(null);
          setLocalError("");
        }}
      />
    </main>
  );
}

export function ResetPasswordView() {
  const { user, updatePassword, error, clearError } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    clearError();
    setLocalError("");
    if (password.length < 12 || password.length > 128)
      return setLocalError("Choisis un mot de passe de 12 à 128 caractères.");
    if (password !== confirmation)
      return setLocalError("Les mots de passe ne correspondent pas.");
    setBusy(true);
    try {
      await updatePassword(password);
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <AuthMessageToast
        message={localError || error}
        onDismiss={() => {
          setLocalError("");
          clearError();
        }}
      />
      <section className="auth-reset-card">
        <AuthMobileBrand />
        <div className="auth-heading">
          <p className="auth-eyebrow">Sécurise ton compte</p>
          <h2>Nouveau mot de passe</h2>
          <p>Choisis un nouveau mot de passe pour retrouver tes parties.</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <input
            className="auth-username-field"
            type="email"
            name="username"
            value={user?.email || ""}
            autoComplete="username"
            tabIndex={-1}
            aria-hidden="true"
            readOnly
          />
          <AuthField
            icon={LockKeyhole}
            label="Nouveau mot de passe"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <AuthField
            icon={LockKeyhole}
            label="Confirmer le mot de passe"
            name="confirmPassword"
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
          <button className="auth-submit" disabled={busy}>
            {busy ? "Mise à jour..." : "Enregistrer le mot de passe"}
          </button>
        </form>
      </section>
    </main>
  );
}
