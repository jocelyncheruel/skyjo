import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  PublicError, decodeVerifiedJwtClaims, isConfirmedUser, normalizeOrigin,
  objectPayload,
} from './security.js';

const SESSION_COOKIE_PROD = '__Host-skyjo_session';
const SESSION_COOKIE_DEV = 'skyjo_session';
const OAUTH_COOKIE_PROD = '__Host-skyjo_oauth';
const OAUTH_COOKIE_DEV = 'skyjo_oauth';
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_FLOW_MS = 10 * 60 * 1000;
const ACCESS_REFRESH_MARGIN_MS = 60_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookieHeader(header) {
  const result = Object.create(null);
  if (typeof header !== 'string' || header.length > 16_384) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) && value.length <= 8192) {
      result[name] = value;
    }
  }
  return result;
}

export function serializeAuthCookie(name, value, {
  production, maxAge = null, sameSite = 'Strict', clear = false,
} = {}) {
  const parts = [`${name}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (production) parts.push('Secure');
  if (clear) parts.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  else if (Number.isSafeInteger(maxAge) && maxAge > 0) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().normalize('NFKC').toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : '';
}

function normalizeName(value) {
  return [...String(value || '').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu, '')
    .replace(/\s+/gu, ' ').trim()].slice(0, 50).join('');
}

function normalizeLocale(value) {
  const locale = String(value || '').trim().replaceAll('_', '-');
  if (!locale || locale.length > 35) return '';
  try {
    return Intl.getCanonicalLocales(locale)[0] || '';
  } catch {
    return '';
  }
}

async function fetchGoogleUserInfo(providerToken) {
  if (typeof providerToken !== 'string' || providerToken.length < 20 || providerToken.length > 8192) {
    return null;
  }
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${providerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`google_userinfo_failed_${response.status}`);
  const profile = await response.json();
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('google_userinfo_invalid');
  }
  return profile;
}

export function googleProfileMetadata(user, providerProfile = null, browserLocale = '') {
  const metadata = user?.user_metadata && typeof user.user_metadata === 'object'
    ? user.user_metadata
    : {};
  const directProfile = providerProfile && typeof providerProfile === 'object'
    && !Array.isArray(providerProfile)
    ? providerProfile
    : {};
  const identity = Array.isArray(user?.identities)
    ? user.identities.find((candidate) => candidate?.provider === 'google')
    : null;
  const identityData = identity?.identity_data && typeof identity.identity_data === 'object'
    ? identity.identity_data
    : {};
  const providerFirstName = normalizeName(
    directProfile.given_name || identityData.given_name || metadata.given_name || '',
  );
  const providerLastName = normalizeName(
    directProfile.family_name || identityData.family_name || metadata.family_name || '',
  );
  const preferredLocale = normalizeLocale(
    browserLocale || directProfile.locale || identityData.locale
      || metadata.preferred_locale || metadata.locale || '',
  );
  if (!providerFirstName && !providerLastName && !preferredLocale) return null;

  const firstName = providerFirstName || normalizeName(metadata.first_name || '');
  const lastName = providerLastName || normalizeName(metadata.last_name || '');
  const displayName = normalizeName(`${firstName} ${lastName}`.trim()
    || directProfile.name || directProfile.full_name
    || identityData.name || identityData.full_name
    || metadata.name || metadata.full_name || '');
  const update = {};
  if (providerFirstName && normalizeName(metadata.first_name || '') !== providerFirstName) {
    update.first_name = providerFirstName;
  }
  if (providerLastName && normalizeName(metadata.last_name || '') !== providerLastName) {
    update.last_name = providerLastName;
  }
  if (displayName && normalizeName(metadata.display_name || '') !== displayName) {
    update.display_name = displayName;
  }
  if (preferredLocale && normalizeLocale(metadata.preferred_locale || '') !== preferredLocale) {
    update.preferred_locale = preferredLocale;
  }
  return Object.keys(update).length ? update : null;
}

function publicUser(user) {
  if (!user?.id) return null;
  const metadata = user.user_metadata || {};
  const firstName = normalizeName(metadata.first_name || metadata.given_name || '');
  const lastName = normalizeName(metadata.last_name || metadata.family_name || '');
  const fallback = String(user.email || '').split('@')[0];
  return {
    id: user.id,
    email: String(user.email || '').slice(0, 254),
    firstName,
    lastName,
    displayName: normalizeName(metadata.display_name || metadata.full_name || metadata.name
      || `${firstName} ${lastName}`.trim() || fallback || 'Joueur'),
    preferredLocale: normalizeLocale(metadata.preferred_locale || metadata.locale || ''),
  };
}

function authFailure() {
  return new PublicError(
    'authentication_failed',
    "Impossible de finaliser l'authentification avec ces informations.",
    401,
  );
}

function isTransientAuthError(error) {
  const status = Number(error?.status || 0);
  return !status || status >= 500;
}

export function publicSupabaseError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'email_not_confirmed' || message.includes('email not confirmed')) {
    return new PublicError(
      'email_not_confirmed',
      "Ton adresse e-mail n'est pas encore confirmée.",
      403,
    );
  }
  if (code === 'captcha_failed' || message.includes('captcha')) {
    return new PublicError('captcha_failed', 'La vérification anti-robot a échoué.', 400);
  }
  if (code === 'weak_password') {
    return new PublicError('weak_password', "Ce mot de passe n'est pas assez robuste.", 400);
  }
  if (code === 'same_password') {
    return new PublicError('same_password', "Choisis un mot de passe différent de l'ancien.", 400);
  }
  if (code === 'otp_expired') {
    return new PublicError('otp_expired', 'Ce lien a expiré ou a déjà été utilisé.', 400);
  }
  if (code === 'signup_disabled') {
    return new PublicError('signup_disabled', 'La création de compte est temporairement indisponible.', 503);
  }
  return null;
}

export function createAuthBff({
  supabaseUrl,
  publishableKey,
  serviceClient,
  encryptionKey,
  production,
  isAllowedOrigin,
  publicServerUrl,
  turnstileSecret = '',
  logInternal = () => {},
  rateLimit = () => (req, res, next) => next(),
}) {
  const key = Buffer.from(String(encryptionKey || ''), 'base64');
  if (key.length !== 32) throw new Error('AUTH_SESSION_ENCRYPTION_KEY doit contenir 32 octets encodés en base64.');
  if (!publishableKey || publishableKey.length < 20) throw new Error('SUPABASE_PUBLISHABLE_KEY est obligatoire.');
  const normalizedServerUrl = normalizeOrigin(publicServerUrl, { production });
  if (!normalizedServerUrl) throw new Error('PUBLIC_SERVER_URL invalide.');

  const sessionCookieName = production ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
  const oauthCookieName = production ? OAUTH_COOKIE_PROD : OAUTH_COOKIE_DEV;
  const sessionQueues = new Map();

  function encrypt(value, purpose) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`skyjo:${purpose}:v1`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  function decrypt(value, purpose) {
    try {
      const [iv, tag, encrypted] = String(value || '').split('.').map((part) => Buffer.from(part, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`skyjo:${purpose}:v1`));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }

  function buildAuthClient(storage = undefined) {
    return createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: Boolean(storage),
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storage,
      },
    });
  }

  function setSessionCookie(res, rawToken, remember) {
    res.append('Set-Cookie', serializeAuthCookie(sessionCookieName, rawToken, {
      production,
      maxAge: remember ? Math.floor(SESSION_ABSOLUTE_MS / 1000) : null,
    }));
  }

  function clearSessionCookie(res) {
    res.append('Set-Cookie', serializeAuthCookie(sessionCookieName, '', { production, clear: true }));
  }

  function clearOAuthCookie(res) {
    res.append('Set-Cookie', serializeAuthCookie(oauthCookieName, '', {
      production, clear: true, sameSite: 'Lax',
    }));
  }

  async function createBrowserSession(res, supabaseSession, remember = false, authContext = 'standard') {
    if (!supabaseSession?.access_token || !supabaseSession?.refresh_token || !isConfirmedUser(supabaseSession.user)) {
      throw authFailure();
    }
    const claims = decodeVerifiedJwtClaims(supabaseSession.access_token);
    if (!claims || claims.sub !== supabaseSession.user.id) throw authFailure();
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MS).toISOString();
    const { error } = await serviceClient.from('app_sessions').insert({
      token_hash: sha256(rawToken),
      user_id: supabaseSession.user.id,
      encrypted_session: encrypt({
        accessToken: supabaseSession.access_token,
        refreshToken: supabaseSession.refresh_token,
        csrfToken,
        authContext: authContext === 'recovery' ? 'recovery' : 'standard',
      }, 'session'),
      access_expires_at: new Date(claims.exp * 1000).toISOString(),
      idle_expires_at: new Date(now + SESSION_IDLE_MS).toISOString(),
      absolute_expires_at: absoluteExpiresAt,
      remember: Boolean(remember),
      last_seen_at: new Date(now).toISOString(),
    });
    if (error) throw error;
    const { data: excess, error: excessError } = await serviceClient.from('app_sessions')
      .select('id').eq('user_id', supabaseSession.user.id)
      .order('created_at', { ascending: false }).range(10, 99);
    if (excessError) throw excessError;
    if (excess?.length) {
      const { error: pruneError } = await serviceClient.from('app_sessions')
        .delete().in('id', excess.map((item) => item.id));
      if (pruneError) throw pruneError;
    }
    setSessionCookie(res, rawToken, Boolean(remember));
    return { user: publicUser(supabaseSession.user), csrfToken, remember: Boolean(remember) };
  }

  async function deleteSessionByToken(rawToken) {
    if (!rawToken) return;
    await serviceClient.from('app_sessions').delete().eq('token_hash', sha256(rawToken));
  }

  async function resolveSessionUnqueued(rawToken) {
    if (!rawToken || rawToken.length !== 43) return null;
    const tokenHash = sha256(rawToken);
    const { data: row, error } = await serviceClient.from('app_sessions')
      .select('id, user_id, encrypted_session, access_expires_at, idle_expires_at, absolute_expires_at, remember, created_at, last_seen_at')
      .eq('token_hash', tokenHash).maybeSingle();
    if (error) throw error;
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.idle_expires_at) <= now || Date.parse(row.absolute_expires_at) <= now) {
      await serviceClient.from('app_sessions').delete().eq('id', row.id);
      return null;
    }
    if (Date.parse(row.absolute_expires_at) <= now + ACCESS_REFRESH_MARGIN_MS) {
      await serviceClient.from('app_sessions').delete().eq('id', row.id);
      return null;
    }
    let secrets = decrypt(row.encrypted_session, 'session');
    if (!secrets?.accessToken || !secrets?.refreshToken || !secrets?.csrfToken) {
      await serviceClient.from('app_sessions').delete().eq('id', row.id);
      return null;
    }
    let client = buildAuthClient();
    let session;
    if (Date.parse(row.access_expires_at) <= now + ACCESS_REFRESH_MARGIN_MS) {
      const result = await client.auth.setSession({
        access_token: secrets.accessToken,
        refresh_token: secrets.refreshToken,
      });
      if (result.error || !result.data?.session) {
        if (result.error && isTransientAuthError(result.error)) throw result.error;
        await serviceClient.from('app_sessions').delete().eq('id', row.id);
        return null;
      }
      session = result.data.session;
      const claims = decodeVerifiedJwtClaims(session.access_token);
      if (!claims || claims.sub !== row.user_id) return null;
      secrets = {
        ...secrets,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      };
      const { error: updateError } = await serviceClient.from('app_sessions').update({
        encrypted_session: encrypt(secrets, 'session'),
        access_expires_at: new Date(claims.exp * 1000).toISOString(),
      }).eq('id', row.id);
      if (updateError) throw updateError;
    } else {
      const result = await client.auth.getUser(secrets.accessToken);
      if (result.error || !result.data?.user) {
        if (result.error && isTransientAuthError(result.error)) throw result.error;
        return null;
      }
      session = { access_token: secrets.accessToken, refresh_token: secrets.refreshToken, user: result.data.user };
    }
    if (!isConfirmedUser(session.user) || session.user.id !== row.user_id) return null;
    const claims = decodeVerifiedJwtClaims(session.access_token);
    if (!claims || claims.sub !== row.user_id || claims.role !== 'authenticated') return null;
    const { data: active, error: activeError } = await serviceClient.rpc('is_skyjo_session_active', {
      p_session_id: claims.sessionId,
      p_user_id: row.user_id,
    });
    if (activeError) throw activeError;
    if (active !== true) {
      await serviceClient.from('app_sessions').delete().eq('id', row.id);
      return null;
    }
    const nextIdle = new Date(Math.min(now + SESSION_IDLE_MS, Date.parse(row.absolute_expires_at))).toISOString();
    if (Date.parse(row.last_seen_at) < now - 60_000) {
      const { error: touchError } = await serviceClient.from('app_sessions').update({
        last_seen_at: new Date(now).toISOString(), idle_expires_at: nextIdle,
      }).eq('id', row.id);
      if (touchError) throw touchError;
    }
    return {
      appSessionId: row.id,
      user: session.user,
      claims,
      accessToken: session.access_token,
      refreshToken: secrets.refreshToken,
      csrfToken: secrets.csrfToken,
      authContext: secrets.authContext === 'recovery' ? 'recovery' : 'standard',
      createdAt: Date.parse(row.created_at),
      remember: row.remember === true,
      rawToken,
    };
  }

  async function resolveSession(rawToken) {
    const queueKey = sha256(rawToken || 'missing');
    const previous = sessionQueues.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => resolveSessionUnqueued(rawToken));
    sessionQueues.set(queueKey, current);
    try { return await current; }
    finally { if (sessionQueues.get(queueKey) === current) sessionQueues.delete(queueKey); }
  }

  async function sessionFromCookieHeader(header) {
    const rawToken = parseCookieHeader(header)[sessionCookieName] || '';
    return resolveSession(rawToken);
  }

  function trustedOrigin(req) {
    const origin = normalizeOrigin(req.headers.origin, { production });
    return Boolean(origin && isAllowedOrigin(origin));
  }

  function requireOrigin(req, res, next) {
    if (!trustedOrigin(req)) {
      next(new PublicError('origin_denied', 'Origine non autorisée.', 403));
      return;
    }
    next();
  }

  async function optionalAuth(req, res, next) {
    try {
      req.auth = await sessionFromCookieHeader(req.headers.cookie);
      next();
    } catch (error) { next(error); }
  }

  async function bestEffortAuth(req, res, next) {
    void res;
    try { req.auth = await sessionFromCookieHeader(req.headers.cookie); }
    catch (error) {
      req.auth = null;
      logInternal('auth_logout_session', error);
    }
    next();
  }

  async function requireAuth(req, res, next) {
    try {
      req.auth = await sessionFromCookieHeader(req.headers.cookie);
      if (!req.auth) {
        clearSessionCookie(res);
        throw new PublicError('invalid_session', 'Session invalide ou expirée.', 401);
      }
      next();
    } catch (error) { next(error); }
  }

  function assertCsrf(req) {
    if (!trustedOrigin(req) || !req.auth || !safeEqual(req.headers['x-csrf-token'], req.auth.csrfToken)) {
      throw new PublicError('csrf_failed', 'Requête de sécurité invalide.', 403);
    }
  }

  function requireCsrf(req, res, next) {
    void res;
    try { assertCsrf(req); next(); }
    catch (error) { next(error); }
  }

  function requireStandardSession(req, res, next) {
    void res;
    if (req.auth?.authContext !== 'recovery') {
      next();
      return;
    }
    next(new PublicError('password_update_required', 'Choisis un nouveau mot de passe avant de continuer.', 403));
  }

  async function verifyTurnstile(token, remoteIp) {
    if (!production && !turnstileSecret) return true;
    if (!turnstileSecret || typeof token !== 'string' || token.length < 20 || token.length > 2048) return false;
    const body = new URLSearchParams({ secret: turnstileSecret, response: token });
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const hostname = String(result.hostname || '').toLowerCase();
    return result.success === true
      && hostname.length <= 253
      && (isAllowedOrigin(`https://${hostname}`) || (!production && isAllowedOrigin(`http://${hostname}`)));
  }

  function clientOrigin(req) {
    const origin = normalizeOrigin(req.headers.origin, { production });
    if (!origin || !isAllowedOrigin(origin)) throw new PublicError('origin_denied', 'Origine non autorisée.', 403);
    return origin;
  }

  function oauthCallbackUrl(req) {
    if (production) return `${normalizedServerUrl}/api/auth/google/callback`;
    const client = new URL(clientOrigin(req));
    const server = new URL(normalizedServerUrl);
    const port = server.port ? `:${server.port}` : '';
    return `${client.protocol}//${client.hostname}${port}/api/auth/google/callback`;
  }

  const router = express.Router();

  router.get('/session', rateLimit('auth-session', 60, 60_000), optionalAuth, (req, res) => {
    if (!req.auth) {
      clearSessionCookie(res);
      res.json({ user: null, csrfToken: null, remember: false, recovery: false });
      return;
    }
    res.json({
      user: publicUser(req.auth.user),
      csrfToken: req.auth.csrfToken,
      remember: req.auth.remember,
      recovery: req.auth.authContext === 'recovery',
    });
  });

  router.post('/login', rateLimit('auth-login', 8, 10 * 60_000), requireOrigin, async (req, res, next) => {
    try {
      const body = objectPayload(req.body, ['email', 'password', 'remember', 'captchaToken']);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      if (!email || password.length < 1 || password.length > 128) throw authFailure();
      const client = buildAuthClient();
      const { data, error } = await client.auth.signInWithPassword({
        email, password,
        options: body.captchaToken ? { captchaToken: String(body.captchaToken).slice(0, 2048) } : undefined,
      });
      if (error || !data?.session) throw publicSupabaseError(error) || authFailure();
      res.json(await createBrowserSession(res, data.session, body.remember === true));
    } catch (error) {
      next(error instanceof PublicError || isTransientAuthError(error) ? error : authFailure());
    }
  });

  router.post('/register', rateLimit('auth-register', 5, 10 * 60_000), requireOrigin, async (req, res, next) => {
    try {
      const body = objectPayload(req.body, ['email', 'password', 'firstName', 'lastName', 'remember', 'captchaToken']);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const firstName = normalizeName(body.firstName);
      const lastName = normalizeName(body.lastName);
      if (!email || password.length < 12 || password.length > 128 || !firstName || !lastName) {
        throw new PublicError('invalid_registration', "Impossible de finaliser l'inscription.", 400);
      }
      const origin = clientOrigin(req);
      const client = buildAuthClient();
      const { data, error } = await client.auth.signUp({
        email, password,
        options: {
          emailRedirectTo: `${origin}/auth/confirm`,
          captchaToken: body.captchaToken ? String(body.captchaToken).slice(0, 2048) : undefined,
          data: {
            first_name: firstName,
            last_name: lastName,
            display_name: `${firstName} ${lastName}`.trim(),
            source: 'skyjo',
          },
        },
      });
      if (error) {
        if (isTransientAuthError(error)) throw error;
        const safeError = publicSupabaseError(error);
        if (safeError) throw safeError;
        res.status(202).json({ confirmationRequired: true });
        return;
      }
      if (data?.session) {
        const session = await createBrowserSession(res, data.session, body.remember === true);
        res.status(201).json({ ...session, confirmationRequired: false });
        return;
      }
      res.status(202).json({ confirmationRequired: true });
    } catch (error) { next(error); }
  });

  router.post('/password/reset', rateLimit('auth-reset', 5, 10 * 60_000), requireOrigin, async (req, res) => {
    const generic = { accepted: true };
    try {
      const body = objectPayload(req.body, ['email', 'captchaToken']);
      const email = normalizeEmail(body.email);
      if (email) {
        const origin = clientOrigin(req);
        const client = buildAuthClient();
        await client.auth.resetPasswordForEmail(email, {
          redirectTo: `${origin}/auth/confirm`,
          captchaToken: body.captchaToken ? String(body.captchaToken).slice(0, 2048) : undefined,
        });
      }
    } catch (error) { logInternal('auth_password_reset', error); }
    res.status(202).json(generic);
  });

  router.post('/email/confirm', rateLimit('auth-confirm', 10, 10 * 60_000), requireOrigin, async (req, res, next) => {
    try {
      const body = objectPayload(req.body, ['tokenHash', 'type', 'remember']);
      const tokenHash = String(body.tokenHash || '');
      const type = String(body.type || '');
      if (!tokenHash || tokenHash.length > 2048 || !['email', 'recovery'].includes(type)) throw authFailure();
      const client = buildAuthClient();
      const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error || !data?.session) throw publicSupabaseError(error) || authFailure();
      res.json({
        ...await createBrowserSession(
          res,
          data.session,
          body.remember === true,
          type === 'recovery' ? 'recovery' : 'standard',
        ),
        recovery: type === 'recovery',
      });
    } catch (error) {
      next(error instanceof PublicError || isTransientAuthError(error) ? error : authFailure());
    }
  });

  router.post('/google/start', rateLimit('auth-google', 10, 10 * 60_000), requireOrigin, async (req, res, next) => {
    try {
      const body = objectPayload(req.body, ['remember', 'captchaToken', 'preferredLocale']);
      if (!await verifyTurnstile(body.captchaToken, req.ip)) {
        throw new PublicError('captcha_failed', 'La vérification anti-robot a échoué.', 400);
      }
      const values = Object.create(null);
      const storage = {
        getItem: (name) => values[name] || null,
        setItem: (name, value) => { values[name] = value; },
        removeItem: (name) => { delete values[name]; },
      };
      const client = buildAuthClient(storage);
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: oauthCallbackUrl(req),
          scopes: 'openid email profile',
          skipBrowserRedirect: true,
        },
      });
      if (error || !data?.url) throw authFailure();
      const providerUrl = new URL(data.url);
      if (providerUrl.protocol !== 'https:' || providerUrl.origin !== new URL(supabaseUrl).origin) {
        throw new Error('invalid_oauth_authorization_url');
      }
      const flow = encrypt({
        values,
        remember: body.remember === true,
        preferredLocale: normalizeLocale(body.preferredLocale),
        clientOrigin: clientOrigin(req),
        expiresAt: Date.now() + OAUTH_FLOW_MS,
      }, 'oauth');
      if (Buffer.byteLength(flow, 'utf8') > 3000) throw new Error('oauth_flow_too_large');
      res.append('Set-Cookie', serializeAuthCookie(oauthCookieName, flow, {
        production, maxAge: Math.floor(OAUTH_FLOW_MS / 1000), sameSite: 'Lax',
      }));
      res.json({ url: providerUrl.toString() });
    } catch (error) { next(error); }
  });

  router.get('/google/callback', rateLimit('auth-google-callback', 20, 10 * 60_000), async (req, res) => {
    const flow = decrypt(parseCookieHeader(req.headers.cookie)[oauthCookieName], 'oauth');
    const fallbackOrigin = normalizeOrigin(flow?.clientOrigin, { production });
    const destination = fallbackOrigin && isAllowedOrigin(fallbackOrigin) ? fallbackOrigin : '';
    clearOAuthCookie(res);
    if (!flow || flow.expiresAt <= Date.now() || !destination || typeof req.query.code !== 'string' || req.query.code.length > 2048) {
      res.redirect(303, destination ? `${destination}/auth/callback?status=failed` : '/');
      return;
    }
    try {
      const values = flow.values && typeof flow.values === 'object' ? flow.values : Object.create(null);
      const storage = {
        getItem: (name) => values[name] || null,
        setItem: (name, value) => { values[name] = value; },
        removeItem: (name) => { delete values[name]; },
      };
      const client = buildAuthClient(storage);
      const { data, error } = await client.auth.exchangeCodeForSession(req.query.code);
      if (error || !data?.session) {
        logInternal('auth_google_exchange', error || new Error('oauth_session_missing'));
        throw authFailure();
      }
      let session = data.session;
      let providerProfile = null;
      try {
        providerProfile = await fetchGoogleUserInfo(session.provider_token);
      } catch (profileError) {
        logInternal('auth_google_profile_fetch', profileError);
      }
      const profileMetadata = googleProfileMetadata(
        session.user,
        providerProfile,
        flow.preferredLocale,
      );
      if (profileMetadata) {
        try {
          const { data: updated, error: updateError } = await client.auth.updateUser({ data: profileMetadata });
          if (updateError) logInternal('auth_google_profile_update', updateError);
          else if (updated?.user) session = { ...session, user: updated.user };
        } catch (updateError) {
          logInternal('auth_google_profile_update', updateError);
        }
      }
      await createBrowserSession(res, session, flow.remember === true);
      res.redirect(303, `${destination}/auth/callback?status=success`);
    } catch (error) {
      logInternal('auth_google_callback', error);
      res.redirect(303, `${destination}/auth/callback?status=failed`);
    }
  });

  router.post('/password/update', rateLimit('auth-password-update', 5, 10 * 60_000), requireAuth, requireCsrf, async (req, res, next) => {
    try {
      if (req.auth.authContext !== 'recovery' || req.auth.createdAt < Date.now() - 15 * 60_000) {
        throw new PublicError('recent_recovery_required', 'Demande un nouveau lien de réinitialisation.', 403);
      }
      const body = objectPayload(req.body, ['password']);
      const password = String(body.password || '');
      if (password.length < 12 || password.length > 128) {
        throw new PublicError('invalid_password', 'Choisis un mot de passe de 12 à 128 caractères.', 400);
      }
      const client = buildAuthClient();
      const current = await client.auth.setSession({
        access_token: req.auth.accessToken,
        refresh_token: req.auth.refreshToken,
      });
      if (current.error) throw isTransientAuthError(current.error) ? current.error : authFailure();
      const update = await client.auth.updateUser({ password });
      if (update.error) throw publicSupabaseError(update.error) || update.error;
      await client.auth.signOut({ scope: 'global' });
      await serviceClient.from('app_sessions').delete().eq('user_id', req.auth.user.id);
      clearSessionCookie(res);
      res.json({ updated: true });
    } catch (error) { next(error); }
  });

  router.post('/logout', rateLimit('auth-logout', 20, 60_000), requireOrigin, bestEffortAuth, async (req, res, next) => {
    try {
      clearSessionCookie(res);
      if (req.auth) {
        assertCsrf(req);
        try {
          const client = buildAuthClient();
          await client.auth.setSession({ access_token: req.auth.accessToken, refresh_token: req.auth.refreshToken });
          await client.auth.signOut({ scope: 'global' });
        } catch (error) { logInternal('auth_logout_supabase', error); }
        await serviceClient.from('app_sessions').delete().eq('user_id', req.auth.user.id);
        res.status(204).end();
        return;
      }
      const rawToken = parseCookieHeader(req.headers.cookie)[sessionCookieName] || '';
      await deleteSessionByToken(rawToken);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  return {
    router,
    requireAuth,
    requireCsrf,
    requireStandardSession,
    requireOrigin,
    sessionFromCookieHeader,
    clearSessionCookie,
    publicUser,
  };
}
