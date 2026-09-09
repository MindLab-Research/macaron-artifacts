import { describe, expect, test } from "bun:test";
import { SurfaceDelivery, deliverFrame, type RendererPort, type SurfaceFrame } from "./delivery";
import { createSurfaceImports, type PreparedImports } from "./imports";
import { createModuleRegistry } from "./registry";
import { createScopedState, storageKey } from "./state";
import { createFileClient, relativeUi4aPath } from "./files";
import { getUi4aSkill } from "./manifest";

const frame = (source: string, streaming = true): SurfaceFrame => ({ source, streaming });
function recorder() {
  const calls: [string, unknown][] = [];
  const renderer: RendererPort = {
    pushCode: (source) => { calls.push(["push", source]); }, render: (source) => { calls.push(["render", source]); }, finish: (source) => { calls.push(["finish", source]); },
    clear: (options) => { calls.push(["clear", options]); }, setImportMap: (map) => { calls.push(["map", map]); },
  };
  return { calls, renderer };
}
const prepared = (label = "base"): PreparedImports => ({ importMap: { imports: { label } }, rewrite: (source) => source });
const tick = () => Promise.resolve();

describe("surface delivery", () => {
  test("streams only new characters, restarts rewritten prefixes, and finishes unchanged bytes", () => {
    const { renderer, calls } = recorder();
    deliverFrame(renderer, frame("abc"), null);
    deliverFrame(renderer, frame("abcd"), frame("abc"));
    deliverFrame(renderer, frame("xy"), frame("abcd"));
    deliverFrame(renderer, frame("xy", false), frame("xy"));
    expect(calls).toEqual([["push", "abc"], ["push", "d"], ["clear", { preserveVisualState: true }], ["push", "xy"], ["finish", "xy"]]);
  });

  test("a cold import map applies the newest buffered source even when streaming stops meanwhile", async () => {
    const { renderer, calls } = recorder();
    let resolve!: (value: PreparedImports) => void;
    const delivery = new SurfaceDelivery(renderer, () => new Promise((done) => { resolve = done; }), () => {});
    delivery.update(frame('import { Button } from "$ui4a/ui"; export default function App(){return <Button>A'));
    const source = 'import { Button } from "$ui4a/ui"; export default function App(){return <Button>ABC</Button>}';
    delivery.update(frame(source, false));
    resolve(prepared());
    await tick();
    expect(calls.at(-1)).toEqual(["render", source]);
  });

  test("late obsolete maps and unmounted resolutions cannot roll back the visible frame", async () => {
    const { renderer, calls } = recorder();
    const resolves: ((value: PreparedImports) => void)[] = [];
    const delivery = new SurfaceDelivery(renderer, () => new Promise((done) => { resolves.push(done); }), () => {});
    delivery.update(frame('import "a";'));
    delivery.update(frame('import "b";'));
    resolves[1]!(prepared("b"));
    await tick();
    resolves[0]!(prepared("a"));
    await tick();
    expect(calls.filter(([name]) => name === "map")).toEqual([["map", { imports: { label: "b" } }]]);
    delivery.update(frame('import "c";'));
    delivery.dispose();
    resolves[2]!(prepared("c"));
    await tick();
    expect(calls.at(-1)).toEqual(["push", 'import "b";']);
  });

  test("retains importing and last-good graphs while releasing coalesced and failed revisions", async () => {
    const released: string[] = [];
    const submitted: { source: string; serial: number }[] = [];
    const { renderer } = recorder();
    renderer.render = (source, serial) => { submitted.push({ source, serial: serial! }); };
    const delivery = new SurfaceDelivery(renderer, async ({ source }) => ({ ...prepared(), release: () => { released.push(source); } }), () => {});
    const update = async (source: string) => { delivery.update({ source, streaming: false, revision: source }); await tick(); return submitted.at(-1)!; };
    const first = await update("first");
    delivery.compiling(first.source); delivery.ready(first.source); delivery.rendered(first.serial);
    const second = await update("second");
    delivery.compiling(second.source);
    await update("coalesced");
    const latest = await update("latest");
    expect(released).toEqual(["coalesced"]);
    delivery.ready(second.source); delivery.failed(second.source, "render");
    expect(released).toEqual(["coalesced", "second"]);
    delivery.compiling(latest.source); delivery.ready(latest.source); delivery.rendered(latest.serial);
    expect(released).toEqual(["coalesced", "second", "first"]);
    delivery.rendered(first.serial);
    delivery.dispose();
    expect(released).toEqual(["coalesced", "second", "first", "latest"]);
  });

  test("failed imports leave the committed graph retained and stale leases release immediately", async () => {
    const released: string[] = [];
    const resolves: ((value: PreparedImports) => void)[] = [];
    let renderedSerial = 0;
    const { renderer } = recorder();
    renderer.render = (_source, serial) => { renderedSerial = serial!; };
    const delivery = new SurfaceDelivery(renderer, () => new Promise((done) => { resolves.push(done); }), () => {});
    const lease = (id: string) => ({ ...prepared(), release: () => { released.push(id); } });
    delivery.update({ source: "first", streaming: false, revision: 1 });
    resolves[0]!(lease("first")); await tick();
    delivery.compiling("first"); delivery.ready("first"); delivery.rendered(renderedSerial);
    delivery.update({ source: "obsolete", streaming: false, revision: 2 });
    delivery.update({ source: "latest", streaming: false, revision: 3 });
    resolves[1]!(lease("obsolete")); await tick();
    expect(released).toEqual(["obsolete"]);
    delivery.dispose();
    resolves[2]!(lease("latest")); await tick();
    expect(released).toEqual(["obsolete", "first", "latest"]);
  });

  test("import errors suppressed while streaming are reported on the final frame", async () => {
    const errors: string[] = [];
    const { renderer } = recorder();
    const delivery = new SurfaceDelivery(renderer, () => Promise.reject(new Error("missing file")), (error) => errors.push(error.message));
    delivery.update(frame('import "missing";'));
    await tick();
    expect(errors).toEqual([]);
    delivery.update(frame('import "missing";', false));
    expect(errors).toEqual(["missing file"]);
  });
});

