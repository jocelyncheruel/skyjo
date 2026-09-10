import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Bell, Check, Ellipsis, Eye, Gamepad2, Handshake, LogIn, Settings, Trash2, UserMinus, UserPlus, UsersRound, X } from 'lucide-react';
import { apiFetch } from '../apiClient.js';
import ProfileModal from '../ProfileModal.jsx';
import { enablePushNotifications } from '../pushNotifications.js';

let friendsCache = null;
let friendsRequest = null;
const emptyFriendsData = {
  friendCode: '',
  preferences: {
    status: 'available',
    showPresence: true,
    showGame: true,
    allowGameAccess: true,
    showQuickProfile: true,
    notifyGameInvites: false,
  },
  friends: [],
  requests: [],
  invitations: [],
  sentInvitations: [],
  notifications: [],
  unreadCount: 0,
};
export async function friendsApi(options) {
  const request = async () => {
    const response = await apiFetch('/api/friends', options);
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || 'Impossible de charger vos amis.');
    if (Array.isArray(data?.friends)) friendsCache = data;
    return data;
  };
  if (options) return request();
  if (!friendsRequest) {
    friendsRequest = request().finally(() => { friendsRequest = null; });
  }
  return friendsRequest;
}

export function FriendsButton({ onClick, refreshToken = 0 }) {
  const [unread, setUnread] = useState(() => friendsCache?.unreadCount || 0);
  useEffect(() => {
    let active = true;
    friendsApi().then((data) => active && setUnread(data.unreadCount || 0)).catch(() => {});
    return () => { active = false; };
  }, [refreshToken]);
  return <button type="button" className="sj-account-profile-trigger sj-account-friends-trigger" onClick={onClick} aria-label="Ouvrir vos amis" aria-haspopup="dialog" title="Amis"><Handshake aria-hidden="true" size={18} />{unread > 0 && <span className="sj-friends-unread" aria-label={`${unread} nouveauté${unread > 1 ? 's' : ''}`}>{Math.min(unread, 9)}{unread > 9 ? '+' : ''}</span>}</button>;
}

export function FriendInvitationPrompt({ invitation, busy = false, inRoom = false, onAccept, onDecline }) {
  if (!invitation) return null;
  return (
    <div className="sj-modal-overlay sj-friend-invitation-overlay sj-fade-in">
      <section className="sj-friend-invitation-prompt sj-pop-in" role="dialog" aria-modal="true" aria-labelledby="friend-invitation-title">
        <span className="sj-friend-invitation-icon" aria-hidden="true"><Gamepad2 size={22} /></span>
        <div>
          <small>Invitation à jouer</small>
          <h2 id="friend-invitation-title">{invitation.name} vous invite</h2>
          <p>{inRoom ? 'Accepter quittera votre partie actuelle pour rejoindre cette salle.' : 'Rejoignez directement la salle de votre ami.'}</p>
        </div>
        <div className="sj-modal-actions sj-friend-invitation-actions">
          <button type="button" className="sj-btn" disabled={busy} onClick={onDecline}>Refuser</button>
          <button type="button" className="sj-btn sj-btn-primary" disabled={busy} onClick={onAccept}>Accepter</button>
        </div>
      </section>
    </div>
  );
}

const preferenceLabels = [
  ['showPresence', 'Afficher ma présence'],
  ['showGame', 'Afficher ma présence en lobby ou en partie'],
  ['allowGameAccess', 'Autoriser mes amis à rejoindre ou regarder'],
  ['showQuickProfile', 'Partager mes statistiques et ma progression'],
];
const preferenceKeys = ['status', 'showPresence', 'showGame', 'allowGameAccess', 'showQuickProfile', 'notifyGameInvites'];
const samePreferences = (left, right) => Boolean(left && right)
  && preferenceKeys.every((key) => left[key] === right[key]);

