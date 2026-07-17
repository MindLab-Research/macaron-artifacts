import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ToastFn = (msg: string) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastCtx);
}

let externalShow: ToastFn = () => {};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback((m: string) => {
    setMsg(m);
    setShow(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShow(false), 1800);
  }, []);

  useEffect(() => {
    externalShow = toast;
    return () => {
      externalShow = () => {};
    };
  }, [toast]);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div id="toast" className={'toast' + (show ? ' show' : '')}>{msg}</div>
    </ToastCtx.Provider>
  );
}

// Renderless placeholder so App.tsx can keep its symmetry.
export function Toast() { return null; }

export const toast: ToastFn = (m) => externalShow(m);
