import type { FastifyInstance } from 'fastify';
import type { TelemetryConfig } from '@macaron/shared';
import { telemetryConfig } from '../lib/telemetry.js';

// The web bundle asks here at boot whether to load the umami script at all.
// With MACARON_TELEMETRY=0 this returns enabled:false and no script is ever
// injected, so an opted-out install makes zero third-party requests.
export async function registerTelemetryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/telemetry', async (): Promise<TelemetryConfig> => telemetryConfig);
}
