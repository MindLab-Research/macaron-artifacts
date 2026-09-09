type Namespace = Record<string, unknown>;
const REGISTRY = "macaron-artifacts.ui4a.modules";
const globalRegistry = globalThis as typeof globalThis & { [key: symbol]: Map<string, Namespace> | undefined };
const namespaces = (globalRegistry[Symbol.for(REGISTRY)] ??= new Map<string, Namespace>());
const identifier = /^[A-Za-z_$][\w$]*$/;

export function moduleSource(id: string, namespace: Namespace): string {
  const exports = Object.keys(namespace).filter((name) => name !== "default" && identifier.test(name));
  return [`const ns = globalThis[Symbol.for(${JSON.stringify(REGISTRY)})].get(${JSON.stringify(id)});`, ...exports.map((name) => `export const ${name} = ns[${JSON.stringify(name)}];`), "export default ns.default ?? ns;"].join("\n");
}

/** A surface owns its capability URLs; sharing only the React namespaces keeps hooks on the host's runtime. */
export function createModuleRegistry(modules: Record<string, Namespace>) {
  const ids: string[] = [];
  const imports: Record<string, string> = {};
  for (const [specifier, namespace] of Object.entries(modules)) {
    const id = crypto.randomUUID();
    namespaces.set(id, namespace);
    ids.push(id);
    imports[specifier] = URL.createObjectURL(new Blob([moduleSource(id, namespace)], { type: "text/javascript" }));
  }
  return { imports, dispose() { for (const id of ids) namespaces.delete(id); for (const url of Object.values(imports)) URL.revokeObjectURL(url); } };
}
