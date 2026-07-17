// App overlays consistently use role="dialog" + aria-modal="true"; global
// keyboard handlers should treat that as the active-modal boundary.
export function hasActiveModal(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}
