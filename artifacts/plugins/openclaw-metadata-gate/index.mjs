// sessions.create scopes requested keys as agent:<agentId>:<key> before tool policies run.
const METADATA_SESSION_KEY = /^(?:agent:[^:]+:)?macaron-metadata:/;
export default {
  id: 'macaron-artifacts-metadata-gate',
  name: 'Macaron Artifacts Metadata Gate',
  description: 'Blocks tool execution in Macaron metadata forks.',
  register(api) {
    api.registerTrustedToolPolicy({
      id: 'macaron-metadata-gate',
      description: 'Deny every tool call in Macaron metadata fork sessions.',
      evaluate(_event, ctx) {
        return typeof ctx.sessionKey === 'string' && METADATA_SESSION_KEY.test(ctx.sessionKey)
          ? { block: true, blockReason: 'Macaron metadata fork is non-executing.' }
          : undefined;
      },
    });
  },
};