describe("scoped capabilities", () => {
  test("two live module bridges dispatch to their own session and preserve React identity", async () => {
    const sent: string[] = [];
    const sharedReact = { useState() {} };
    const first = createModuleRegistry({ react: sharedReact, "$ui4a/chat": { sendMessage: () => sent.push("first") } });
    const second = createModuleRegistry({ react: sharedReact, "$ui4a/chat": { sendMessage: () => sent.push("second") } });
    try {
      const [a, b, react] = await Promise.all([import(first.imports["$ui4a/chat"]!), import(second.imports["$ui4a/chat"]!), import(first.imports.react!)]);
      a.sendMessage(); b.sendMessage();
      expect(sent).toEqual(["first", "second"]);
      expect(react.useState).toBe(sharedReact.useState);
    } finally { first.dispose(); second.dispose(); }
  });

  test("state persists across remounts and identical keys stay isolated across sessions and surfaces", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = createScopedState("one", "card", storage);
    first.set("count", 0, (previous) => previous + 1);
    first.set("count", 0, (previous) => previous + 1);
    expect(createScopedState("one", "card", storage).get("count", 0)).toBe(2);
    expect(createScopedState("one", "other", storage).get("count", 0)).toBe(0);
    expect(createScopedState("two", "card", storage).get("count", 0)).toBe(0);
    expect(storageKey("a:b", "c", "d")).not.toBe(storageKey("a", "b:c", "d"));
  });

  test("file actions use the right session and reject paths escaping .artifacts", async () => {
    const requests: [string, RequestInit | undefined][] = [];
    const client = createFileClient("session one", (async (url, init) => { requests.push([String(url), init]); return new Response(init ? '{"ok":true}' : "hello"); }) as typeof fetch);
    expect(await client.readFile(".artifacts/data.json")).toBe("hello");
    await client.writeFile(".artifacts/data.json", "updated");
    expect(requests[0]?.[0]).toBe("/api/sessions/session%20one/files?path=.artifacts%2Fdata.json");
    expect(requests[1]?.[1]).toMatchObject({ method: "PUT", body: '{"content":"updated"}' });
    expect(() => relativeUi4aPath("../../secret", ".artifacts/canvases/main.tsx")).toThrow("inside .artifacts");
  });
});

describe("file canvas imports", () => {
  const fallback = { kind: "fallback" as const, resolve: () => ({ imports: {} }) };
  test("resolves nested siblings and rewrites import positions without changing displayed path strings", async () => {
    const files: Record<string, string> = { ".artifacts/canvases/part.tsx": 'import { n } from "./data.ts"; export const Part = () => <div>{n}</div>;', ".artifacts/canvases/data.ts": "export const n = 42;" };
    const compiled: string[] = [];
    const imports = createSurfaceImports({}, async (path) => files[path]!, { fallback, compiler: { compile: async (code) => { compiled.push(code); return { code, source: code, changed: true }; } }, createModuleUrl: () => `blob:module-${compiled.length}`, revokeModuleUrl: () => {} });
    const source = 'import { Part } from "./part.tsx"; const label = "./part.tsx"; export default Part;';
    const result = await imports.resolve({ source, filename: ".artifacts/canvases/main.tsx" });
    expect(compiled[0]).toContain("42");
    expect(compiled[1]).toContain('from "blob:module-1"');
    expect(result.rewrite(source)).toContain('from "blob:module-2"');
    expect(result.rewrite(source)).toContain('label = "./part.tsx"');
    imports.dispose();
  });

  test("a cyclic canvas reports the dependency chain instead of hanging", async () => {
    const imports = createSurfaceImports({}, async () => 'import "./main.tsx";', { fallback });
    await expect(imports.resolve({ source: 'import "./part.tsx";', filename: ".artifacts/canvases/main.tsx" })).rejects.toThrow("Circular UI4A imports");
    imports.dispose();
  });

  test("invented host modules fail locally rather than requesting an npm fallback", async () => {
    let fallbackCalled = false;
    const imports = createSurfaceImports({}, async () => "", { fallback: { kind: "fallback", resolve: () => { fallbackCalled = true; return { imports: {} }; } } });
    await expect(imports.resolve({ source: 'import { streamText } from "$ui4a/ai";' })).rejects.toThrow("unavailable");
    expect(fallbackCalled).toBe(false);
    imports.dispose();
  });
});

test("injected skill is generated from the actual module manifest", async () => {
  const skill = await Bun.file(new URL("../../../skills/ui4a/SKILL.md", import.meta.url)).text();
  expect(skill).toBe(getUi4aSkill());
});
