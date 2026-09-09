import { expect, test } from "bun:test";
import { createSurfaceImports } from "./imports";
import { SurfaceDelivery, type RendererPort } from "./delivery";

const filename = ".artifacts/canvases/main.tsx";
const source = 'import Counter from "./counter.tsx"; export default Counter;';
const tick = () => Promise.resolve();
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
function fixture(initial: Record<string, string>) {
  const files = { ...initial }, compiled: string[] = [], created: string[] = [], revoked: string[] = [];
  const imports = createSurfaceImports({}, async (path) => {
    if (!(path in files)) throw Object.assign(new Error("missing file"), { status: 404 });
    return files[path]!;
  }, {
    fallback: { kind: "fallback", resolve: () => ({ imports: {} }) },
    compiler: { compile: async (code) => { if (code.includes("SYNTAX_ERROR")) throw new Error("invalid module"); compiled.push(code); return { code, source: code, changed: true }; } },
    createModuleUrl: () => { const url = `blob:module-${created.length}`; created.push(url); return url; }, revokeModuleUrl: (url) => { revoked.push(url); },
  });
  return { files, compiled, created, revoked, imports };
}

test("100 unchanged revisions retain the same imported component identity without new Blob URLs", async () => {
  const { imports, compiled, created, revoked } = fixture({ ".artifacts/canvases/counter.tsx": "export default function Counter() {}" });
  let current = await imports.resolve({ source, filename, revision: 0 });
  const rewritten = current.rewrite(source);
  for (let revision = 1; revision <= 100; revision++) {
    const next = await imports.resolve({ source, filename, revision });
    expect(next.rewrite(source)).toBe(rewritten);
    current.release!(); current = next;
  }
  expect(compiled).toHaveLength(1);
  expect(created).toHaveLength(1);
  expect(revoked).toHaveLength(0);
  current.release!(); current.release!(); imports.dispose();
  expect(revoked).toEqual(created);
});

test("100 failed renders retain only the last-good and latest graphs", async () => {
  const { imports, files, created, revoked } = fixture({ ".artifacts/canvases/counter.tsx": "export default 0;" });
  let submitted = deferred<{ source: string; serial: number }>();
  const renderer: RendererPort = { pushCode() {}, finish() {}, clear() {}, setImportMap() {}, render(source, serial) { submitted.resolve({ source, serial: serial! }); } };
  const delivery = new SurfaceDelivery(renderer, imports.resolve, () => {});
  const update = async (revision: number) => {
    submitted = deferred();
    delivery.update({ source, filename, revision, streaming: false });
    const rendered = await submitted.promise;
    delivery.compiling(rendered.source); delivery.ready(rendered.source);
    return rendered;
  };
  const first = await update(0);
  delivery.rendered(first.serial);
  for (let revision = 1; revision <= 100; revision++) {
    files[".artifacts/canvases/counter.tsx"] = `export default ${revision};`;
    const failed = await update(revision);
    delivery.failed(failed.source, "render");
    expect(created.length - revoked.length).toBe(2);
    expect(revoked).not.toContain(created[0]!);
  }
  delivery.dispose(); imports.dispose();
  expect(new Set(revoked)).toEqual(new Set(created));
});

test("a changed leaf replaces its ancestors, while shared and unrelated modules keep their URLs", async () => {
  const { imports, files, compiled, created, revoked } = fixture({
    ".artifacts/canvases/counter.tsx": 'import { count } from "./data.ts"; import "./shared.ts"; export default count;',
    ".artifacts/canvases/data.ts": "export const count = 1;",
    ".artifacts/canvases/shared.ts": "export const shared = 1;",
    ".artifacts/canvases/other.ts": 'import "./shared.ts";',
  });
  const entry = source + 'import "./other.ts";';
  const first = await imports.resolve({ source: entry, filename });
  files[".artifacts/canvases/data.ts"] = "export const count = 2;";
  const second = await imports.resolve({ source: entry, filename });
  expect(compiled).toHaveLength(6); // Four initial modules, then only the leaf and its parent.
  expect(second.rewrite(entry)).not.toBe(first.rewrite(entry));
  expect(revoked).toHaveLength(0); // The old graph may still be visible or importing.
  first.release!();
  expect(revoked).toEqual([created[0]!, created[2]!]);
  second.release!(); imports.dispose();
  expect(new Set(revoked)).toEqual(new Set(created));
});

