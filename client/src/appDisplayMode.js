export function isStandaloneApp() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.matchMedia?.('(display-mode: fullscreen)').matches === true
    || window.navigator.standalone === true;
}
