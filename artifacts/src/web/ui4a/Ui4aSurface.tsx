import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { GenUIRenderer } from "partial-react";
import { createTsxCompiler } from "partial-react/compiler";
import { CodeBlock } from "../components/code/CodeBlock";
import { Collapsible } from "../components/code/Collapsible";
import { SurfaceDelivery, type SurfaceFrame } from "./delivery";
import { createSurfaceImports } from "./imports";
import { createSurfaceModules } from "./modules";
import { prepareSourceHandoff } from "./source-handoff";
import { createSurfaceStyles, UI4A_CLASS } from "./styles";

let warmup: Promise<void> | null = null;
export const warmUi4aRuntime = () => (warmup ??= createTsxCompiler().compile("export default function App(){return null}").then(() => undefined).catch(() => { warmup = null; }));

function hasVisibleContent(target: HTMLElement) {
  const visible = (element: Element) => {
    const visibility = getComputedStyle(element).visibility;
    if (visibility === "hidden" || visibility === "collapse") return false;
    // The host's temporary opacity hides measurement; opacity on generated ancestors is intentional.
    for (let ancestor: Element | null = element; ancestor && ancestor !== target; ancestor = ancestor.parentElement) if (getComputedStyle(ancestor).opacity === "0") return false;
    return true;
  };
  const text = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), range = document.createRange();
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    if (!node.textContent?.trim() || !node.parentElement || !visible(node.parentElement)) continue;
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
  }
  for (const element of target.querySelectorAll("*")) {
    if (!element.localName.includes("-") && !["svg", "canvas", "img", "video", "iframe", "picture", "input", "textarea", "select", "button", "progress", "meter"].includes(element.localName)) continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && visible(element)) return true;
  }
  return false;
}

export type Ui4aSurfaceProps = {
  source: string;
  streaming: boolean;
  scope: string;
  sessionId: string;
  filename?: string;
  revision?: string | number;
  sourceLayout?: "bounded" | "full";
  onSend?: (text: string) => void;
  onError?: (message: string) => void;
  onFirstPaint?: () => void;
  onRenderComplete?: () => void;
};

