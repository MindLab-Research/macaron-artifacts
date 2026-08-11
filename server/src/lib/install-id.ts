// A random, stable per-install identifier, persisted to ~/.claude/macaron-install.json.
//
// Without it the collector cannot count installs at all: every server event
// carries the same hard-coded User-Agent and hostname (see telemetry.ts), so
// umami's session hash degrades to the egress IP — which for one proxied
// machine forks into a dozen "users" a day and merges distinct machines behind
// one NAT. This is the only thing that makes "how many people run macaron" and
// any per-install funnel answerable.
//
// It is a bare uuid with nothing derived from the machine: no hostname, no MAC,
// no username. It says "the same install as last time", nothing more.
//
// Read synchronously because track() is sync and fires from process-exit paths
// where a pending promise would never settle.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOME } from '../config.js';

const ID_PATH = path.join(HOME, '.claude', 'macaron-install.json');

function load(): string {
  try {
    const id = (JSON.parse(fs.readFileSync(ID_PATH, 'utf8')) as { installId?: string }).installId;
    if (id) return id;
  } catch { /* missing or corrupt — mint fresh below */ }
  const installId = randomUUID();
  // A failed write is survivable: telemetry still reports, the install just
  // looks new next boot. Never let it take the server down.
  try {
    fs.mkdirSync(path.dirname(ID_PATH), { recursive: true });
    fs.writeFileSync(ID_PATH, JSON.stringify({ installId }, null, 2));
  } catch { /* read-only home — report anyway */ }
  return installId;
}

export const INSTALL_ID = load();
