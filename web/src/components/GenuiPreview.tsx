import { useEffect, useState } from 'react';
import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';

// Thin wrapper around the vendored Macaron StaticGenUIRenderer.
// The full streaming/partial/import-map logic lives there (580 lines that we'd
// otherwise have to re-implement). All we do is pass the streamed code and a
// `streaming` flag while generation is in progress.

export function GenuiPreview({ code, done }: { code: string; done?: boolean }) {
  const [status, setStatus] = useState('idle');
  const [statusClass, setStatusClass] = useState<'' | 'ok' | 'err'>('');

  useEffect(() => {
    if (!code) {
      setStatus('idle');
      setStatusClass('');
    }
  }, [code]);

  return (
    <div className="genui-host">
      <StaticGenUIRenderer
        code={code}
        active={Boolean(code)}
        streaming={!done && Boolean(code)}
        preserveStateOnUpdate={!done}
        flushMode="immediate"
        className="genui-renderer macaron-genui-scope"
        onReady={() => {
          setStatus('module ready');
          setStatusClass('ok');
        }}
        onRendered={() => {
          setStatus(done ? 'done' : 'rendered');
          setStatusClass('ok');
        }}
        onError={(err, phase) => {
          // While streaming, transform/parse errors are transient (next chunk fixes it)
          // — StaticGenUIRenderer itself swallows them, so this only fires on final failures.
          setStatus(phase + ': ' + (err.message || String(err)).slice(0, 80));
          setStatusClass('err');
          // eslint-disable-next-line no-console
          console.warn('[GenuiPreview]', phase, err);
        }}
        onPreviewApplied={(ev) => {
          if (ev.status === 'rendered') {
            setStatus(done ? 'done' : 'rendered');
            setStatusClass('ok');
          } else if (ev.status === 'empty') {
            setStatus('empty');
            setStatusClass('');
          }
        }}
      />
      <div className={'genui-status ' + statusClass}>{status}</div>
    </div>
  );
}
