import { executableVersion } from './common.js';

/** Persisted `opencode` always means native v1, not the v1 SDK's /v2 namespace. */
export async function openCodeBinary(major: 1 | 2): Promise<{ binary: string; version?: string; detail: string; available: boolean }> {
  const variable = major === 1 ? 'MACARON_OPENCODE_PATH' : 'MACARON_OPENCODE_V2_PATH';
  const configured = process.env[variable];
  const candidates = configured ? [configured] : major === 1 ? ['opencode'] : ['opencode2', 'opencode'];
  let detail = `Install OpenCode v${major}, or set ${variable} to its executable`;
  for (const binary of candidates) {
    const version = await executableVersion(binary);
    if (!version) continue;
    if (Number(version.match(/^(?:opencode\s+v?)?(\d+)\./i)?.[1]) === major) return { binary, version, detail: version, available: true };
    detail = `${binary} reports ${version}; OpenCode v${major} is required. Set ${variable} to the v${major} executable`;
  }
  return { binary: candidates[0], detail, available: false };
}

export async function requireOpenCodeBinary(major: 1 | 2): Promise<string> {
  const result = await openCodeBinary(major);
  if (!result.available) throw new Error(result.detail);
  return result.binary;
}
