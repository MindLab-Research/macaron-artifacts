import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type Cell = { value: unknown; listeners: Set<() => void> };
const fallbackValue = <T,>(initial: T | (() => T)): T => typeof initial === "function" ? (initial as () => T)() : initial;
export const storageKey = (sessionId: string, scope: string, key: string) => `macaron-artifacts:ui4a:v1:${JSON.stringify([sessionId, scope, key])}`;

export function createScopedState(sessionId: string, scope: string, storage?: StorageLike) {
  const cells = new Map<string, Cell>();
  const cellFor = <T,>(key: string, initial: T | (() => T)): Cell => {
    const found = cells.get(key);
    if (found) return found;
    let value: T;
    try { const raw = storage?.getItem(storageKey(sessionId, scope, key)); value = raw == null ? fallbackValue(initial) : JSON.parse(raw) as T; }
    catch { value = fallbackValue(initial); }
    const cell = { value, listeners: new Set<() => void>() };
    cells.set(key, cell);
    return cell;
  };
  const set = <T,>(key: string, initial: T | (() => T), update: SetStateAction<T>) => {
    const cell = cellFor(key, initial);
    const value = typeof update === "function" ? (update as (previous: T) => T)(cell.value as T) : update;
    if (Object.is(value, cell.value)) return;
    cell.value = value;
    // A blocked/full storage must not break an otherwise usable control; this mount still retains the value in memory.
    try { storage?.setItem(storageKey(sessionId, scope, key), JSON.stringify(value)); } catch { /* in-memory state remains authoritative */ }
    for (const listener of cell.listeners) listener();
  };
  return {
    get: <T,>(key: string, initial: T | (() => T)) => cellFor(key, initial).value as T,
    set,
    usePersistedState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const cell = cellFor(key, initial);
      const value = useSyncExternalStore((listener) => { cell.listeners.add(listener); return () => { cell.listeners.delete(listener); }; }, () => cell.value, () => cell.value) as T;
      return [value, (update) => set(key, initial, update)];
    },
  };
}
