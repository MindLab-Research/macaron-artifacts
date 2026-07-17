import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { GenUIRenderer, type GenUIRendererFlushMode, type GenUIRenderPhase } from "partial-react";
import { createImportMapResolver, esmShFallback, extractBareModuleSpecifiers, hasImportMapEntry, literalImportMap, prepareRendererImportMap } from "partial-react/import-map";
import { createTsxCompiler } from "partial-react/compiler";
import { assetUrl } from "../lib/assetBase";

// --- stubs replacing @/components/GenUIStyleScope and useAppStoreBridge ---
// Our preview doesn't use UnoCSS scope isolation (we use UnoCSS runtime globally)
// or the app-store bridge (no two-way state with the host).
const useGenUIStyleScope = () => null as { prime?: (code: string) => Promise<void> } | null;
type AppStoreBridgeOptions = { data?: unknown; onChange?: (...args: unknown[]) => void };
const useAppStoreBridge = (_opts?: AppStoreBridgeOptions) => undefined as Record<string, string> | undefined;

export type StaticGenUIRendererProps = {
  code: string;
  active?: boolean;
  className?: string;
  extraImportMapEntries?: Record<string, string> | null;
  appStore?: AppStoreBridgeOptions;
  preserveStateOnUpdate?: boolean;
  streaming?: boolean;
  flushMode?: GenUIRendererFlushMode;
  onReady?: () => void;
  onRendered?: (code: string) => void;
  onPreviewApplied?: (event: GenUIPreviewAppliedEvent) => void;
  onError?: (error: Error, phase: GenUIRenderPhase) => void;
};

export type GenUIPreviewAppliedEvent = { code: string; status: "rendered" | "empty" | "error"; error?: Error; phase?: GenUIRenderPhase };
type GenerativeUIRendererType = GenUIRenderer;
type RendererImportMapEntries = Record<string, string> | null | undefined;
let rendererWarmupPromise: Promise<void> | null = null;
let genUIConsolePatched = false;
const GENUI_DEV_IMPORTMAP_PATH = "/node_modules/.genui/importmap.json";
const GENUI_RENDERER_CROSSFADE_MS = 200;
const localNodeModulePackageCache = new Map<string, Promise<boolean>>();
type RenderedNotification = { renderer: GenerativeUIRendererType; code: string; serial: number };

// React inside remote esm.sh fallback packages must resolve back to the host's
// React via a page-level importmap, otherwise third-party components pull in a
// second React copy.
let nativeReactImportMapPromise: Promise<void> | null = null;
const NATIVE_REACT_SPECIFIERS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "scheduler"] as const;
const ensureNativeReactImportMap = (imports: Record<string, string>) =>
  (nativeReactImportMapPromise ??= (async () => {
    // Skip if the host page already has an importmap — don't clobber theirs.
    if (typeof document === "undefined" || document.querySelector('script[type="importmap"]')) return;
    const reactImports = Object.fromEntries(NATIVE_REACT_SPECIFIERS.flatMap((specifier) => (imports[specifier] ? [[specifier, new URL(imports[specifier], location.href).href]] : [])));
    // If the caller's imports don't include react at all, injecting a
    // react-less importmap would make bare `react` from esm.sh externals
    // fail — let it fall through to the bundled path instead.
    if (!reactImports["react"]) return;
    const script = document.createElement("script");
    script.type = "importmap";
    script.textContent = JSON.stringify({ imports: reactImports });
    document.head.prepend(script);
  })());

const patchRecoverableGenUIErrors = () => {
  if (genUIConsolePatched || typeof window === "undefined") return;
  genUIConsolePatched = true;
};

const getRendererModule = async () => {
  patchRecoverableGenUIErrors();
  return { GenUIRenderer };
};

const appendQueryParam = (url: string, key: string, value: string) => {
  const [hashless, hash = ""] = url.split("#", 2);
  const separator = hashless.includes("?") ? "&" : "?";
  return `${hashless}${separator}${key}=${encodeURIComponent(value)}${hash ? `#${hash}` : ""}`;
};

