import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';

// Thin wrapper around the vendored Macaron StaticGenUIRenderer.
// The full streaming/partial/import-map logic lives there (580 lines that we'd
// otherwise have to re-implement). All we do is pass the streamed code and a
// `streaming` flag while generation is in progress.

export function GenuiPreview({ code, done }: { code: string; done?: boolean }) {
  return (
    <div className="genui-host">
      <StaticGenUIRenderer
        code={code}
        active={Boolean(code)}
        streaming={!done && Boolean(code)}
        preserveStateOnUpdate={!done}
        flushMode="immediate"
        className="genui-renderer macaron-genui-scope"
        onError={(err, phase) => {
          // eslint-disable-next-line no-console
          console.warn('[GenuiPreview]', phase, err);
        }}
      />
    </div>
  );
}