export default function FriendsModal({ open, onClose, onWatch, onJoin, onError, roomId = '', inRoom = false, refreshToken = 0 }) {
  const modalRef = useRef(null);
  const removeModalRef = useRef(null);
  const copyTimerRef = useRef(null);
  const settingsRef = useRef(null);
  const markedOpenRef = useRef(false);
  const onlineNotificationDesiredRef = useRef(new Map());
  const onlineNotificationOverrideRef = useRef(new Map());
  const onlineNotificationSyncingRef = useRef(new Set());
  const preferenceDesiredRef = useRef(null);
  const preferenceConfirmedRef = useRef((friendsCache || emptyFriendsData).preferences);
  const preferenceOverrideRef = useRef(null);
  const preferenceSyncingRef = useRef(false);
  const [data, setData] = useState(() => friendsCache || emptyFriendsData);
  const [loaded, setLoaded] = useState(() => Boolean(friendsCache));
  const [code, setCode] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [copied, setCopied] = useState(false);
  const [friendToRemove, setFriendToRemove] = useState(null);
  const [profileFriend, setProfileFriend] = useState(null);
  const [friendMenu, setFriendMenu] = useState(null);
  const applyOnlineNotificationOverrides = useCallback((nextData) => {
    const desiredByRelation = onlineNotificationDesiredRef.current;
    const overridesByRelation = onlineNotificationOverrideRef.current;
    const localPreferences = preferenceDesiredRef.current || preferenceOverrideRef.current;
    if (!desiredByRelation.size && !overridesByRelation.size && !localPreferences) return nextData;
    return {
      ...nextData,
      preferences: localPreferences || nextData.preferences,
      friends: (nextData.friends || []).map((friend) => {
        const relationId = friend.relationId;
        if (desiredByRelation.has(relationId)) {
          return { ...friend, notifyOnline: desiredByRelation.get(relationId) };
        }
        return overridesByRelation.has(relationId)
          ? { ...friend, notifyOnline: overridesByRelation.get(relationId) }
          : friend;
      }),
    };
  }, []);
  const load = useCallback(async (report = false) => {
    try {
      const nextData = await friendsApi();
      if (samePreferences(nextData.preferences, preferenceOverrideRef.current)) {
        preferenceOverrideRef.current = null;
      }
      if (!preferenceSyncingRef.current && !preferenceDesiredRef.current && !preferenceOverrideRef.current) {
        preferenceConfirmedRef.current = nextData.preferences;
      }
      setData(applyOnlineNotificationOverrides(nextData));
      setLoaded(true);
    } catch (error) { if (report) onError(error.message); }
  }, [applyOnlineNotificationOverrides, onError]);

  useLayoutEffect(() => {
    if (!open || !friendsCache) return;
    if (samePreferences(friendsCache.preferences, preferenceOverrideRef.current)) {
      preferenceOverrideRef.current = null;
    }
    if (!preferenceSyncingRef.current && !preferenceDesiredRef.current && !preferenceOverrideRef.current) {
      preferenceConfirmedRef.current = friendsCache.preferences;
    }
    setData(applyOnlineNotificationOverrides(friendsCache));
    setLoaded(true);
  }, [applyOnlineNotificationOverrides, open]);

  useEffect(() => {
    if (!open) { markedOpenRef.current = false; setFriendMenu(null); return undefined; }
    load(true);
    const timer = window.setInterval(load, 15_000);
    if (!markedOpenRef.current) {
      markedOpenRef.current = true;
      friendsApi({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_read' }) }).then(() => {
        setData((current) => current ? {
          ...current,
          notifications: (current.notifications || []).map((notification) => ({
            ...notification,
            read_at: notification.read_at || new Date().toISOString(),
          })),
          unreadCount: 0,
        } : current);
      }).catch(() => {});
    }
    return () => window.clearInterval(timer);
  }, [load, open, refreshToken]);
  useEffect(() => { if (open && data) modalRef.current?.focus({ preventScroll: true }); }, [data, open]);
  useEffect(() => {
    if (!open) return undefined;
    const escape = (event) => { if (event.key !== 'Escape') return; if (friendToRemove) setFriendToRemove(null); else if (profileFriend) setProfileFriend(null); else if (friendMenu) setFriendMenu(null); else onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [friendMenu, friendToRemove, onClose, open, profileFriend]);
  useEffect(() => { if (friendToRemove) removeModalRef.current?.focus({ preventScroll: true }); }, [friendToRemove]);
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const closeFloatingMenus = (event) => {
      const settings = settingsRef.current;
      if (settings?.open && !settings.contains(event.target)) settings.open = false;
      if (friendMenu && !event.target.closest?.('.sj-friends-more, .sj-friends-more-menu')) setFriendMenu(null);
    };
    document.addEventListener('pointerdown', closeFloatingMenus);
    return () => document.removeEventListener('pointerdown', closeFloatingMenus);
  }, [friendMenu, open]);
  useEffect(() => {
    if (!friendMenu) return undefined;
    const closeMenu = () => setFriendMenu(null);
    window.addEventListener('resize', closeMenu);
    return () => window.removeEventListener('resize', closeMenu);
  }, [friendMenu]);

  function toggleFriendMenu(event, relationId, hasProfile) {
    if (friendMenu?.relationId === relationId) {
      setFriendMenu(null);
      return;
    }
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const compactViewport = window.matchMedia('(hover: none), (pointer: coarse)').matches
      || window.innerWidth <= 680;
    const estimatedMenuHeight = hasProfile
      ? (compactViewport ? 132 : 126)
      : (compactViewport ? 90 : 86);
    const roomAbove = buttonRect.top - 12;
    const roomBelow = window.innerHeight - buttonRect.bottom - 12;
    const opensDown = roomBelow >= estimatedMenuHeight || roomBelow > roomAbove;
    setFriendMenu({
      relationId,
      opensUp: !opensDown,
      right: Math.max(12, window.innerWidth - buttonRect.right),
      top: opensDown
        ? Math.min(buttonRect.bottom + 4, window.innerHeight - estimatedMenuHeight - 12)
        : buttonRect.top - 4,
    });
  }

  async function mutate(action, values = {}) {
    setBusyAction(`${action}:${values.relationId || values.invitationId || ''}`);
    try {
      const next = await friendsApi({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values }) });
      setData((current) => {
        if (!current) return current;
        if (['accept', 'decline', 'cancel'].includes(action)) {
          return {
            ...current,
            requests: (current.requests || []).filter(({ relationId }) => relationId !== values.relationId),
          };
        }
        if (action === 'remove') {
          return {
            ...current,
            friends: (current.friends || []).filter(({ relationId }) => relationId !== values.relationId),
            sentInvitations: (current.sentInvitations || []).filter(({ relationId }) => relationId !== values.relationId),
          };
        }
        if (action === 'invite') {
          return {
            ...current,
            sentInvitations: [
              ...(current.sentInvitations || []),
              { relationId: values.relationId, roomId: values.roomId },
            ],
          };
        }
        if (action === 'online_notification') {
          return {
            ...current,
            friends: (current.friends || []).map((friend) => friend.relationId === values.relationId
              ? { ...friend, notifyOnline: values.enabled } : friend),
          };
        }
        if (action === 'accept_invite' || action === 'decline_invite') {
          return {
            ...current,
            invitations: (current.invitations || []).filter(({ invitationId }) => invitationId !== values.invitationId),
          };
        }
        return current;
      });
      setCode('');
      if (action === 'remove') setFriendToRemove(null);
      if (next.joinRoomId) { onClose(); onJoin(next.joinRoomId); }
      else load(false);
      return true;
    } catch (error) {
      onError(error.message);
      return false;
    } finally { setBusyAction(''); }
  }

  async function copyFriendCode() {
    const value = data?.friendCode || '';
    if (!value) return;
    let success = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) try { await navigator.clipboard.writeText(value); success = true; } catch { success = false; }
    if (!success) {
      const textarea = document.createElement('textarea'); textarea.value = value; textarea.setAttribute('readonly', ''); textarea.className = 'sj-clipboard-fallback'; document.body.appendChild(textarea); textarea.select();
      try { success = document.execCommand('copy'); } catch { success = false; } textarea.remove();
    }
    if (success) { window.clearTimeout(copyTimerRef.current); setCopied(true); copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400); }
  }

  async function updatePreferences(patch) {
    const desiredPreferences = {
      ...(preferenceDesiredRef.current || data.preferences),
      ...patch,
    };
    preferenceDesiredRef.current = desiredPreferences;
    setData((current) => current ? { ...current, preferences: desiredPreferences } : current);
    if (preferenceSyncingRef.current) return;

    preferenceSyncingRef.current = true;
    let confirmedPreferences = preferenceConfirmedRef.current || data.preferences;
    try {
      while (preferenceDesiredRef.current) {
        const targetPreferences = preferenceDesiredRef.current;
        if (targetPreferences.notifyGameInvites && !confirmedPreferences.notifyGameInvites) {
          await enablePushNotifications();
          if (preferenceDesiredRef.current !== targetPreferences) continue;
        }
        await friendsApi({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'preferences', ...targetPreferences }),
        });
        confirmedPreferences = targetPreferences;
        preferenceConfirmedRef.current = targetPreferences;
        preferenceOverrideRef.current = targetPreferences;
        if (preferenceDesiredRef.current === targetPreferences) {
          preferenceDesiredRef.current = null;
        }
      }
      setData((current) => current ? { ...current, preferences: confirmedPreferences } : current);
      load(false);
    } catch (error) {
      preferenceDesiredRef.current = null;
      preferenceOverrideRef.current = null;
      setData((current) => current ? { ...current, preferences: confirmedPreferences } : current);
      onError(error.message);
    } finally {
      preferenceSyncingRef.current = false;
    }
  }

  async function toggleOnlineNotification(relationId, renderedValue) {
    const desiredByRelation = onlineNotificationDesiredRef.current;
    const overridesByRelation = onlineNotificationOverrideRef.current;
    const syncingRelations = onlineNotificationSyncingRef.current;
    const currentDesired = desiredByRelation.has(relationId)
      ? desiredByRelation.get(relationId)
      : overridesByRelation.has(relationId)
        ? overridesByRelation.get(relationId)
        : Boolean(renderedValue);
    const nextDesired = !currentDesired;
    desiredByRelation.set(relationId, nextDesired);
    overridesByRelation.set(relationId, nextDesired);
    const updateOnlineState = (enabled) => setData((current) => current ? {
      ...current,
      friends: (current.friends || []).map((friend) => friend.relationId === relationId
        ? { ...friend, notifyOnline: enabled } : friend),
    } : current);
    updateOnlineState(nextDesired);
    if (syncingRelations.has(relationId)) return;

    syncingRelations.add(relationId);
    let confirmedValue = Boolean(renderedValue);
    try {
      while (desiredByRelation.has(relationId)) {
        const desiredValue = desiredByRelation.get(relationId);
        if (desiredValue) {
          await enablePushNotifications();
          if (desiredByRelation.get(relationId) !== desiredValue) continue;
        }
        const response = await friendsApi({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'online_notification', relationId, enabled: desiredValue,
          }),
        });
        if (!response?.ok) throw new Error('Impossible de modifier cette notification.');
        confirmedValue = desiredValue;
        overridesByRelation.set(relationId, confirmedValue);
        if (desiredByRelation.get(relationId) === desiredValue) break;
      }
      updateOnlineState(confirmedValue);
      load(false);
    } catch (error) {
      overridesByRelation.set(relationId, confirmedValue);
      updateOnlineState(confirmedValue);
      onError(error.message);
    } finally {
      desiredByRelation.delete(relationId);
      syncingRelations.delete(relationId);
    }
    try {
      const response = await apiFetch('/api/friends');
      const freshData = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(freshData?.friends)) return;
      const storedValue = freshData.friends
        .find((friend) => friend.relationId === relationId)?.notifyOnline;
      if (!syncingRelations.has(relationId)
        && !desiredByRelation.has(relationId)
        && overridesByRelation.get(relationId) === confirmedValue
        && storedValue === confirmedValue) {
        overridesByRelation.delete(relationId);
      }
      setData(applyOnlineNotificationOverrides(freshData));
    } catch {
      // L’état local confirmé reste prioritaire jusqu’à la prochaine actualisation réussie.
    }
  }

  if (!open) return null;
  const friends = data.friends || [];
  const onlineCount = friends.filter(({ online }) => online).length;
  const actionButton = (className, title, icon, onClick, disabled = false, pressed) => <button type="button" className={`sj-lobby-player-remove ${className}`} onClick={onClick} disabled={disabled} aria-label={title} aria-pressed={typeof pressed === 'boolean' ? pressed : undefined} title={title}>{icon}</button>;
  return <>
    <div className="sj-modal-overlay sj-profile-overlay sj-friends-overlay sj-fade-in" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className={`sj-profile-modal sj-friends-modal sj-pop-in ${loaded ? '' : 'is-loading'}`} role="dialog" aria-modal="true" aria-labelledby="friends-title" aria-busy={!loaded} aria-hidden={friendToRemove || profileFriend ? true : undefined} inert={friendToRemove || profileFriend ? '' : undefined} tabIndex={-1}>
        <header className="sj-profile-head"><div><span>Votre cercle</span><h2 id="friends-title">Amis</h2></div><button type="button" className="sj-profile-close" onClick={onClose} aria-label="Fermer"><X aria-hidden="true" size={20} /></button></header>
        <div className="sj-friends-layout">
          <section className="sj-friends-access" aria-label="Ajouter un ami"><div className="sj-room-lobby-invite sj-friends-code"><span>Votre code ami</span><div><span className="sj-room-code-copy"><button type="button" className={`sj-room-lobby-code ${copied ? 'sj-room-copy-copied' : ''}`} disabled={!loaded} onClick={copyFriendCode}>{data.friendCode || '••••••••'}</button>{copied && <span className="sj-copy-toast" role="status">✓</span>}</span></div><small>Appuyez sur le code pour le copier</small></div><form onSubmit={(event) => { event.preventDefault(); mutate('request', { friendCode: code }); }}><input value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8))} placeholder="Code ami" aria-label="Code ami" disabled={!loaded} /><button type="submit" disabled={!loaded || busyAction === 'request:' || code.length !== 8}><UserPlus aria-hidden="true" size={17} /> Ajouter</button></form></section>
          <div className="sj-friends-content" onScroll={() => setFriendMenu(null)}>
            {!!data.notifications?.length && <section><h3><span>Nouveautés</span></h3><div className="sj-friends-notifications">{data.notifications.slice(0, 3).map((item) => <p key={item.id}><Check aria-hidden="true" size={13} />{item.message}</p>)}</div></section>}
            {!!data.requests?.length && <section><h3><span>Demandes</span><b>{data.requests.length}</b></h3><ul className="sj-lobby-player-list sj-friends-list sj-friends-request-list">{data.requests.map((friend) => <li className="sj-pop-in" key={friend.relationId}><span className="sj-lobby-player-copy"><strong>{friend.name}</strong></span><span className="sj-friends-player-actions">{friend.direction === 'incoming' && actionButton('sj-friends-accept', 'Accepter', <Check aria-hidden="true" size={17} />, () => mutate('accept', { relationId: friend.relationId }))}{actionButton('sj-friends-decline', friend.direction === 'incoming' ? 'Refuser' : 'Annuler', <X aria-hidden="true" size={17} />, () => mutate(friend.direction === 'incoming' ? 'decline' : 'cancel', { relationId: friend.relationId }))}</span></li>)}</ul></section>}
            <section><h3><span>Mes amis</span><span className="sj-friends-online-count"><i aria-hidden="true" />{onlineCount} en ligne</span></h3>{!loaded ? <div className="sj-friends-loading" aria-hidden="true"><span /><span /></div> : friends.length ? <ul className="sj-lobby-player-list sj-friends-list">{friends.map((friend) => {
              const invitationPending = data.sentInvitations?.some((invitation) => invitation.relationId === friend.relationId && invitation.roomId === roomId);
              const menuOpen = friendMenu?.relationId === friend.relationId;
              return <li className={`sj-pop-in ${friend.online === false ? 'is-disconnected' : ''} ${menuOpen ? 'is-menu-open' : ''}`} key={friend.relationId}><span className="sj-lobby-player-copy"><strong>{friend.name}</strong>{friend.online !== null && <i className="sj-lobby-player-presence" role="img" aria-label={friend.status} title={friend.status} />}</span><span className="sj-lobby-player-badges"><span className={friend.status === 'available' ? 'is-online' : ''}>{friend.status === 'lobby' ? 'Dans le lobby' : friend.status === 'playing' ? 'En partie' : friend.status === 'dnd' ? 'Ne pas déranger' : friend.status === 'hidden' ? 'Masqué' : friend.online ? 'Disponible' : 'Hors ligne'}</span>{invitationPending && <span className="is-invited">Invitation envoyée</span>}</span><span className="sj-friends-player-actions">{friend.online === true && friend.game?.visibility === 'public' && friend.game?.canJoin && actionButton('sj-friends-join', 'Rejoindre', <LogIn aria-hidden="true" size={17} />, () => onJoin(friend.game.roomId))}{!inRoom && friend.online === true && friend.game?.visibility === 'public' && friend.game?.canWatch && actionButton('sj-friends-watch', 'Regarder', <Eye aria-hidden="true" size={17} />, () => onWatch(friend.game.roomId))}{roomId && friend.status !== 'dnd' && !invitationPending && actionButton('sj-friends-invite', 'Inviter', <Gamepad2 aria-hidden="true" size={17} />, () => mutate('invite', { relationId: friend.relationId, roomId }))}<span className="sj-friends-more"><button type="button" className="sj-lobby-player-remove sj-friends-more-trigger" aria-label={`Plus d’actions pour ${friend.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`friend-actions-${friend.relationId}`} onClick={(event) => toggleFriendMenu(event, friend.relationId, Boolean(friend.profile))}><Ellipsis aria-hidden="true" size={18} /></button>{menuOpen && createPortal(<span id={`friend-actions-${friend.relationId}`} className={`sj-friends-more-menu ${friendMenu.opensUp ? 'opens-up' : ''}`} style={{ right: friendMenu.right, top: friendMenu.top }} role="menu"><button type="button" className={friend.notifyOnline ? 'is-active' : ''} role="menuitemcheckbox" aria-checked={friend.notifyOnline} onClick={() => { setFriendMenu(null); toggleOnlineNotification(friend.relationId, friend.notifyOnline); }}><Bell aria-hidden="true" size={16} /><span>{friend.notifyOnline ? 'Ne plus signaler sa connexion' : 'Me prévenir lorsqu’il est en ligne'}</span></button>{friend.profile && <button type="button" role="menuitem" onClick={() => { setFriendMenu(null); setProfileFriend(friend); }}><BarChart3 aria-hidden="true" size={16} /><span>Voir les statistiques et la progression</span></button>}<button type="button" className="is-danger" role="menuitem" onClick={() => { setFriendMenu(null); setFriendToRemove(friend); }}><UserMinus aria-hidden="true" size={16} /><span>Retirer l’ami</span></button></span>, document.body)}</span></span></li>;
            })}</ul> : <p className="sj-friends-empty"><UsersRound aria-hidden="true" /> Ajoutez un joueur grâce à son code ami.</p>}</section>
          </div>
          <details ref={settingsRef} className="sj-friends-settings"><summary><Settings aria-hidden="true" size={15} /><span>Statut et confidentialité</span></summary><div><label>Mon statut<select value={data.preferences.status} disabled={!loaded} onChange={(event) => updatePreferences({ status: event.target.value })}><option value="available">Disponible</option><option value="dnd">Ne pas déranger</option></select></label>{preferenceLabels.map(([key, label]) => <label className="sj-friends-toggle" key={key}><span>{label}</span><input type="checkbox" checked={data.preferences[key]} disabled={!loaded} onChange={(event) => updatePreferences({ [key]: event.target.checked })} /><i aria-hidden="true" /></label>)}<label className="sj-friends-toggle"><span>Invitations à jouer hors de l’app</span><input type="checkbox" checked={data.preferences.notifyGameInvites} disabled={!loaded} onChange={(event) => updatePreferences({ notifyGameInvites: event.target.checked })} /><i aria-hidden="true" /></label></div></details>
        </div>
      </section>
    </div>
    <ProfileModal open={!!profileFriend} mode="friend" displayName={profileFriend?.name || ''} statsOverride={profileFriend?.profile || null} onClose={() => setProfileFriend(null)} />
    {friendToRemove && <div className="sj-modal-overlay sj-profile-delete-overlay sj-fade-in" onMouseDown={(event) => event.target === event.currentTarget && setFriendToRemove(null)}><section ref={removeModalRef} className="sj-confirm-modal sj-profile-delete-modal sj-pop-in" role="dialog" aria-modal="true" aria-labelledby="friend-remove-title" tabIndex={-1}><button type="button" className="sj-profile-close sj-profile-delete-close" onClick={() => setFriendToRemove(null)} aria-label="Fermer"><X aria-hidden="true" size={20} /></button><span className="sj-profile-delete-modal-icon" aria-hidden="true"><Trash2 size={23} /></span><h2 id="friend-remove-title">Retirer {friendToRemove.name} ?</h2><p>Cette personne disparaîtra de votre liste d’amis.</p><div className="sj-modal-actions sj-profile-delete-actions"><button type="button" className="sj-btn" onClick={() => setFriendToRemove(null)}>Annuler</button><button type="button" className="sj-btn sj-btn-danger" onClick={() => mutate('remove', { relationId: friendToRemove.relationId })}>Retirer</button></div></section></div>}
  </>;
}
