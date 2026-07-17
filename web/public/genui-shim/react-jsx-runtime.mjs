const R = globalThis.__macaron_JSXRuntime;
if (!R) throw new Error('[genui-shim/jsx-runtime] window.__macaron_JSXRuntime not set');
export const { jsx, jsxs, Fragment } = R;
export default R;