const hasLocalNodeModulePackage = (packageName: string) => {
  if (!import.meta.env.DEV || typeof window === "undefined") return Promise.resolve(false);
  const cached = localNodeModulePackageCache.get(packageName);
  if (cached) return cached;
  const promise = fetch(`/node_modules/${packageName}/package.json`, { cache: "force-cache" })
    .then((response) => response.ok)
    .catch(() => false);
  localNodeModulePackageCache.set(packageName, promise);
  return promise;
};
// Base import map pointing user TSX at our locally-served shim files. The shim
// files re-export from window.__macaron_* globals (set in main.tsx), so user
// code, our vendored components, and partial-react all share one React.
const BASE_IMPORTS: Record<string, string> = (() => {
  // origin + Vite base (via assetUrl), so shims resolve under /app/ when
  // hosted and at root locally. The import map needs absolute URLs.
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const prefix = origin + assetUrl('');
  return {
    react: prefix + '/genui-shim/react.mjs',
    'react/jsx-runtime': prefix + '/genui-shim/react-jsx-runtime.mjs',
    'react/jsx-dev-runtime': prefix + '/genui-shim/react-jsx-dev-runtime.mjs',
    'react-dom': prefix + '/genui-shim/react-dom.mjs',
    '$macaron/ui': prefix + '/genui-shim/ui.mjs',
    '$macaron/ui/charts': prefix + '/genui-shim/charts.mjs',
    'lucide-react': prefix + '/genui-shim/lucide.mjs',
    'framer-motion': prefix + '/genui-shim/motion.mjs',
    motion: prefix + '/genui-shim/motion.mjs',
    'motion/react': prefix + '/genui-shim/motion.mjs',
    '$macaron/chat': prefix + '/genui-shim/chat.mjs',
  };
})();

// Exported so the host app can warm up the TSX wasm + compiler at boot,
// before the first render_ui call. Without this, the first GenUI frame
// pays the full wasm init cost (~400-500ms) inside the streaming render
// loop, which blocks the first visible content.
export const preloadRendererRuntime = () =>
  (rendererWarmupPromise ??= (async () => {
    // Use the same BASE_IMPORTS the live renderer uses, so the warm-up
    // compile is representative of a real frame (the previous hardcoded
    // "/src/lib/react.ts" paths only exist in the macaron-genui-demo dev
    // tree and would 404 in our production build, leaving the warm-up
    // to fail silently).
    await createTsxCompiler().compile("export default function App() { return null; }", { importMap: { imports: BASE_IMPORTS } });
    // Prefetch the genui-shim modules so the first real `import(blob URL)`
    // doesn't stall on a network round-trip for each shim. The shims are
    // tiny (<5KB each) but the browser fetches them serially through the
    // import map, which adds ~50-150ms to the first frame.
    if (typeof window !== 'undefined') {
      for (const url of Object.values(BASE_IMPORTS)) {
        // link rel=modulepreload warms the network cache and the module
        // graph; the browser deduplicates against later `import()` calls.
        const link = document.createElement('link');
        link.rel = 'modulepreload';
        link.href = url;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      }
    }
  })());

const loadRendererImportMap = async (code: string, extraEntries?: Record<string, string>) => {
  // base local map → caller-supplied entries → esm.sh fallback for unknown bare specifiers
  const resolved = await createImportMapResolver([
    literalImportMap({ imports: BASE_IMPORTS }),
    literalImportMap({ imports: extraEntries ?? {} }),
    esmShFallback({ hasLocalPackage: hasLocalNodeModulePackage }),
  ]).resolve({ code });
  const importMap = prepareRendererImportMap(resolved);
  return { importMap, importSpecifiers: new Map(Object.entries(importMap.imports ?? {})) };
};
const normalizeError = (error: unknown) => (error instanceof Error ? error : new Error(typeof error === "string" ? error : "Failed to render app code"));
const clearHost = (hostRef: RefObject<HTMLDivElement | null>) => {
  if (hostRef.current) hostRef.current.innerHTML = "";
};
export const shouldRecreateRendererForSpecifiers = (existingSpecifiers: Map<string, string>, nextCode: string, preserveStateOnUpdate: boolean) => !preserveStateOnUpdate && [...extractBareModuleSpecifiers(nextCode)].some((specifier) => !hasImportMapEntry(existingSpecifiers, specifier));
export const getMissingRendererSpecifiers = (existingSpecifiers: Map<string, string>, nextCode: string) => [...extractBareModuleSpecifiers(nextCode)].filter((specifier) => !hasImportMapEntry(existingSpecifiers, specifier));
const getRendererImportSpecifierTarget = (specifiers: Map<string, string>, specifier: string) => {
  if (specifiers.has(specifier)) return specifiers.get(specifier);
  for (const [key, target] of specifiers) if (key.endsWith("/") && specifier.startsWith(key)) return target;
};
export const hasRendererImportSpecifierChanges = (currentSpecifiers: Map<string, string>, nextSpecifiers: Map<string, string>, requiredSpecifiers: Iterable<string>) => {
  for (const specifier of requiredSpecifiers) if (!hasImportMapEntry(currentSpecifiers, specifier) || getRendererImportSpecifierTarget(currentSpecifiers, specifier) !== getRendererImportSpecifierTarget(nextSpecifiers, specifier)) return true;
  return false;
};
export const shouldRefreshRendererImportMap = (currentSpecifiers: Map<string, string>, nextSpecifiers: Map<string, string>, requiredSpecifiers: Iterable<string>, preserveStateOnUpdate: boolean, streaming: boolean) =>
  !(preserveStateOnUpdate && streaming) && hasRendererImportSpecifierChanges(currentSpecifiers, nextSpecifiers, requiredSpecifiers);
