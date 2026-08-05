// Clickability harness for model-generated GenUI widgets.
//
// jsdom can prove the hook's logic; it cannot prove that TSX the model just
// wrote actually COMPILES and MOUNTS through our import map, or that a real
// mouse click on a $macaron/ui <Button> reaches sendUserMessage. This page runs
// the production renderer (GenuiPreview → StaticGenUIRenderer) and the
// production host bridge (createScheduleBridge), then reports what happened on
// window.__harness so Playwright can assert on it.
//
// Driven by scripts/smoke/clickable.mjs; not linked from the app.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GenuiPreview } from './genui-runtime';
import { createScheduleBridge, cancelAutoSend } from './lib/autoSend';

type Harness = {
  /** Prompts that reached the host through the widget's sendUserMessage. */
  sent: string[];
  errors: string[];
  /** Unmount the current widget. The driver waits for the button to detach before
   *  setting the next one — otherwise waitForSelector matches the PREVIOUS
   *  widget's button, and every file in a batch silently tests the first one. */
  reset: () => void;
  setCode: (code: string) => void;
};

const g = globalThis as unknown as { __harness?: Harness };

function App() {
  const [code, setCode] = useState('');

  useEffect(() => {
    const harness: Harness = {
      sent: [],
      errors: [],
      reset: () => {
        harness.sent.length = 0;
        harness.errors.length = 0;
        cancelAutoSend();
        setCode('');
      },
      setCode: (next) => setCode(next),
    };
    g.__harness = harness;

    // The same two globals Session.tsx installs: the widget's sendUserMessage
    // and the host-owned countdown. isLive/isBusy are the real predicates'
    // shape, pinned to a live, idle turn.
    const send = (prompt: string) => {
      harness.sent.push(prompt);
    };
    (globalThis as Record<string, unknown>)['$app/chat'] = send;
    (globalThis as Record<string, unknown>)['$app/chat/schedule'] = createScheduleBridge({
      send,
      isBusy: () => false,
      isLive: () => true,
    });
    window.addEventListener('error', (e) => harness.errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => harness.errors.push(String(e.reason)));
    return () => cancelAutoSend();
  }, []);

  // GenuiPreview owns its own status UI and exposes no onRendered, so the
  // driver waits on the mounted DOM (a real <button> inside .genui-host)
  // rather than a callback.
  return (
    <div style={{ padding: 24 }}>
      {code ? <GenuiPreview code={code} done /> : <p>waiting for code…</p>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
