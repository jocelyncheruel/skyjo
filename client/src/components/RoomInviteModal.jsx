import React, { useEffect, useRef, useState } from 'react';
import { Copy, Share2, X } from 'lucide-react';
import QRCode from 'qrcode';

export default function RoomInviteModal({
  open,
  roomId,
  inviteUrl,
  copied,
  onCopy,
  onShare,
  onClose,
}) {
  const modalRef = useRef(null);
  const [qrCodeUrl, setQrCodeUrl] = useState('');
  const [qrCodeError, setQrCodeError] = useState(false);

  useEffect(() => {
    if (!open || !inviteUrl) {
      setQrCodeUrl('');
      setQrCodeError(false);
      return undefined;
    }

    let cancelled = false;
    setQrCodeUrl('');
    setQrCodeError(false);
    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: 'Q',
      margin: 2,
      width: 360,
      color: {
        dark: '#10222b',
        light: '#ffffff',
      },
    }).then((dataUrl) => {
      if (!cancelled) setQrCodeUrl(dataUrl);
    }).catch(() => {
      if (!cancelled) setQrCodeError(true);
    });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl, open]);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="sj-modal-overlay sj-invite-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className="sj-invite-modal sj-pop-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-invite-title"
        aria-describedby="room-invite-description"
        tabIndex={-1}
      >
        <header className="sj-invite-modal-head">
          <div>
            <span>Invitation</span>
            <h2 id="room-invite-title">Rejoindre la salle</h2>
          </div>
          <button
            type="button"
            className="sj-profile-close"
            aria-label="Fermer le QR code"
            onClick={onClose}
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <p id="room-invite-description" className="sj-invite-modal-description">
          Scannez ce QR code pour ouvrir directement la salle.
        </p>
        <div className="sj-invite-qr-frame" aria-live="polite">
          {qrCodeUrl && (
            <img
              src={qrCodeUrl}
              alt={`QR code contenant le lien complet vers la salle ${roomId}`}
            />
          )}
          {!qrCodeUrl && !qrCodeError && <span>Création du QR code…</span>}
          {qrCodeError && <span>Impossible de créer le QR code.</span>}
        </div>
        <p className="sj-invite-url">{inviteUrl}</p>
        <div className="sj-invite-actions">
          <button type="button" className="sj-btn sj-invite-copy-button" onClick={onCopy}>
            <Copy aria-hidden="true" size={17} />
            {copied ? 'Lien copié' : 'Copier le lien'}
          </button>
          <button type="button" className="sj-btn sj-btn-primary sj-invite-share-button" onClick={onShare}>
            <Share2 aria-hidden="true" size={17} />
            Partager
          </button>
        </div>
      </section>
    </div>
  );
}
