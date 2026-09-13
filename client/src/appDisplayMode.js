export function isStandaloneApp() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.navigator.standalone === true;
}
