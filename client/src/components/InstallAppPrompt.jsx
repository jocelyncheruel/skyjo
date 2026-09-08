import React, { useEffect, useState } from 'react';
import { Download, Share, SquarePlus, X } from 'lucide-react';

const DISMISS_KEY = 'skyjo-install-prompt-dismissed-until';
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const PROMPT_DELAY_MS = 6000;

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function isAppleMobile() {
  return /iPad|iPhone|iPod/i.test(window.navigator.userAgent)
    || window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
}

function isRoomOpen() {
  return /(?:^|[&#])room=\d{6}(?:$|&)/i.test(window.location.hash);
}

function dismissalIsActive() {
  try {
    return Number(window.localStorage.getItem(DISMISS_KEY) || 0) > Date.now();
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DURATION_MS));
  } catch {
    // Le refus reste valable pour la session si le stockage est indisponible.
  }
}

export default function InstallAppPrompt() {
  const [installEvent, setInstallEvent] = useState(null);
  const [pageEligible, setPageEligible] = useState(() => !isRoomOpen());
  const [delayElapsed, setDelayElapsed] = useState(false);
  const [dismissed, setDismissed] = useState(() => isStandalone() || dismissalIsActive());
  const [showAppleHelp, setShowAppleHelp] = useState(false);
  const appleMobile = isAppleMobile();

  useEffect(() => {
    const timer = window.setTimeout(() => setDelayElapsed(true), PROMPT_DELAY_MS);
    const handleBeforeInstall = (event) => {
      event.preventDefault();
      setInstallEvent(event);
    };
    const handleInstalled = () => {
      setInstallEvent(null);
      setDismissed(true);
    };
    const handleLocation = () => setPageEligible(!isRoomOpen());

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);
    window.addEventListener('hashchange', handleLocation);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
      window.removeEventListener('hashchange', handleLocation);
    };
  }, []);

  const visible = delayElapsed
    && pageEligible
    && !dismissed
    && !isStandalone()
    && (installEvent || appleMobile);

  function decline() {
    rememberDismissal();
    setDismissed(true);
  }

  async function install() {
    if (!installEvent) {
      setShowAppleHelp(true);
      return;
    }
    try {
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      setInstallEvent(null);
      if (choice?.outcome === 'dismissed') rememberDismissal();
      setDismissed(true);
    } catch {
      setInstallEvent(null);
      setDismissed(true);
    }
  }

  if (!visible) return null;

  return (
    <aside className="sj-install-prompt" role="dialog" aria-modal="false" aria-labelledby="sj-install-title">
      <button type="button" className="sj-install-close" onClick={decline} aria-label="Ne plus proposer maintenant">
        <X aria-hidden="true" size={18} />
      </button>
      <img src="/app-icon-192.png" alt="" width="54" height="54" />
      <div className="sj-install-copy">
        <strong id="sj-install-title">Ajouter Skyjo à votre écran d’accueil</strong>
        {showAppleHelp ? (
          <p className="sj-install-apple-help">
            <span><Share aria-hidden="true" size={17} /> Touchez Partager</span>
            <span><SquarePlus aria-hidden="true" size={17} /> puis « Sur l’écran d’accueil ».</span>
          </p>
        ) : (
          <p>Lancez vos parties plus rapidement, comme une application.</p>
        )}
      </div>
      <div className="sj-install-actions">
        {!showAppleHelp && (
          <button type="button" className="sj-install-accept" onClick={install}>
            <Download aria-hidden="true" size={17} />
            Ajouter
          </button>
        )}
        <button type="button" className="sj-install-decline" onClick={decline}>
          {showAppleHelp ? 'J’ai compris' : 'Non merci'}
        </button>
      </div>
    </aside>
  );
}
