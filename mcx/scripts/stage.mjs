#!/usr/bin/env node
// Stage prebuilt bundles into this package so the published `mcx` tarball is
// self-contained — no dependency on `mcc`. `prepack` builds the monorepo's
// server + web once (at the repo root), then this copies the outputs into
// mcx/server/dist + mcx/web/dist, mirroring what the `mcc` root package ships.
// The launcher resolves `../server/dist/index.js` relative to bin/, so the
// layout here must match mcc's: package root has server/dist and web/dist.
import { cp, mkdir, rm } from 'node:fs/promises';

const here = new URL('.', import.meta.url);            // mcx/scripts/
const pkg = new URL('../', here);                       // mcx/
const repo = new URL('../../', here);                   // repo root

for (const path of ['server/dist/index.js', 'web/dist']) {
  const dest = new URL(path, pkg);
  await rm(dest, { recursive: true, force: true });
  await mkdir(new URL('.', dest), { recursive: true });
  await cp(new URL(path, repo), dest, { recursive: true });
}