test("failed graph builds release new modules and preserve a retained last-good graph", async () => {
  const { imports, files, created, revoked } = fixture({ ".artifacts/canvases/counter.tsx": 'import "./data.ts"; export default 1;', ".artifacts/canvases/data.ts": "export default 1;" });
  const first = await imports.resolve({ source, filename });
  files[".artifacts/canvases/data.ts"] = "export default 2;";
  files[".artifacts/canvases/counter.tsx"] += "SYNTAX_ERROR";
  await expect(imports.resolve({ source, filename })).rejects.toThrow("invalid module");
  expect(revoked).toEqual([created[2]!]);
  files[".artifacts/canvases/data.ts"] = "export default 1;";
  files[".artifacts/canvases/counter.tsx"] = 'import "./data.ts"; export default 1;';
  const recovered = await imports.resolve({ source, filename });
  expect(recovered.rewrite(source)).toBe(first.rewrite(source));
  recovered.release!(); first.release!(); imports.dispose();
  expect(new Set(revoked)).toEqual(new Set(created));
});

test("concurrent identical graphs share compilation and keep shared URLs until both leases release", async () => {
  const { imports, created, revoked } = fixture({ ".artifacts/canvases/counter.tsx": "export default 1;" });
  const [first, second] = await Promise.all([imports.resolve({ source, filename }), imports.resolve({ source, filename })]);
  expect(created).toHaveLength(1);
  expect(first.rewrite(source)).toBe(second.rewrite(source));
  first.release!(); expect(revoked).toHaveLength(0);
  second.release!(); expect(revoked).toEqual(created);
  imports.dispose();
});

test("late stale reads cannot replace a newer cached graph", async () => {
  const old = deferred<string>();
  let reads = 0, urls = 0;
  const revoked: string[] = [];
  const imports = createSurfaceImports({}, () => ++reads === 1 ? old.promise : Promise.resolve("export default 2;"), {
    fallback: { kind: "fallback", resolve: () => ({ imports: {} }) },
    compiler: { compile: async (code) => ({ code, source: code, changed: true }) }, createModuleUrl: () => `blob:${urls++}`, revokeModuleUrl: (url) => { revoked.push(url); },
  });
  const abort = new AbortController();
  const stale = imports.resolve({ source, filename, signal: abort.signal });
  abort.abort();
  const latest = await imports.resolve({ source, filename });
  old.resolve("export default 1;");
  await expect(stale).rejects.toThrow();
  const repeat = await imports.resolve({ source, filename });
  expect(repeat.rewrite(source)).toBe(latest.rewrite(source));
  expect(urls).toBe(1);
  expect(revoked).toHaveLength(0);
  repeat.release!(); latest.release!(); imports.dispose();
});

test("disposal during compilation cannot create a live URL afterward", async () => {
  const compile = deferred<{ code: string; source: string; changed: boolean }>();
  let started = false, created = false;
  const imports = createSurfaceImports({}, async () => "export default 1;", {
    fallback: { kind: "fallback", resolve: () => ({ imports: {} }) },
    compiler: { compile: () => { started = true; return compile.promise; } }, createModuleUrl: () => { created = true; return "blob:late"; },
  });
  const pending = imports.resolve({ source, filename });
  while (!started) await tick();
  imports.dispose();
  compile.resolve({ code: "export default 1;", source: "export default 1;", changed: true });
  await expect(pending).rejects.toThrow("closed");
  expect(created).toBe(false);
});
