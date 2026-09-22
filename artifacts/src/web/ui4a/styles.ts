import { createGenerator } from "@unocss/core";
import { unoConfig } from "../theme/uno";

export const UI4A_CLASS = "ui4a-surface";
let generator: ReturnType<typeof createGenerator> | null = null;
let sheet: HTMLStyleElement | null = null;
let preflights: HTMLStyleElement | null = null;
let properties: HTMLStyleElement | null = null;
let pending = Promise.resolve();
let generation = 0;
const sources = new Map<symbol, Set<string>>();
const emitted = new Set<string>();

/** Keep rules local to generated surfaces; an unscoped utility arriving last can otherwise restyle the chat shell. */
export function createSurfaceStyles(root: HTMLElement) {
  const key = Symbol();
  sources.set(key, new Set());
  let sequence = 0;
  let source = "";
  let streaming = true;
  const update = (code: string, partial: boolean) => {
    source = code;
    streaming = partial;
    const current = ++sequence;
    const epoch = generation;
    const classes = [...root.querySelectorAll("[class]")].map((element) => element.getAttribute("class") ?? "").join(" ");
    pending = pending.then(async () => {
      if (epoch !== generation || current !== sequence || !sources.has(key)) return;
      const uno = await (generator ??= createGenerator(unoConfig(`.${UI4A_CLASS}`)));
      const tokens = await uno.applyExtractors(`${code}\n${classes}`);
      if (epoch !== generation || current !== sequence || !sources.has(key)) return;
      sources.set(key, tokens);
      const fresh = [...tokens].filter((token) => !emitted.has(token));
      if (partial && fresh.length === 0) return;
      if (!properties) { properties = document.createElement("style"); properties.dataset.ui4a = "properties"; document.head.append(properties); }
      if (!preflights) { preflights = document.createElement("style"); preflights.dataset.ui4a = "theme"; document.head.append(preflights); }
      if (!sheet) { sheet = document.createElement("style"); sheet.dataset.ui4a = "utilities"; document.head.append(sheet); }
      if (!partial) {
        emitted.clear();
        for (const values of sources.values()) for (const token of values) emitted.add(token);
      } else {
        for (const token of fresh) emitted.add(token);
      }
      // UnoCSS caches token parsing. Reassemble all active rules so a late base
      // utility cannot override an earlier responsive rule until streaming ends.
      const result = await uno.generate(emitted);
      if (epoch === generation && sheet && preflights && properties) {
        const propertyCss = result.getLayers(["properties"]), themeCss = result.getLayers(["theme"]), utilityCss = result.getLayers(undefined, ["properties", "theme"]);
        // Extracted prose and partial identifiers often add no CSS; avoid restyling the page for them.
        if (properties.textContent !== propertyCss) properties.textContent = propertyCss;
        if (preflights.textContent !== themeCss) preflights.textContent = themeCss;
        if (sheet.textContent !== utilityCss) sheet.textContent = utilityCss;
      }
    }).catch((error) => console.error("[ui4a] style generation failed", error));
    return pending;
  };
  const observer = new MutationObserver(() => { void update(source, streaming); });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  return {
    update,
    async whenSettled() {
      // A final DOM commit may enqueue class extraction after its source update.
      let current: Promise<void>;
      do { current = pending; await current; } while (current !== pending);
    },
    dispose() {
      sequence++;
      observer.disconnect();
      sources.delete(key);
      if (!sources.size) { generation++; sheet?.remove(); sheet = null; preflights?.remove(); preflights = null; properties?.remove(); properties = null; emitted.clear(); }
    },
  };
}
