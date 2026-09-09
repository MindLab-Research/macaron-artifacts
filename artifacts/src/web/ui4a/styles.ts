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
        const result = await uno.generate(emitted);
        if (epoch === generation && sheet && preflights && properties) {
          properties.textContent = result.getLayers(["properties"]);
          preflights.textContent = result.getLayers(["theme"]);
          sheet.textContent = result.getLayers(undefined, ["properties", "theme"]);
        }
      } else {
        for (const token of fresh) emitted.add(token);
        // Theme dependencies accumulate in Wind4, but @property registrations only
        // describe this batch. Keep previous registrations alive until settlement.
        const result = await uno.generate(fresh);
        if (epoch === generation && sheet && preflights && properties) {
          properties.textContent += result.getLayers(["properties"]);
          preflights.textContent = result.getLayers(["theme"]);
          sheet.textContent += result.getLayers(undefined, ["properties", "theme"]);
        }
      }
    }).catch((error) => console.error("[ui4a] style generation failed", error));
    return pending;
  };
  const observer = new MutationObserver(() => { void update(source, streaming); });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  return {
    update,
    dispose() {
      sequence++;
      observer.disconnect();
      sources.delete(key);
      if (!sources.size) { generation++; sheet?.remove(); sheet = null; preflights?.remove(); preflights = null; properties?.remove(); properties = null; emitted.clear(); }
    },
  };
}
