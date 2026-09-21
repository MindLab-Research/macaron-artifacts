import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import * as JsxDevRuntime from "react/jsx-dev-runtime";
import * as Scheduler from "scheduler";
import * as UI from "../components/ui4a-ui";
import * as Charts from "./charts";
import * as Math from "./katex";
import { createModuleRegistry } from "./registry";
import { createScopedState } from "./state";
import { createFileClient } from "./files";
import { ui4aModules } from "./manifest";

let shared: ReturnType<typeof createModuleRegistry> | null = null;
const builtins = { "$ui4a/ui": UI, "$ui4a/ui/charts": Charts, "$ui4a/ui/katex": Math };
const sharedImports = () => (shared ??= createModuleRegistry({ react: React, "react-dom": ReactDom, "react-dom/client": ReactDomClient, "react/jsx-runtime": JsxRuntime, "react/jsx-dev-runtime": JsxDevRuntime, scheduler: Scheduler, ...builtins })).imports;

export function createSurfaceModules(sessionId: string, scope: string, onSend: (text: string) => void) {
  let storage: Storage | undefined;
  try { storage = globalThis.localStorage; } catch { /* private-mode storage can reject even the property access */ }
  const state = createScopedState(sessionId, scope, storage);
  const fs = createFileClient(sessionId);
  const modules = {
    "$ui4a/chat": { sendMessage(text: string) { if (typeof text !== "string" || !text.trim()) throw new Error("sendMessage requires a non-empty string"); onSend(text); } },
    "$ui4a/state": { usePersistedState: state.usePersistedState },
    "$ui4a/fs": fs,
  };
  const actual = { ...builtins, ...modules };
  for (const [name, members] of Object.entries(ui4aModules)) for (const member of Object.keys(members)) if (!(member in actual[name as keyof typeof actual])) throw new Error(`UI4A runtime is missing ${name}.${member}`);
  const registry = createModuleRegistry(modules);
  return { imports: { ...sharedImports(), ...registry.imports }, readFile: fs.readFile, dispose: registry.dispose };
}

if (import.meta.hot) import.meta.hot.dispose(() => { shared?.dispose(); shared = null; });
