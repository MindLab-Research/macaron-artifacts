import { expect, test } from 'bun:test';
import metadataGate from '../../../plugins/openclaw-metadata-gate/index.mjs';

type Policy = { id: string; evaluate(event: { toolName: string; params: Record<string, unknown> }, ctx: { toolName: string; sessionKey?: unknown }): unknown };
const policies: Policy[] = [];
metadataGate.register({ registerTrustedToolPolicy: (policy: Policy) => policies.push(policy) });
const policy = policies[0]!;
const suffix = 'a8612410-a203-4894-bfbb-7c92694fb814';
const metadataKey = `macaron-metadata:${suffix}`;

test('registers the declared trusted metadata policy', () => {
  expect(policies).toHaveLength(1);
  expect(policy.id).toBe('macaron-metadata-gate');
});

test.each([metadataKey, `agent:main:${metadataKey}`, `agent:research_2:${metadataKey}`, `agent:ops-agent:${metadataKey}`])('blocks every tool in metadata session %s', sessionKey => {
  for (const toolName of ['write', 'exec', 'read', 'plugin_tool']) {
    expect(policy.evaluate({ toolName, params: {} }, { toolName, sessionKey })).toEqual({ block: true, blockReason: 'Macaron metadata fork is non-executing.' });
  }
});

test.each([
  'main', 'agent:main:main', 'agent:research_2:dashboard:ordinary', `ordinary:${metadataKey}`, `agent:main:ordinary:${metadataKey}`,
  `agent:main:discord:channel:${metadataKey}`, `agent:macaron-metadata:${suffix}`, `agent:main:macaron-metadata-other:${suffix}`,
  'agent:main:macaron-metadata', 'macaron-metadata', `agent::${metadataKey}`, '', undefined, null, 42, { toString: () => metadataKey },
])('leaves non-metadata session %p untouched', sessionKey => {
  expect(policy.evaluate({ toolName: 'write', params: {} }, { toolName: 'write', sessionKey })).toBeUndefined();
});

test('uses the host session identity, regardless of tool arguments', () => {
  expect(policy.evaluate({ toolName: 'write', params: { sessionKey: metadataKey } }, { toolName: 'write', sessionKey: 'agent:main:main' })).toBeUndefined();
  expect(policy.evaluate({ toolName: 'write', params: { sessionKey: 'agent:main:main' } }, { toolName: 'write', sessionKey: `agent:main:${metadataKey}` })).toMatchObject({ block: true });
});