export const shouldReuseStreamingRendererImportMap = (missingSpecifierCount: number, preserveStateOnUpdate: boolean, streaming: boolean) => missingSpecifierCount === 0 && preserveStateOnUpdate && streaming;
export const shouldSkipRenderRequest = (requestedCode: string | null, nextCode: string, hasRenderer: boolean, rendererBroken: boolean) => requestedCode === nextCode && hasRenderer && !rendererBroken;
export const shouldAcceptRenderedCode = (pendingCode: string, renderedCode: string) => pendingCode === renderedCode;
export const shouldRetryAfterStaleRenderer = (currentRenderer: GenerativeUIRendererType | null, resolvedRenderer: GenerativeUIRendererType | null) => Boolean(resolvedRenderer && currentRenderer !== resolvedRenderer);
export const shouldDisposeRendererAfterSetupError = (rendererExistedBeforeSetup: boolean) => rendererExistedBeforeSetup;
export const shouldSurfaceRenderError = (streaming: boolean) => !streaming;
export const shouldFinishStreamingRendererInPlace = (finalCode: string, committedCode: string, hasRenderer: boolean) => hasRenderer && finalCode === committedCode;
export const shouldDeliverRenderedNotification = (previous: RenderedNotification | null, renderer: GenerativeUIRendererType, code: string, serial: number | undefined, currentRenderer: GenerativeUIRendererType | null, currentSerial: number, pendingCode: string) =>
  serial !== undefined && renderer === currentRenderer && serial === currentSerial && shouldAcceptRenderedCode(pendingCode, code) && !(previous?.renderer === renderer && previous.code === code && previous.serial === serial);
export const mergeRendererImportMapEntries = (extraEntries: RendererImportMapEntries, appStoreEntries: RendererImportMapEntries): RendererImportMapEntries => {
  if (extraEntries === null || appStoreEntries === null) return null;
  const entries = { ...extraEntries, ...appStoreEntries };
  return Object.keys(entries).length ? entries : undefined;
};
export const shouldRequestRenderForImportMapEntries = (entries: RendererImportMapEntries, active: boolean) => entries !== null && active;
export const notifyEmptyBufferCompleted = (callbacks: Pick<StaticGenUIRendererProps, "onRendered" | "onPreviewApplied">, code: string) => {
  callbacks.onRendered?.(code);
  callbacks.onPreviewApplied?.({ code, status: "empty" });
};
export const notifyStreamingRendererError = (callbacks: Pick<StaticGenUIRendererProps, "onPreviewApplied">, code: string, error: Error, phase: GenUIRenderPhase) => {
  callbacks.onPreviewApplied?.({ code, status: "error", error, phase });
};
export const getRendererUpdateOperation = (previousCode: string, nextCode: string, streaming: boolean) => {
  const isAppendOnly = nextCode.length > previousCode.length && nextCode.startsWith(previousCode);
  if ((streaming && previousCode.length === 0) || (streaming && previousCode.length > 0 && isAppendOnly)) return { method: "push" as const, code: previousCode.length > 0 ? nextCode.slice(previousCode.length) : nextCode };
  if (streaming) return { method: "replace-push" as const, code: nextCode };
  return { method: "render" as const, code: nextCode };
};

