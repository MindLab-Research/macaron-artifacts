import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { HarnessInfo } from '../../shared/types.js';
import { executableVersion } from './common.js';

/** Match query() native-package precedence in Claude SDK 0.3.263; recheck on upgrades. */
function resolveSdkBinary(): string | undefined {
  const require = createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const { platform, arch } = process, prefix = '@anthropic-ai/claude-agent-sdk';
  const report = platform === 'linux' ? process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined : undefined;
  const musl = report != null && report.header?.glibcVersionRuntime === undefined;
  const platforms = platform === 'android' ? [`linux-${arch}-android`]
    : platform === 'linux' ? (musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`])
    : [`${platform}-${arch}`];
  for (const target of platforms) {
    try {
      const binary = require.resolve(`${prefix}-${target}/claude${platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(binary)) return binary;
    } catch { /* Optional platform package absent. */ }
  }
}

export async function claudeRuntimeInfo(): Promise<HarnessInfo> {
  const override = process.env.MACARON_CLAUDE_PATH;
  const script = override && ['.js', '.mjs', '.tsx', '.ts', '.jsx'].some(ext => override.endsWith(ext));
  const source = override ? script ? 'script' : 'native-cli' : 'bundled-sdk';
  let version: string | undefined;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    if (typeof sdk.query === 'function') {
      const binary = override || resolveSdkBinary();
      // The SDK uses the named interpreter from PATH for script overrides.
      // Probe the script itself, not just its interpreter's version.
      if (binary) version = script
        ? await executableVersion(process.versions.bun ? 'bun' : 'node', [binary, '--version'])
        : await executableVersion(binary);
    }
  } catch { /* Import, platform resolution or execution can be unavailable. */ }
  let detail: string;
  if (version) {
    const sourceLabel = override ? (script ? '自定义脚本' : '外部 CLI') : '内置 Claude SDK';
    detail = `${sourceLabel} · ${version}`;
  } else if (override) {
    detail = 'Claude SDK 或指定的 CLI/脚本不可用，请检查 MACARON_CLAUDE_PATH';
  } else {
    detail = 'Claude SDK 或内置原生程序不可用，请重新安装 Artifacts（保留可选依赖）';
  }
  return {
    id: 'claude-code', name: 'Claude Code', available: Boolean(version), source, detail,
    capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: false, approvals: true, fork: true },
  };
}
