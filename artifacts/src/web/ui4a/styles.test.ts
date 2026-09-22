import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSurfaceStyles } from "./styles";

// Keep the DOM port small; CSS extraction, generation, caching and ordering use real UnoCSS.
class StyleElement {
  dataset: Record<string, string> = {};
  writes = 0;
  private text = "";
  get textContent() { return this.text; }
  set textContent(value: string) { this.text = value; this.writes++; }
  remove() { sheets.delete(this); }
}
const sheets = new Set<StyleElement>();
const surfaces: ReturnType<typeof createSurfaceStyles>[] = [];
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), originalObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
beforeEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new StyleElement(), head: { append: (style: StyleElement) => sheets.add(style) } } });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose();
  expect(sheets.size).toBe(0);
  for (const [key, descriptor] of [["document", originalDocument], ["MutationObserver", originalObserver]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
function surface() {
  const styles = createSurfaceStyles({ querySelectorAll: () => [] } as unknown as HTMLElement);
  surfaces.push(styles);
  return styles;
}
const sheet = (layer = "utilities") => [...sheets].find(style => style.dataset.ui4a === layer)!;
const css = () => sheet().textContent;

for (const [responsive, base, boundary, selector] of [["sm:p-2", "p-4", "@media", ".p-4"], ["@md:grid-cols-2", "grid-cols-1", "@container", ".grid-cols-1"]]) {
  test(`late ${base} preserves ${responsive} precedence before settlement`, async () => {
    const styles = surface();
    await styles.update(`<div className="${responsive}`, true);
    const source = `<div className="${responsive} ${base}">Hello</div>`;
    await styles.update(source, true);
    const streamed = css();
    expect(streamed.indexOf(selector)).toBeGreaterThanOrEqual(0);
    expect(streamed.indexOf(boundary)).toBeGreaterThan(streamed.indexOf(selector));
    await styles.update(source, false);
    expect(css()).toBe(streamed);
  });
}

test("another streaming surface cannot reverse responsive precedence and settlement prunes disposed sources", async () => {
  const first = surface(), second = surface();
  await first.update("sm:p-2", true);
  await second.update("p-4", true);
  expect(css().indexOf("@media")).toBeGreaterThan(css().indexOf(".p-4"));
  const streamed = css();
  await second.update("p-4", false);
  expect(css()).toBe(streamed);
  first.dispose();
  await second.update("p-4", false);
  expect(css()).not.toContain("@media");
  expect(css()).toContain(".p-4");
});

test("streaming keeps earlier utilities and their property dependencies without rewriting unchanged CSS", async () => {
  const styles = surface();
  await styles.update("p-2 ring-2 bg-rose-700", true);
  await styles.update("text-7xl", true);
  expect(css()).toContain(".p-2");
  expect(css()).toContain(".ring-2");
  expect(sheet("properties").textContent).toContain("--un-ring-offset-width");
  expect(sheet("theme").textContent).toContain("--colors-rose-700:");
  expect(sheet("theme").textContent).toContain("--text-7xl-fontSize:");
  const writes = [...sheets].map(style => style.writes);
  await styles.update("text-7xl unrelatedProse", true);
  expect([...sheets].map(style => style.writes)).toEqual(writes);
  await styles.update("text-7xl", false);
  expect(css()).not.toContain(".p-2");
  expect(css()).not.toContain(".ring-2");
});

test("disposing the last surface while an update is queued does not recreate its styles", async () => {
  const styles = surface();
  const pending = styles.update("p-4", true);
  styles.dispose();
  await pending;
  expect(sheets.size).toBe(0);
});

test("settlement includes a newer class extraction queued while waiting", async () => {
  const styles = surface();
  await styles.update("p-4", true);
  void styles.update("p-6", true);
  const settled = styles.whenSettled();
  void styles.update("h-[137px]", false);
  await settled;
  expect(css()).toContain("height:137px");
  expect(css()).not.toContain(".p-4");
});
