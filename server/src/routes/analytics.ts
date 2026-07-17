import type { FastifyInstance } from 'fastify';
import type { AnalyticsResponse } from '@macaron/shared';
import { collectUsage } from '../lib/usage-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS: Record<string, number> = {
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

function firstParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function numberParam(value: unknown, fallback: number): number {
  const raw = firstParam(value);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { window?: string; since?: string; until?: string } }>(
    '/api/analytics',
    async ({ query }): Promise<AnalyticsResponse> => {
      const requestedWindow = firstParam(query.window) || '30d';
      const window =
        requestedWindow === 'all' || Object.hasOwn(WINDOWS, requestedWindow)
          ? requestedWindow
          : '30d';
      const until = numberParam(query.until, Date.now());
      const defaultSince = window === 'all' ? 0 : until - WINDOWS[window]!;
      const since = numberParam(query.since, defaultSince);
      const result = await collectUsage(since, until);
      return { ...result, window };
    },
  );
}
