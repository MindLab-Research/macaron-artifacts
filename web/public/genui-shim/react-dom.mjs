const R = globalThis.__macaron_ReactDOM;
if (!R) throw new Error('[genui-shim/react-dom] window.__macaron_ReactDOM not set');
export default R;
export const { createPortal, flushSync, version } = R;
