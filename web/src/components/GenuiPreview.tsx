import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';
import type { Engine } from '@macaron/shared';
import { trackFailedOnce, trackRenderedOnce } from '../lib/telemetry';

// Thin wrapper around the vendored Macaron StaticGenUIRenderer.
// The full streaming/partial/import-map logic lives there (580 lines that we'd
// otherwise have to re-implement). All we do is pass the streamed code and a
// `streaming` flag while generation is in progress.

export function GenuiPreview({ code, done, engine, widgetId }: { code: string; done?: boolean; engine?: Engine; widgetId?: string }) {
  return (
    <div className="genui-host">
      <StaticGenUIRenderer
        code={code}
        active={Boolean(code)}
        streaming={!done && Boolean(code)}
        preserveStateOnUpdate={!done}
        flushMode="immediate"
        className="genui-renderer macaron-genui-scope"
        onRendered={() => { if (engine && widgetId) trackRenderedOnce(widgetId, engine); }}
        onError={(err, phase) => {
          if (done && engine && widgetId) trackFailedOnce(widgetId, engine, phase, err.message);
          // eslint-disable-next-line no-console
          console.warn('[GenuiPreview]', phase, err);
        }}
      />
    </div>
  );
}