export function Ui4aSurface({ source, streaming, scope, sessionId, filename, revision, sourceLayout = "bounded", onSend, onError, onFirstPaint, onRenderComplete }: Ui4aSurfaceProps) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const handoff = useRef<ReturnType<typeof prepareSourceHandoff>>(undefined);
  const delivery = useRef<SurfaceDelivery | null>(null);
  const styles = useRef<ReturnType<typeof createSurfaceStyles> | null>(null);
  const latest = useRef<SurfaceFrame>({ source, streaming, filename, revision });
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
  const [renderedFinal, setRenderedFinal] = useState(false);
  const firstPaint = useEffectEvent(() => onFirstPaint?.());
  const renderComplete = useEffectEvent(() => onRenderComplete?.());
  useLayoutEffect(() => { if (painted) { if (host.current) handoff.current?.reveal(host.current); firstPaint(); } }, [painted]);
  useLayoutEffect(() => () => { handoff.current?.cancel(); handoff.current = undefined; }, [sessionId, scope, filename, sourceLayout]);
  useLayoutEffect(() => { if (painted && renderedFinal || error) renderComplete(); }, [painted, renderedFinal, error]);
  const send = useEffectEvent((text: string) => { if (!onSend) throw new Error("This preview cannot send messages"); onSend(text); });
  const report = useEffectEvent((problem: unknown) => {
    if (latest.current.streaming) return;
    const message = problem instanceof Error ? problem.message : String(problem);
    setError(message);
    onError?.(message);
  });

  useLayoutEffect(() => {
    latest.current = { source, streaming, filename, revision };
    setError(null);
    setRenderedFinal(false);
    if (!source.trim()) { handoff.current?.cancel(); handoff.current = undefined; setPainted(false); }
    delivery.current?.update(latest.current);
    void styles.current?.update(source, streaming);
  }, [source, streaming, filename, revision]);

  useEffect(() => {
    const target = host.current;
    if (!target || painted) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      // A successful compile can still return an empty function while its JSX is arriving.
      if (hasVisibleContent(target)) {
        observer.disconnect(); resize.disconnect();
        if (sourceLayout === "bounded" && !error && root.current) handoff.current = prepareSourceHandoff(root.current);
        setPainted(true);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const observer = new MutationObserver(schedule), resize = new ResizeObserver(schedule);
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
    resize.observe(target);
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); };
  }, [painted, sessionId, scope, filename, sourceLayout, error]);

  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let disposed = false;
    setPainted(false);
    let renderer: GenUIRenderer | null = null;
    let surfaceDelivery: SurfaceDelivery | null = null;
    let compilingSource: string | undefined, readySource: string | undefined;
    const compiler = createTsxCompiler();
    const modules = createSurfaceModules(sessionId, scope, (text) => send(text));
    const imports = createSurfaceImports(modules.imports, modules.readFile);
    const surfaceStyles = createSurfaceStyles(target);
    styles.current = surfaceStyles;
    void surfaceStyles.update(latest.current.source, latest.current.streaming);
    void GenUIRenderer.create(target, {
      filename, importmap: { imports: modules.imports }, preserveStateOnUpdate: true, flushMode: "immediate",
      compiler: { compile: (code, options) => { compilingSource = code; surfaceDelivery?.compiling(code); return compiler.compile(code, options); } },
      callbacks: {
        onReady: (_component, _url, code) => { readySource = code; if (code !== undefined) surfaceDelivery?.ready(code); },
        onError: (error, phase) => { if (!disposed) { surfaceDelivery?.failed(phase === "render" ? readySource : compilingSource, phase); report(error); } },
        onRendered: (_component, _code, serial) => {
          if (disposed || !surfaceDelivery?.rendered(serial)) return;
          const frame = latest.current;
          void surfaceStyles.update(frame.source, false);
          void surfaceStyles.whenSettled().then(() => { if (!disposed && latest.current === frame) setRenderedFinal(true); });
        },
      },
    }).then((created) => {
      if (disposed) { created.detach(); return; }
      renderer = created;
      surfaceDelivery = new SurfaceDelivery(created, imports.resolve, (error) => report(error));
      delivery.current = surfaceDelivery;
      delivery.current.update(latest.current);
    }).catch((error) => { if (!disposed) report(error); });
    return () => {
      disposed = true;
      delivery.current = null;
      styles.current = null;
      surfaceStyles.dispose();
      // The nested React root must finish its parent's commit before unmounting; then no generated callback can read a released bridge.
      queueMicrotask(() => { renderer?.detach(); surfaceDelivery?.dispose(); imports.dispose(); modules.dispose(); });
    };
  }, [sessionId, scope, filename]);

  return <div ref={root} className={UI4A_CLASS} data-ui4a-ready={painted && !streaming && !error ? "true" : "false"} data-ui4a-scope={scope} data-ui4a-streaming={streaming ? "true" : "false"} style={{ containerType: "inline-size", minWidth: 0, position: "relative" }}>
    {/* Keep generated margins/floats inside the measured host; measure without stacking it above the source. */}
    <div ref={host} data-ui4a-render-host="" inert={!painted} style={painted ? { display: "flow-root" } : { display: "flow-root", position: "absolute", insetInline: 0, top: 0, opacity: 0, pointerEvents: "none" }} />
    {/* Keep the compiler's fallback as bounded and tail-following as the lazy-load and source-toggle views. */}
    {!painted && source ? sourceLayout === "bounded" ? <Collapsible streaming={streaming} className="theme-code overflow-clip rounded-xl"><CodeBlock code={source} /></Collapsible> : <CodeBlock code={source} /> : null}
    {error ? <div role="alert" className="mt-2 rounded border border-danger/30 p-3 text-sm text-danger">{error}</div> : null}
  </div>;
}
