import type { RendererImportMap } from "partial-react/import-map";
import { importSignature, type ImportRequest, type PreparedImports } from "./imports";

export type SurfaceFrame = ImportRequest & { streaming: boolean };
export type RendererPort = { pushCode: (delta: string, serial?: number) => void; render: (source: string, serial?: number) => void; finish: (source: string, serial?: number) => void; clear: (options?: { preserveVisualState: boolean }) => void; setImportMap: (map: RendererImportMap) => unknown };

export function deliverFrame(renderer: RendererPort, frame: SurfaceFrame, previous: { source: string; streaming: boolean } | null, force = false, serial?: number): boolean {
  if (!frame.streaming) {
    // Always finish a streaming buffer, even when its bytes did not change: final syntax errors and render context must settle.
    if (previous?.streaming) renderer.finish(frame.source, serial);
    else if (force || frame.source !== previous?.source) renderer.render(frame.source, serial);
    else return false;
    return true;
  }
  if (!force && previous && frame.source.startsWith(previous.source)) {
    const delta = frame.source.slice(previous.source.length);
    if (!delta) return false;
    renderer.pushCode(delta, serial);
  } else {
    if (previous) renderer.clear({ preserveVisualState: true });
    renderer.pushCode(frame.source, serial);
  }
  return true;
}

/** Import resolution can finish after many more chunks; only the latest map may deliver, and it must deliver the latest buffer. */
export class SurfaceDelivery {
  private latest: SurfaceFrame | null = null;
  private delivered: SurfaceFrame | null = null;
  private prepared: PreparedImports | null = null;
  private signature: string | null = null;
  private epoch = 0;
  private disposed = false;
  private resolutionError: Error | null = null;
  private abort?: AbortController;
  private serial = 0;
  private committedSerial = 0;
  private committed: PreparedImports | null = null;
  private leases = new Set<PreparedImports>();
  private submissions = new Map<number, { imports: PreparedImports; source: string; stage: "pending" | "compiling" | "ready" }>();

  constructor(private renderer: RendererPort, private resolve: (request: ImportRequest) => Promise<PreparedImports>, private onError: (error: Error) => void) {}

  update(frame: SurfaceFrame) {
    if (this.disposed) return;
    this.latest = frame;
    if (!frame.source.trim()) {
      this.epoch++;
      this.abort?.abort();
      this.signature = null;
      this.prepared = null;
      this.delivered = null;
      this.renderer.clear();
      return;
    }
    const signature = importSignature(frame);
    if (signature === this.signature) {
      if (this.prepared) this.deliver();
      else if (!frame.streaming && this.resolutionError) this.onError(this.resolutionError);
      return;
    }
    this.signature = signature;
    this.prepared = null;
    this.resolutionError = null;
    this.abort?.abort();
    this.abort = new AbortController();
    const epoch = ++this.epoch;
    void this.resolve({ ...frame, signal: this.abort.signal }).then((prepared) => {
      if (this.disposed || epoch !== this.epoch) { prepared.release?.(); return; }
      this.leases.add(prepared);
      this.prepared = prepared;
      this.renderer.setImportMap(prepared.importMap);
      this.deliver(true);
    }, (error: unknown) => {
      if (this.disposed || epoch !== this.epoch) return;
      this.resolutionError = error instanceof Error ? error : new Error(String(error));
      if (!this.latest?.streaming) this.onError(this.resolutionError);
    });
  }

  private deliver(force = false) {
    if (!this.latest || !this.prepared) return;
    const frame = { ...this.latest, source: this.prepared.rewrite(this.latest.source) };
    const serial = ++this.serial;
    this.submissions.set(serial, { imports: this.prepared, source: frame.source, stage: "pending" });
    if (deliverFrame(this.renderer, frame, this.delivered, force, serial)) {
      this.delivered = frame;
      // The renderer compiles single-flight and coalesces queued frames. Only the latest unstarted frame can run.
      for (const [id, submission] of this.submissions) if (id < serial && submission.stage === "pending") this.submissions.delete(id);
    } else this.submissions.delete(serial);
    this.collect();
  }

  compiling(source: string) {
    for (const [id, submission] of this.submissions) {
      if (submission.stage === "compiling") this.submissions.delete(id);
      else if (submission.stage === "pending" && submission.source === source) submission.stage = "compiling";
    }
    this.collect();
  }

  ready(source: string) { for (const submission of this.submissions.values()) if (submission.stage === "compiling" && submission.source === source) submission.stage = "ready"; }

  rendered(serial?: number) {
    if (serial === undefined || serial <= this.committedSerial) return; // A last-good rollback has no request serial.
    const submission = this.submissions.get(serial);
    if (!submission) return;
    this.committed = submission.imports;
    this.committedSerial = serial;
    for (const id of this.submissions.keys()) if (id <= serial) this.submissions.delete(id);
    this.collect();
  }

  failed(source: string | undefined, phase: "transform" | "compile" | "render") {
    const stage = phase === "render" ? "ready" : "compiling";
    const failed = [...this.submissions].findLast(([, submission]) => submission.stage === stage && submission.source === source);
    if (failed) for (const id of this.submissions.keys()) if (id <= failed[0]) this.submissions.delete(id);
    this.collect();
  }

  private collect() {
    const live = new Set([this.prepared, this.committed, ...[...this.submissions.values()].map((submission) => submission.imports)]);
    for (const imports of this.leases) if (!live.has(imports)) { imports.release?.(); this.leases.delete(imports); }
  }

  /** Detach the renderer first: its last-good component can still call a lazy relative import until unmounted. */
  dispose() { this.disposed = true; this.epoch++; this.abort?.abort(); for (const imports of this.leases) imports.release?.(); this.leases.clear(); this.submissions.clear(); }
}
