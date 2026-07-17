// React shim — re-exports the single React instance set on window by the host
// app. This guarantees user TSX, our component shims, and partial-react all
// use the same React (otherwise hooks fail with "Invalid hook call").
const R = globalThis.__macaron_React;
if (!R) throw new Error('[genui-shim/react] window.__macaron_React not set');

export default R;
export const {
  Children, Component, Fragment, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createRef, forwardRef,
  isValidElement, lazy, memo, startTransition, version,
  useCallback, useContext, useDebugValue, useDeferredValue, useEffect,
  useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,
  useReducer, useRef, useState, useSyncExternalStore, useTransition,
  // 19+
  use, useActionState, useOptimistic, useFormStatus, useFormState,
  cache,
} = R;
