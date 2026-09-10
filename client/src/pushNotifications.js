import { apiFetch } from './apiClient.js';

function decodeApplicationServerKey(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function canUsePushNotifications() {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function enablePushNotifications() {
  if (!canUsePushNotifications()) {
    throw new Error('Les notifications ne sont disponibles que dans l’app installée ou un navigateur compatible en HTTPS.');
  }
  const permission = Notification.permission === 'granted'
    ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Autorisez les notifications dans les réglages de votre appareil pour activer cette option.');
  }
  const configResponse = await apiFetch('/api/push/config');
  const config = await configResponse.json().catch(() => null);
  if (!configResponse.ok || !config?.enabled || !config.publicKey) {
    throw new Error(config?.error?.message || 'Les notifications ne sont pas encore disponibles.');
  }
  const registration = await navigator.serviceWorker.register('/service-worker.js');
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(config.publicKey),
    });
  }
  const serialized = subscription.toJSON();
  const response = await apiFetch('/api/friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'push_subscription',
      endpoint: subscription.endpoint,
      p256dh: serialized.keys?.p256dh,
      auth: serialized.keys?.auth,
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || 'Impossible d’activer les notifications.');
  return subscription;
}
