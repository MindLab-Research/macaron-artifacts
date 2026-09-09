import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { GenUIRenderer } from "partial-react";
import { createTsxCompiler } from "partial-react/compiler";
import { CodeBlock } from "../components/code/CodeBlock";
import { SurfaceDelivery, type SurfaceFrame } from "./delivery";
import { createSurfaceImports } from "./imports";
import { createSurfaceModules } from "./modules";
import { createSurfaceStyles, UI4A_CLASS } from "./styles";

let warmup: Promise<void> | null = null;
export const warmUi4aRuntime = () => (warmup ??= createTsxCompiler().compile("export default function App(){return null}").then(() => undefined).catch(() => { warmup = null; }));

export type Ui4aSurfaceProps = {
  source: string;
  streaming: boolean;
  scope: string;
  sessionId: string;
  filename?: string;
  revision?: string | number;
  onSend?: (text: string) => void;
  onError?: (message: string) => void;
};

export function Ui4aSurface({ source, streaming, scope, sessionId, filename, revision, onSend, onError }: Ui4aSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const delivery = useRef<SurfaceDelivery | null>(null);
  const styles = useRef<ReturnType<typeof createSurfaceStyles> | null>(null);
  const latest = useRef<SurfaceFrame>({ source, streaming, filename, revision });
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);
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
    if (!source.trim()) setPainted(false);
    delivery.current?.update(latest.current);
    void styles.current?.update(source, streaming);
  }, [source, streaming, filename, revision]);

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
        onRendered: (_component, _code, serial) => { if (!disposed) { surfaceDelivery?.rendered(serial); setPainted(true); } },
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

  return <div className={UI4A_CLASS} data-ui4a-scope={scope} data-ui4a-streaming={streaming ? "true" : "false"} style={{ containerType: "inline-size", minWidth: 0 }}>
    <div ref={host} data-ui4a-render-host="" />
    {!painted && source ? <CodeBlock code={source} /> : null}
    {error ? <div role="alert" className="mt-2 rounded border border-danger/30 p-3 text-sm text-danger">{error}</div> : null}
  </div>;
}
