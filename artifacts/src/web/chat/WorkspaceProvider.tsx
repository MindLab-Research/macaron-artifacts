import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { WorkspaceStore } from './store';

const WorkspaceContext = createContext<WorkspaceStore | null>(null);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkspaceStore());
  useEffect(() => { void store.initialize(); }, [store]);
  return <WorkspaceContext value={store}>{children}</WorkspaceContext>;
}
export function useWorkspace() {
  const actions = use(WorkspaceContext);
  if (!actions) throw new Error('WorkspaceProvider is missing');
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot);
  return { state, actions };
}