const configureRendererForLiveTyping = (renderer: GenerativeUIRendererType, preserveStateOnUpdate: boolean, flushMode: GenUIRendererFlushMode) => {
  renderer.setPreserveStateOnUpdate(preserveStateOnUpdate);
  renderer.setFlushMode(flushMode);
  return renderer;
};

export default function StaticGenUIRenderer({ code, active = true, className, extraImportMapEntries, appStore, preserveStateOnUpdate = true, streaming = false, flushMode = "microtask", onReady, onRendered, onPreviewApplied, onError }: StaticGenUIRendererProps) {
  const styleScope = useGenUIStyleScope();
  const appStoreEntries = useAppStoreBridge(appStore);
  const hostShellRef = useRef<HTMLDivElement>(null);
  const visibleHostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GenerativeUIRendererType | null>(null);
  const rendererInitRef = useRef<Promise<GenerativeUIRendererType | null> | null>(null);
  const callbacksRef = useRef({ onReady, onRendered, onPreviewApplied, onError });
  const renderLoopRef = useRef<Promise<void> | null>(null);
  const committedCodeRef = useRef("");
  const pendingCodeRef = useRef(code);
  const requestedCodeRef = useRef<string | null>(null);
  const rendererImportSpecifiersRef = useRef<Map<string, string>>(new Map());
  const primeScopedStyles = useEffectEvent((nextCode: string) => styleScope?.prime(nextCode) ?? Promise.resolve());
  const mergedImportMapEntries = useMemo(() => mergeRendererImportMapEntries(extraImportMapEntries, appStoreEntries), [appStoreEntries, extraImportMapEntries]);
  const importMapEntriesPending = mergedImportMapEntries === null;
  const importMapEntriesPendingRef = useRef(importMapEntriesPending);
  const extraImportMapEntriesRef = useRef<Record<string, string> | undefined>(mergedImportMapEntries ?? undefined);
  const preserveStateOnUpdateRef = useRef(preserveStateOnUpdate);
  const streamingRef = useRef(streaming);
  const flushModeRef = useRef(flushMode);
  const activeRef = useRef(active);
  const destroyedRef = useRef(false);
  const rendererBrokenRef = useRef(false);
  const renderSerialRef = useRef(0);
  const renderedNotificationRef = useRef<RenderedNotification | null>(null);
  const latestCodeRef = useRef(code);
  const crossfadeSnapshotRef = useRef<HTMLDivElement | null>(null);
  const crossfadeSnapshotCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    callbacksRef.current = { onReady, onRendered, onPreviewApplied, onError };
  }, [onReady, onRendered, onPreviewApplied, onError]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useLayoutEffect(() => {
    importMapEntriesPendingRef.current = importMapEntriesPending;
  }, [importMapEntriesPending]);

  useEffect(() => {
    extraImportMapEntriesRef.current = mergedImportMapEntries ?? undefined;
    // A live renderer still holds the import map built from the previous
    // entries. When the reference changes, drop it so the next
    // ensureRenderer rebuilds from the latest ref. First mount has an empty
    // rendererRef, so nothing to do there.
    if (mergedImportMapEntries === null) return;
    if (rendererRef.current) disposeRenderer(false);
    if (shouldRequestRenderForImportMapEntries(mergedImportMapEntries, activeRef.current)) requestRenderEvent();
  }, [mergedImportMapEntries]);
  useEffect(() => {
    preserveStateOnUpdateRef.current = preserveStateOnUpdate;
    rendererRef.current?.setPreserveStateOnUpdate(preserveStateOnUpdate);
  }, [preserveStateOnUpdate]);
  useEffect(() => {
    flushModeRef.current = flushMode;
    rendererRef.current?.setFlushMode(flushMode);
  }, [flushMode]);
  useEffect(() => {
    const wasStreaming = streamingRef.current;
    streamingRef.current = streaming;
    if (wasStreaming && !streaming) {
      const finalCode = latestCodeRef.current;
      pendingCodeRef.current = finalCode;
      const renderer = rendererRef.current;
      if (shouldFinishStreamingRendererInPlace(finalCode, committedCodeRef.current, Boolean(renderer))) {
        const serial = renderSerialRef.current + 1;
        renderSerialRef.current = serial;
        clearRenderedNotification();
        requestedCodeRef.current = finalCode;
        renderer?.finish(undefined, serial);
        return;
      }
      requestedCodeRef.current = null;
      renderer?.finish(finalCode);
      requestRenderEvent();
    }
  }, [streaming]);

  const detachRenderer = (renderer: GenerativeUIRendererType) => {
    try {
      renderer.detach();
    } catch {
      // React can still be finishing work scheduled by the generated app; a stale preview root is disposable.
      clearHost(visibleHostRef);
    }
  };

  const clearCrossfadeSnapshot = () => {
    crossfadeSnapshotCleanupRef.current?.();
    crossfadeSnapshotCleanupRef.current = null;
    visibleHostRef.current?.style.setProperty("opacity", "1");
    crossfadeSnapshotRef.current?.remove();
    crossfadeSnapshotRef.current = null;
  };

  const abandonCrossfadeSnapshot = () => {
    // Compile/transform errors have no future onRendered signal for this request; reveal the last good live host immediately.
    clearCrossfadeSnapshot();
  };

  const stageCrossfadeSnapshot = () => {
    const shell = hostShellRef.current;
    const currentHost = visibleHostRef.current;
    // A renderer rebuild wipes the live root; take a visual snapshot first
    // and fade it out only once the new DOM is confirmed visible.
    if (crossfadeSnapshotRef.current || !shell || !currentHost?.innerHTML.trim() || currentHost.parentNode !== shell) return;
    const snapshot = currentHost.cloneNode(true) as HTMLDivElement;
    snapshot.setAttribute("aria-hidden", "true");
    snapshot.setAttribute("inert", "");
    snapshot.style.opacity = "1";
    snapshot.style.pointerEvents = "none";
    currentHost.before(snapshot);
    currentHost.style.opacity = "0";
    crossfadeSnapshotRef.current = snapshot;
  };

  const revealVisibleHost = () => {
    const nextHost = visibleHostRef.current;
    if (!nextHost) return;
    nextHost.style.opacity = "1";
    const snapshot = crossfadeSnapshotRef.current;
    if (!snapshot) return;
    crossfadeSnapshotCleanupRef.current?.();
    const removeSnapshot = () => {
      snapshot.remove();
      if (crossfadeSnapshotRef.current === snapshot) crossfadeSnapshotRef.current = null;
      crossfadeSnapshotCleanupRef.current = null;
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === snapshot && event.propertyName === "opacity") removeSnapshot();
    };
    snapshot.addEventListener("transitionend", handleTransitionEnd);
    const animation = snapshot.animate({ opacity: [1, 0] }, { duration: GENUI_RENDERER_CROSSFADE_MS, fill: "forwards", easing: "ease" });
    void animation.finished.then(removeSnapshot, removeSnapshot);
    crossfadeSnapshotCleanupRef.current = () => {
      snapshot.removeEventListener("transitionend", handleTransitionEnd);
      animation.cancel();
    };
    snapshot.style.opacity = "0";
    snapshot.style.pointerEvents = "none";
    if (!GENUI_RENDERER_CROSSFADE_MS) queueMicrotask(removeSnapshot);
  };

  const clearRenderedNotification = () => {
    renderedNotificationRef.current = null;
  };

  const disposeRenderer = (clearVisibleHost = false) => {
    const staleRenderer = rendererRef.current;
    if (staleRenderer && !clearVisibleHost) stageCrossfadeSnapshot();
    if (staleRenderer) detachRenderer(staleRenderer);
    rendererRef.current = null;
    rendererInitRef.current = null;
    committedCodeRef.current = "";
    requestedCodeRef.current = null;
    rendererImportSpecifiersRef.current = new Map();
    rendererBrokenRef.current = false;
    clearRenderedNotification();
    if (clearVisibleHost) {
      revealVisibleHost();
      clearHost(visibleHostRef);
    }
  };
  const handleRendererReady = (renderer: GenerativeUIRendererType) => {
    if (renderer === rendererRef.current) callbacksRef.current.onReady?.();
  };

  const handleRendererRendered = (renderer: GenerativeUIRendererType, code: string, serial?: number) => {
    if (serial === undefined) return;
    const previous = renderedNotificationRef.current;
    if (!shouldDeliverRenderedNotification(previous, renderer, code, serial, rendererRef.current, renderSerialRef.current, pendingCodeRef.current)) return;
    renderedNotificationRef.current = { renderer, code, serial };
    rendererBrokenRef.current = false;
    revealVisibleHost();
    callbacksRef.current.onRendered?.(code);
    callbacksRef.current.onPreviewApplied?.({ code, status: "rendered" });
  };

  const handleRendererError = (renderer: GenerativeUIRendererType, error: unknown, phase: GenUIRenderPhase) => {
    if (renderer !== rendererRef.current) return;
    abandonCrossfadeSnapshot();
    const nextError = normalizeError(error);
    clearRenderedNotification();
    if (streamingRef.current) {
      // While the stream buffer is still short of `export default function
      // App()`, the stream-compiler throws "No default export found in
      // compiled module."; half-written TSX also often trips ReferenceError
      // on TS-residual identifiers like `Record`. Both are transient — the
      // next chunk + compile fixes them. Don't hand the host a black screen.
      notifyStreamingRendererError(callbacksRef.current, pendingCodeRef.current, nextError, phase);
      return;
    }
    rendererBrokenRef.current = true;
    callbacksRef.current.onError?.(nextError, phase);
  };

  const renderCode = (renderer: GenerativeUIRendererType, nextCode: string) => {
    const previousCode = committedCodeRef.current;
    const serial = renderSerialRef.current + 1;
    renderSerialRef.current = serial;
    clearRenderedNotification();
    const operation = getRendererUpdateOperation(rendererRef.current === renderer ? previousCode : "", nextCode, streamingRef.current);
    if (operation.method === "push") renderer.pushCode(operation.code, serial);
    else if (operation.method === "replace-push") {
      // A streaming host can restart or edit the buffer backwards (for example, a complete preview followed by a shorter partial frame). Keep the last visual tree while compiling the replacement as partial TSX.
      renderer.clear({ preserveVisualState: preserveStateOnUpdateRef.current });
      renderer.pushCode(operation.code, serial);
    } else renderer.render(operation.code, serial);
    committedCodeRef.current = nextCode;
  };

  const ensureRenderer = async (codeForImports = pendingCodeRef.current) => {
    let target = visibleHostRef.current;
    if (!target) return null;
    const existing = rendererRef.current;
    if (existing) {
      const missingSpecifiers = getMissingRendererSpecifiers(rendererImportSpecifiersRef.current, codeForImports);
      if (missingSpecifiers.length > 0 && preserveStateOnUpdateRef.current) {
        const { importMap: nextImportMap, importSpecifiers } = await loadRendererImportMap(codeForImports, extraImportMapEntriesRef.current);
        existing.setImportMap(nextImportMap);
        rendererImportSpecifiersRef.current = importSpecifiers;
        existing.attach(target);
        return configureRendererForLiveTyping(existing, preserveStateOnUpdateRef.current, flushModeRef.current);
      }
      if (missingSpecifiers.length > 0) {
        disposeRenderer(false);
        target = visibleHostRef.current;
        if (!target) return null;
      } else if (shouldReuseStreamingRendererImportMap(missingSpecifiers.length, preserveStateOnUpdateRef.current, streamingRef.current)) {
        existing.attach(target);
        return configureRendererForLiveTyping(existing, preserveStateOnUpdateRef.current, flushModeRef.current);
      } else {
        const requiredSpecifiers = extractBareModuleSpecifiers(codeForImports);
        const { importMap: nextImportMap, importSpecifiers } = await loadRendererImportMap(codeForImports, extraImportMapEntriesRef.current);
        if (shouldRefreshRendererImportMap(rendererImportSpecifiersRef.current, importSpecifiers, requiredSpecifiers, preserveStateOnUpdateRef.current, streamingRef.current)) {
          existing.setImportMap(nextImportMap);
          rendererImportSpecifiersRef.current = importSpecifiers;
        }
        existing.attach(target);
        // Re-apply the live-typing patch on reused instances as well, because this component keeps one renderer alive
        // across tab switches and future refactors may recreate it from cached state rather than from this call site.
        return configureRendererForLiveTyping(existing, preserveStateOnUpdateRef.current, flushModeRef.current);
      }
    }
    const module = await getRendererModule();
    if (destroyedRef.current) return null;
    if (!rendererInitRef.current) {
      rendererInitRef.current = (async () => {
        // Apply the patch immediately after create so the very first keystroke also stays on the no-debounce path.
        const { importMap: nextImportMap, importSpecifiers } = await loadRendererImportMap(codeForImports, extraImportMapEntriesRef.current);
        let nextRenderer: GenerativeUIRendererType | null = null;
        nextRenderer = configureRendererForLiveTyping(
          await module.GenUIRenderer.create(target, {
            importmap: nextImportMap,
            preserveStateOnUpdate: preserveStateOnUpdateRef.current,
            flushMode: flushModeRef.current,
            callbacks: {
              onReady: () => (nextRenderer ? handleRendererReady(nextRenderer) : undefined),
              onRendered: (_component, renderedCode, serial) => (nextRenderer ? handleRendererRendered(nextRenderer, renderedCode, serial) : undefined),
              onError: (error: unknown, phase: GenUIRenderPhase) => (nextRenderer ? handleRendererError(nextRenderer, error, phase) : undefined),
            },
          }),
          preserveStateOnUpdateRef.current,
          flushModeRef.current,
        );
        if (destroyedRef.current) {
          nextRenderer.detach();
          return null;
        }
        rendererRef.current = nextRenderer;
        rendererImportSpecifiersRef.current = importSpecifiers;
        return nextRenderer;
      })().finally(() => {
        rendererInitRef.current = null;
      });
    }
    return rendererInitRef.current;
  };

  const requestRender = () => {
    if (importMapEntriesPendingRef.current || !activeRef.current || renderLoopRef.current) return;
    renderLoopRef.current = (async () => {
      while (!destroyedRef.current) {
        const nextCode = pendingCodeRef.current;
        if (shouldSkipRenderRequest(requestedCodeRef.current, nextCode, Boolean(rendererRef.current), rendererBrokenRef.current)) {
          if (rendererRef.current) void ensureRenderer(nextCode);
          return;
        }
        requestedCodeRef.current = nextCode;
        if (!nextCode.trim()) {
          renderSerialRef.current += 1;
          committedCodeRef.current = "";
          rendererBrokenRef.current = false;
          clearRenderedNotification();
          // Token playback starts from an empty buffer; keep the existing scope/visual tree so chart snapshots can bridge into the first partial frame.
          rendererRef.current?.clear({ preserveVisualState: streamingRef.current && preserveStateOnUpdateRef.current });
          if (!rendererRef.current) clearHost(visibleHostRef);
          revealVisibleHost();
          // Empty buffers are a terminal state for this render pass. Looping here would recreate the same
          // "clear renderer -> forget requested code" cycle forever and pin the main thread on blank previews.
          requestedCodeRef.current = nextCode;
          notifyEmptyBufferCompleted(callbacksRef.current, nextCode);
          return;
        }
        if (rendererBrokenRef.current) disposeRenderer(false);
        const needsFreshRenderer = Boolean(rendererRef.current && shouldRecreateRendererForSpecifiers(rendererImportSpecifiersRef.current, nextCode, preserveStateOnUpdateRef.current));
        if (needsFreshRenderer) disposeRenderer(false);
        const rendererExistedBeforeSetup = Boolean(rendererRef.current);
        let renderer: GenerativeUIRendererType | null;
        try {
          const [nextRenderer] = await Promise.all([ensureRenderer(nextCode), primeScopedStyles(nextCode)]);
          if (pendingCodeRef.current !== nextCode) return;
          renderer = nextRenderer;
        } catch (error) {
          if (rendererRef.current && shouldDisposeRendererAfterSetupError(rendererExistedBeforeSetup)) disposeRenderer(true);
          else abandonCrossfadeSnapshot();
          if (!destroyedRef.current && pendingCodeRef.current === nextCode) callbacksRef.current.onError?.(normalizeError(error), "compile");
          return;
        }
        if (!renderer || destroyedRef.current) return;
        if (shouldRetryAfterStaleRenderer(rendererRef.current, renderer)) {
          clearCrossfadeSnapshot();
          requestedCodeRef.current = null;
          continue;
        }
        try {
          renderCode(renderer, nextCode);
        } catch (error) {
          const nextError = normalizeError(error);
          if (!shouldSurfaceRenderError(streamingRef.current)) {
            renderer.restoreLastGood();
            if (!destroyedRef.current && pendingCodeRef.current === nextCode) notifyStreamingRendererError(callbacksRef.current, nextCode, nextError, "render");
            return;
          }
          if (rendererRef.current === renderer) disposeRenderer(true);
          if (!destroyedRef.current && pendingCodeRef.current === nextCode) callbacksRef.current.onError?.(nextError, "render");
        }
        if (pendingCodeRef.current === nextCode) return;
      }
    })().finally(() => {
      renderLoopRef.current = null;
      if (!destroyedRef.current && activeRef.current && requestedCodeRef.current !== pendingCodeRef.current) requestRender();
    });
  };
  const requestRenderEvent = useEffectEvent(requestRender);

  useEffect(() => {
    if (importMapEntriesPending || active || typeof window.requestIdleCallback !== "function") return;
    let cancelled = false;
    const codeToPrime = code;
    const idleId = window.requestIdleCallback(
      () => {
        if (cancelled || destroyedRef.current || activeRef.current || !codeToPrime.trim()) return;
        // The hidden TSX pane stays mounted, so idle time on the other tab is the cheapest moment to pay
        // module init + compile + first mount cost and avoid a blank frame on the first reveal.
        void preloadRendererRuntime()
          .then(async () => {
            if (cancelled || destroyedRef.current || activeRef.current || pendingCodeRef.current !== codeToPrime) return;
            await primeScopedStyles(codeToPrime);
            if (cancelled || destroyedRef.current || activeRef.current || pendingCodeRef.current !== codeToPrime) return;
            const needsFreshRenderer = Boolean(rendererRef.current && shouldRecreateRendererForSpecifiers(rendererImportSpecifiersRef.current, codeToPrime, preserveStateOnUpdateRef.current));
            if (needsFreshRenderer) disposeRenderer(false);
            let renderer: GenerativeUIRendererType | null;
            try {
              renderer = await ensureRenderer(codeToPrime);
            } catch {
              if (rendererRef.current) {
                disposeRenderer(true);
                requestedCodeRef.current = null;
              }
              return;
            }
            if (!renderer || cancelled || destroyedRef.current || activeRef.current || pendingCodeRef.current !== codeToPrime) return;
            if (shouldRetryAfterStaleRenderer(rendererRef.current, renderer)) return;
            try {
              renderCode(renderer, codeToPrime);
              if (cancelled || destroyedRef.current || activeRef.current || pendingCodeRef.current !== codeToPrime) return;
              requestedCodeRef.current = codeToPrime;
            } catch {
              // Keep idle prime failures silent, but never retain an aborted renderer for the next foreground edit.
              if (rendererRef.current === renderer) {
                disposeRenderer(true);
                requestedCodeRef.current = null;
              }
            }
          })
          .catch(() => {
            // Only foreground renders should surface runtime bootstrap failures.
          });
      },
      { timeout: 320 },
    );
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
    };
  }, [active, importMapEntriesPending, mergedImportMapEntries, code]);

  useEffect(() => {
    destroyedRef.current = false;
    return () => {
      destroyedRef.current = true;
      renderLoopRef.current = null;
      disposeRenderer(true);
      clearCrossfadeSnapshot();
    };
  }, []);

  useLayoutEffect(() => {
    latestCodeRef.current = code;
    pendingCodeRef.current = code;
    if (shouldRequestRenderForImportMapEntries(mergedImportMapEntries, active)) requestRenderEvent();
  }, [active, importMapEntriesPending, mergedImportMapEntries, code]);

  return (
    <div className={className}>
      <div ref={hostShellRef} className="grid h-full w-full">
        <div ref={visibleHostRef} data-genui-render-host className="col-start-1 row-start-1 h-full w-full transition-opacity" style={{ transitionDuration: `${GENUI_RENDERER_CROSSFADE_MS}ms` }} />
      </div>
    </div>
  );
}
