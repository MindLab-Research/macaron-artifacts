/** v2 plugins must be directories with index.mjs. A standalone file is silently ignored. */
export const openCodeV2GuardPlugin = `import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
export default { id: 'macaron-artifacts-v2-guard', async setup(ctx) {
  const mode = async id => JSON.parse(await readFile(process.env.MACARON_OPENCODE_V2_GUARD_FILE, 'utf8'))[id];
  const path = id => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid native session ID');
    return join(process.env.MACARON_OPENCODE_V2_PREFIX_DIR, id + '.json');
  };
  await ctx.tool.hook('execute.before', async event => {
    if ((await mode(event.sessionID))?.parent) throw new Error('Tools are disabled for metadata generation');
  });
  await ctx.session.hook('context', async event => {
    const meta = await mode(event.sessionID);
    if (!meta) return; // Native subagents and user plugins keep their own context.
    const key = event.model.providerID + '/' + event.model.id;
    if (meta.parent) {
      const prefix = JSON.parse(await readFile(path(meta.parent), 'utf8'));
      if (prefix.model !== key || !Array.isArray(prefix.system)) throw new Error('Metadata fork has no matching system prefix');
      if (JSON.stringify(event.tools) !== JSON.stringify(prefix.tools)) throw new Error('Metadata tool definitions changed');
      event.system.splice(0, event.system.length, ...structuredClone(prefix.system));
      for (const k of ['promptCacheKey', 'prompt_cache_key', 'user']) if (event.options[k] === event.sessionID) event.options[k] = meta.parent;
    } else {
      event.system.push({ type: 'text', text: meta.instructions });
      await mkdir(process.env.MACARON_OPENCODE_V2_PREFIX_DIR, { recursive: true, mode: 0o700 });
      const target = path(event.sessionID), temporary = target + '.' + process.pid;
      await writeFile(temporary, JSON.stringify({ model: key, system: event.system, tools: event.tools }), { mode: 0o600 });
      await rename(temporary, target);
    }
  });
  await ctx.session.hook('model.request', async event => {
    const meta = await mode(event.sessionID); if (!meta?.parent) return;
    for (const name of ['x-opencode-session', 'x-session-affinity', 'X-Session-Id']) {
      const key = Object.keys(event.headers).find(key => key.toLowerCase() === name.toLowerCase());
      if (!key || event.headers[key] === event.sessionID) event.headers[key || name] = meta.parent;
    }
  });
} };
`;
