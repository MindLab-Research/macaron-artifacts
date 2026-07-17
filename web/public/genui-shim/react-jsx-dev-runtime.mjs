const R = globalThis.__macaron_JSXDevRuntime || globalThis.__macaron_JSXRuntime;
if (!R) throw new Error('[genui-shim/jsx-dev-runtime] runtime not set');
export const { jsx, jsxs, jsxDEV, Fragment } = R;
export default R;
