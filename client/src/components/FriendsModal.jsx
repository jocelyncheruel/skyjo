import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BarChart3, Bell, Check, Eye, Gamepad2, Handshake, LogIn, Settings, Trash2, UserMinus, UserPlus, UsersRound, X } from 'lucide-react';
import { apiFetch } from '../apiClient.js';
import ProfileModal from '../ProfileModal.jsx';

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
  ['showGame', 'Afficher « En partie » dans mon statut'],
  ['allowGameAccess', 'Autoriser mes amis à rejoindre ou regarder'],
  ['showQuickProfile', 'Partager mes statistiques et ma progression'],
];

export default function FriendsModal({ open, onClose, onWatch, onJoin, onError, roomId = '', inRoom = false, refreshToken = 0 }) {
  const modalRef = useRef(null);
  const removeModalRef = useRef(null);
  const copyTimerRef = useRef(null);
  const settingsRef = useRef(null);
  const markedOpenRef = useRef(false);
  const [data, setData] = useState(() => friendsCache || emptyFriendsData);
  const [loaded, setLoaded] = useState(() => Boolean(friendsCache));
  const [code, setCode] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [copied, setCopied] = useState(false);
  const [friendToRemove, setFriendToRemove] = useState(null);
  const [profileFriend, setProfileFriend] = useState(null);
  const load = useCallback(async (report = false) => {
    try {
      setData(await friendsApi());
      setLoaded(true);
    } catch (error) { if (report) onError(error.message); }
  }, [onError]);

  useLayoutEffect(() => {
    if (!open || !friendsCache) return;
    setData(friendsCache);
    setLoaded(true);
  }, [open]);

  useEffect(() => {
    if (!open) { markedOpenRef.current = false; return undefined; }
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
    const escape = (event) => { if (event.key !== 'Escape') return; if (friendToRemove) setFriendToRemove(null); else if (profileFriend) setProfileFriend(null); else onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [friendToRemove, onClose, open, profileFriend]);
  useEffect(() => { if (friendToRemove) removeModalRef.current?.focus({ preventScroll: true }); }, [friendToRemove]);
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const closeSettings = (event) => {
      const settings = settingsRef.current;
      if (settings?.open && !settings.contains(event.target)) settings.open = false;
    };
    document.addEventListener('pointerdown', closeSettings);
    return () => document.removeEventListener('pointerdown', closeSettings);
  }, [open]);

  async function mutate(action, values = {}) {
    const previousPreferences = data?.preferences;
    setBusyAction(`${action}:${values.relationId || values.invitationId || ''}`);
    if (action === 'preferences') {
      setData((current) => current ? {
        ...current,
        preferences: {
          ...current.preferences,
          status: values.status,
          showPresence: values.showPresence,
          showGame: values.showGame,
          allowGameAccess: values.allowGameAccess,
          showQuickProfile: values.showQuickProfile,
        },
      } : current);
    }
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
    } catch (error) {
      if (action === 'preferences' && previousPreferences) {
        setData((current) => current ? { ...current, preferences: previousPreferences } : current);
      }
      onError(error.message);
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

  if (!open) return null;
  const friends = data.friends || [];
  const onlineCount = friends.filter(({ online }) => online).length;
  const actionButton = (className, title, icon, onClick, disabled = false) => <button type="button" className={`sj-lobby-player-remove ${className}`} onClick={onClick} disabled={disabled} aria-label={title} title={title}>{icon}</button>;
  return <>
    <div className="sj-modal-overlay sj-profile-overlay sj-friends-overlay sj-fade-in" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} className={`sj-profile-modal sj-friends-modal sj-pop-in ${loaded ? '' : 'is-loading'}`} role="dialog" aria-modal="true" aria-labelledby="friends-title" aria-busy={!loaded} aria-hidden={friendToRemove || profileFriend ? true : undefined} inert={friendToRemove || profileFriend ? '' : undefined} tabIndex={-1}>
        <header className="sj-profile-head"><div><span>Votre cercle</span><h2 id="friends-title">Amis</h2></div><button type="button" className="sj-profile-close" onClick={onClose} aria-label="Fermer"><X aria-hidden="true" size={20} /></button></header>
        <div className="sj-friends-layout">
          <section className="sj-friends-access" aria-label="Ajouter un ami"><div className="sj-room-lobby-invite sj-friends-code"><span>Votre code ami</span><div><span className="sj-room-code-copy"><button type="button" className={`sj-room-lobby-code ${copied ? 'sj-room-copy-copied' : ''}`} disabled={!loaded} onClick={copyFriendCode}>{data.friendCode || '••••••••'}</button>{copied && <span className="sj-copy-toast" role="status">✓</span>}</span></div><small>Appuyez sur le code pour le copier</small></div><form onSubmit={(event) => { event.preventDefault(); mutate('request', { friendCode: code }); }}><input value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8))} placeholder="Code ami" aria-label="Code ami" disabled={!loaded} /><button type="submit" disabled={!loaded || busyAction === 'request:' || code.length !== 8}><UserPlus aria-hidden="true" size={17} /> Ajouter</button></form></section>
          <div className="sj-friends-content">
            {!!data.invitations?.length && <section><h3><span>Invitations</span><Bell aria-hidden="true" size={14} /></h3><ul className="sj-lobby-player-list sj-friends-list sj-friends-request-list">{data.invitations.map((invite) => <li className="sj-pop-in" key={invite.invitationId}><span className="sj-lobby-player-copy"><strong>{invite.name}</strong></span><span className="sj-friends-player-actions">{actionButton('sj-friends-accept', 'Rejoindre', <LogIn aria-hidden="true" size={17} />, () => mutate('accept_invite', { invitationId: invite.invitationId }))}{actionButton('sj-friends-decline', 'Refuser', <X aria-hidden="true" size={17} />, () => mutate('decline_invite', { invitationId: invite.invitationId }))}</span></li>)}</ul></section>}
            {!!data.notifications?.length && <section><h3><span>Nouveautés</span></h3><div className="sj-friends-notifications">{data.notifications.slice(0, 3).map((item) => <p key={item.id}><Check aria-hidden="true" size={13} />{item.message}</p>)}</div></section>}
            {!!data.requests?.length && <section><h3><span>Demandes</span><b>{data.requests.length}</b></h3><ul className="sj-lobby-player-list sj-friends-list sj-friends-request-list">{data.requests.map((friend) => <li className="sj-pop-in" key={friend.relationId}><span className="sj-lobby-player-copy"><strong>{friend.name}</strong></span><span className="sj-friends-player-actions">{friend.direction === 'incoming' && actionButton('sj-friends-accept', 'Accepter', <Check aria-hidden="true" size={17} />, () => mutate('accept', { relationId: friend.relationId }))}{actionButton('sj-friends-decline', friend.direction === 'incoming' ? 'Refuser' : 'Annuler', <X aria-hidden="true" size={17} />, () => mutate(friend.direction === 'incoming' ? 'decline' : 'cancel', { relationId: friend.relationId }))}</span></li>)}</ul></section>}
            <section><h3><span>Mes amis</span><span className="sj-friends-online-count"><i aria-hidden="true" />{onlineCount} en ligne</span></h3>{!loaded ? <div className="sj-friends-loading" aria-hidden="true"><span /><span /></div> : friends.length ? <ul className="sj-lobby-player-list sj-friends-list">{friends.map((friend) => {
              const invitationPending = data.sentInvitations?.some((invitation) => invitation.relationId === friend.relationId && invitation.roomId === roomId);
              return <li className={`sj-pop-in ${friend.online === false ? 'is-disconnected' : ''}`} key={friend.relationId}><span className="sj-lobby-player-copy"><strong>{friend.name}</strong>{friend.online !== null && <i className="sj-lobby-player-presence" role="img" aria-label={friend.status} title={friend.status} />}</span><span className="sj-lobby-player-badges"><span className={friend.status === 'available' ? 'is-online' : ''}>{friend.status === 'playing' ? 'En partie' : friend.status === 'dnd' ? 'Ne pas déranger' : friend.status === 'hidden' ? 'Masqué' : friend.online ? 'Disponible' : 'Hors ligne'}</span>{invitationPending && <span className="is-invited">Invitation envoyée</span>}</span><span className="sj-friends-player-actions">{friend.online === true && friend.game?.visibility === 'public' && friend.game?.canJoin && actionButton('sj-friends-join', 'Rejoindre', <LogIn aria-hidden="true" size={17} />, () => onJoin(friend.game.roomId))}{!inRoom && friend.online === true && friend.game?.visibility === 'public' && friend.game?.canWatch && actionButton('sj-friends-watch', 'Regarder', <Eye aria-hidden="true" size={17} />, () => onWatch(friend.game.roomId))}{roomId && friend.status !== 'dnd' && !invitationPending && actionButton('sj-friends-invite', 'Inviter', <Gamepad2 aria-hidden="true" size={17} />, () => mutate('invite', { relationId: friend.relationId, roomId }))}{friend.profile && actionButton('sj-friends-profile-action', 'Voir le profil', <BarChart3 aria-hidden="true" size={17} />, () => setProfileFriend(friend))}{actionButton('', 'Retirer', <UserMinus aria-hidden="true" size={17} />, () => setFriendToRemove(friend))}</span></li>;
            })}</ul> : <p className="sj-friends-empty"><UsersRound aria-hidden="true" /> Ajoutez un joueur grâce à son code ami.</p>}</section>
          </div>
          <details ref={settingsRef} className="sj-friends-settings"><summary><Settings aria-hidden="true" size={15} /><span>Statut et confidentialité</span></summary><div><label>Mon statut<select value={data.preferences.status} disabled={!loaded || busyAction.startsWith('preferences:')} onChange={(event) => mutate('preferences', { ...data.preferences, status: event.target.value })}><option value="available">Disponible</option><option value="dnd">Ne pas déranger</option></select></label>{preferenceLabels.map(([key, label]) => <label className="sj-friends-toggle" key={key}><span>{label}</span><input type="checkbox" checked={data.preferences[key]} disabled={!loaded || busyAction.startsWith('preferences:')} onChange={(event) => mutate('preferences', { ...data.preferences, [key]: event.target.checked })} /><i aria-hidden="true" /></label>)}</div></details>
        </div>
      </section>
    </div>
    <ProfileModal open={!!profileFriend} mode="friend" displayName={profileFriend?.name || ''} statsOverride={profileFriend?.profile || null} onClose={() => setProfileFriend(null)} />
    {friendToRemove && <div className="sj-modal-overlay sj-profile-delete-overlay sj-fade-in" onMouseDown={(event) => event.target === event.currentTarget && setFriendToRemove(null)}><section ref={removeModalRef} className="sj-confirm-modal sj-profile-delete-modal sj-pop-in" role="dialog" aria-modal="true" aria-labelledby="friend-remove-title" tabIndex={-1}><button type="button" className="sj-profile-close sj-profile-delete-close" onClick={() => setFriendToRemove(null)} aria-label="Fermer"><X aria-hidden="true" size={20} /></button><span className="sj-profile-delete-modal-icon" aria-hidden="true"><Trash2 size={23} /></span><h2 id="friend-remove-title">Retirer {friendToRemove.name} ?</h2><p>Cette personne disparaîtra de votre liste d’amis.</p><div className="sj-modal-actions sj-profile-delete-actions"><button type="button" className="sj-btn" onClick={() => setFriendToRemove(null)}>Annuler</button><button type="button" className="sj-btn sj-btn-danger" onClick={() => mutate('remove', { relationId: friendToRemove.relationId })}>Retirer</button></div></section></div>}
  </>;
}
