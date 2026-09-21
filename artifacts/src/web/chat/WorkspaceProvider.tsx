import { createContext, use, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WorkspaceStore } from './store';

const WorkspaceContext = createContext<WorkspaceStore | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkspaceStore());
  const mount = useRef(0);
  useEffect(() => {
    const current = ++mount.current; void store.initialize();
    // StrictMode immediately replays effects on the same store; only a real unmount detaches it.
    return () => { queueMicrotask(() => { if (mount.current === current) store.dispose(); }); };
  }, [store]);
  return <WorkspaceContext value={store}>{children}</WorkspaceContext>;
}
export function useWorkspace() {
  const actions = use(WorkspaceContext);
  if (!actions) throw new Error('WorkspaceProvider is missing');
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  return { state, actions };
}
