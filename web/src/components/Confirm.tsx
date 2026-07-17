import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmCtx);
}

type Pending = {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise((resolve) => setPending({ opts, resolve })),
    [],
  );

  // Esc cancels, Enter confirms. Autofocus on the confirm button so the user
  // can also just press Enter to proceed.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        pending.resolve(false);
        setPending(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pending.resolve(true);
        setPending(null);
      }
    };
    window.addEventListener('keydown', onKey);
    // Defer focus until after the dialog has mounted in the DOM.
    queueMicrotask(() => confirmBtnRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  const close = (v: boolean) => {
    if (!pending) return;
    pending.resolve(v);
    setPending(null);
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <div className="confirm-backdrop" onClick={() => close(false)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="confirm-title" className="confirm-title">{pending.opts.title}</div>
            {pending.opts.body && <div className="confirm-body">{pending.opts.body}</div>}
            <div className="confirm-actions">
              <button className="ghost" type="button" onClick={() => close(false)}>
                {pending.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={confirmBtnRef}
                className={pending.opts.destructive ? 'danger' : 'primary'}
                type="button"
                onClick={() => close(true)}
              >
                {pending.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
