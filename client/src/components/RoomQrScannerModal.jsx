import React, { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

const SCAN_INTERVAL_MS = 140;

export async function supportsNativeQrScanner() {
  if (typeof window === 'undefined'
    || !window.isSecureContext
    || typeof globalThis.BarcodeDetector !== 'function'
    || typeof globalThis.BarcodeDetector.getSupportedFormats !== 'function'
    || typeof navigator.mediaDevices?.getUserMedia !== 'function') return false;

  try {
    const formats = await globalThis.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code');
  } catch {
    return false;
  }
}

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Autorisez l’accès à la caméra pour scanner une invitation.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
    return 'Aucune caméra compatible n’a été trouvée.';
  }
  if (error?.name === 'NotReadableError') {
    return 'La caméra est déjà utilisée par une autre application.';
  }
  return 'Impossible d’ouvrir la caméra sur cet appareil.';
}

function captureScannerFrame(video, frame, canvas) {
  if (!video.videoWidth || !video.videoHeight) return false;
  const videoRect = video.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height || !frameRect.width || !frameRect.height) return false;

  const coverScale = Math.max(
    videoRect.width / video.videoWidth,
    videoRect.height / video.videoHeight,
  );
  const renderedWidth = video.videoWidth * coverScale;
  const renderedHeight = video.videoHeight * coverScale;
  const offsetX = (videoRect.width - renderedWidth) / 2;
  const offsetY = (videoRect.height - renderedHeight) / 2;
  const sourceLeft = Math.max(0, (frameRect.left - videoRect.left - offsetX) / coverScale);
  const sourceTop = Math.max(0, (frameRect.top - videoRect.top - offsetY) / coverScale);
  const sourceRight = Math.min(
    video.videoWidth,
    (frameRect.right - videoRect.left - offsetX) / coverScale,
  );
  const sourceBottom = Math.min(
    video.videoHeight,
    (frameRect.bottom - videoRect.top - offsetY) / coverScale,
  );
  const sourceWidth = sourceRight - sourceLeft;
  const sourceHeight = sourceBottom - sourceTop;
  if (sourceWidth <= 0 || sourceHeight <= 0) return false;

  const outputScale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight));
  canvas.width = Math.max(1, Math.round(sourceWidth * outputScale));
  canvas.height = Math.max(1, Math.round(sourceHeight * outputScale));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return false;
  context.drawImage(
    video,
    sourceLeft,
    sourceTop,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return true;
}

export default function RoomQrScannerModal({ open, onScan, onClose }) {
  const modalRef = useRef(null);
  const videoRef = useRef(null);
  const frameRef = useRef(null);
  const [status, setStatus] = useState('Ouverture de la caméra…');
  const [error, setError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    modalRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return undefined;

    let active = true;
    let stream = null;
    let animationFrame = 0;
    let detectionPending = false;
    let lastScanAt = 0;
    let rejectedUntil = 0;
    const scanCanvas = document.createElement('canvas');

    setStatus('Ouverture de la caméra…');
    setError('');
    setCameraReady(false);
    setCameraUnavailable(false);

    const stopCamera = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const startScanner = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (!active) {
          stopCamera();
          return;
        }

        const video = videoRef.current;
        if (!video) {
          stopCamera();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!active) {
          stopCamera();
          return;
        }

        const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
        setCameraReady(true);
        setStatus('Placez entièrement le QR code dans le cadre.');

        const scanFrame = async (timestamp) => {
          if (!active) return;
          animationFrame = window.requestAnimationFrame(scanFrame);
          if (detectionPending
            || timestamp < rejectedUntil
            || timestamp - lastScanAt < SCAN_INTERVAL_MS
            || video.readyState < 2) return;

          const frame = frameRef.current;
          if (!frame || !captureScannerFrame(video, frame, scanCanvas)) return;

          detectionPending = true;
          lastScanAt = timestamp;
          try {
            const detectedCodes = await detector.detect(scanCanvas);
            if (!active) return;
            const qrCode = detectedCodes.find((code) => (
              code.format === 'qr_code' && typeof code.rawValue === 'string'
            ));
            if (!qrCode) return;

            const accepted = onScan(qrCode.rawValue) !== false;
            if (accepted) {
              active = false;
              stopCamera();
              return;
            }
            setError('Ce QR code ne contient pas une invitation Skyjo valide.');
            setStatus('Présentez un autre QR code.');
            rejectedUntil = timestamp + 1200;
          } catch {
            if (active) setError('Le QR code n’a pas pu être lu. Réessayez en l’éloignant légèrement.');
          } finally {
            detectionPending = false;
          }
        };

        animationFrame = window.requestAnimationFrame(scanFrame);
      } catch (cameraError) {
        if (!active) return;
        setStatus('Scanner indisponible');
        setError(cameraErrorMessage(cameraError));
        setCameraReady(false);
        setCameraUnavailable(true);
        stopCamera();
      }
    };

    void startScanner();
    return () => {
      active = false;
      stopCamera();
    };
  }, [onScan, open]);

  if (!open) return null;

  return (
    <div
      className="sj-modal-overlay sj-qr-scanner-overlay sj-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`sj-qr-scanner-modal sj-pop-in ${cameraUnavailable ? 'sj-qr-scanner-modal-compact' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-scanner-title"
        aria-describedby="qr-scanner-description"
        tabIndex={-1}
      >
        <header className="sj-invite-modal-head">
          <div>
            <span>Invitation</span>
            <h2 id="qr-scanner-title">Scanner un QR code</h2>
          </div>
          <button
            type="button"
            className="sj-profile-close"
            aria-label="Fermer le scanner"
            onClick={onClose}
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <p id="qr-scanner-description" className="sj-invite-modal-description">
          Scannez le QR code d’une salle Skyjo pour la rejoindre directement.
        </p>

        {!cameraUnavailable && (
          <div className="sj-qr-scanner-camera">
            <video ref={videoRef} muted playsInline aria-label="Aperçu de la caméra" />
            <div ref={frameRef} className="sj-qr-scanner-frame" aria-hidden="true">
              <i /><i /><i /><i />
            </div>
            {!cameraReady && <Camera className="sj-qr-scanner-placeholder" aria-hidden="true" size={34} />}
          </div>
        )}

        <div className="sj-qr-scanner-feedback" aria-live="polite">
          <strong>{status}</strong>
          {error && <p>{error}</p>}
        </div>
      </section>
    </div>
  );
}
