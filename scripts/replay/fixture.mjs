import fs from 'node:fs';
import path from 'node:path';

export const RENDER_UI_TOOL = 'mcp__macaron__render_ui';

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid replay: ${message}`);
}

function renderCode(renderUi) {
  if (typeof renderUi.code === 'string') return renderUi.code;
  assert(Array.isArray(renderUi.codeLines), 'renderUi.code or renderUi.codeLines is required');
  assert(renderUi.codeLines.every((line) => typeof line === 'string'), 'renderUi.codeLines must contain strings');
  return renderUi.codeLines.join('\n');
}

export function validateReplayFixture(fixture) {
  assert(fixture && typeof fixture === 'object', 'fixture must be an object');
  assert(fixture.version === 1, 'version must be 1');
  assert(typeof fixture.id === 'string' && fixture.id, 'id is required');
  assert(Number.isFinite(fixture.duration) && fixture.duration >= 8 && fixture.duration <= 300, 'duration must be between 8 and 300 seconds');
  assert(fixture.workspace && typeof fixture.workspace === 'object', 'workspace is required');
  for (const key of ['project', 'cwd', 'name', 'sessionId', 'title']) {
    assert(typeof fixture.workspace[key] === 'string' && fixture.workspace[key], `workspace.${key} is required`);
  }
  assert(Array.isArray(fixture.events) && fixture.events.length > 0, 'events must be non-empty');

  let previousAt = -1;
  const renderIds = new Set();
  fixture.events.forEach((entry, index) => {
    assert(Number.isFinite(entry.at) && entry.at >= 0 && entry.at <= fixture.duration, `events[${index}].at is outside the replay`);
    assert(entry.at >= previousAt, `events[${index}].at must be monotonic`);
    previousAt = entry.at;
    const hasEvent = entry.event && typeof entry.event === 'object';
    const hasRender = entry.renderUi && typeof entry.renderUi === 'object';
    assert(Boolean(hasEvent) !== Boolean(hasRender), `events[${index}] needs exactly one of event or renderUi`);
    if (hasEvent) {
      assert(typeof entry.event.type === 'string' && entry.event.type, `events[${index}].event.type is required`);
      return;
    }

    const renderUi = entry.renderUi;
    assert(typeof renderUi.id === 'string' && renderUi.id, `events[${index}].renderUi.id is required`);
    assert(!renderIds.has(renderUi.id), `duplicate renderUi id: ${renderUi.id}`);
    renderIds.add(renderUi.id);
    assert(renderCode(renderUi).length >= 40, `${renderUi.id} code is too short`);
    assert(Number.isFinite(renderUi.duration) && renderUi.duration > 0, `${renderUi.id}.duration must be positive`);
    assert(Number.isInteger(renderUi.chunks) && renderUi.chunks >= 2, `${renderUi.id}.chunks must be at least 2`);
    assert(entry.at + renderUi.duration <= fixture.duration, `${renderUi.id} exceeds replay duration`);
  });
}

export function expandReplayFixture(fixture) {
  validateReplayFixture(fixture);
  const schedule = [];
  let sequence = 0;
  for (const entry of fixture.events) {
    if (entry.event) {
      schedule.push({ at: entry.at, sequence: sequence++, event: structuredClone(entry.event) });
      continue;
    }

    const renderUi = entry.renderUi;
    const code = renderCode(renderUi);
    const lineEnds = [...code.matchAll(/\n/g), { index: code.length - 1 }].map((match) => match.index + 1);
    const chunkCount = Math.min(renderUi.chunks, lineEnds.length);
    for (let index = 1; index <= chunkCount; index += 1) {
      const partialCode = code.slice(0, lineEnds[Math.ceil((lineEnds.length * index) / chunkCount) - 1]);
      schedule.push({
        at: entry.at + (renderUi.duration * index) / chunkCount,
        sequence: sequence++,
        event: {
          type: 'tool_input_delta',
          id: renderUi.id,
          name: RENDER_UI_TOOL,
          partial_json: '',
          accumulated: JSON.stringify({ code: partialCode }),
        },
      });
    }
    schedule.push({
      at: entry.at + renderUi.duration,
      sequence: sequence++,
      event: {
        type: 'tool_input_done',
        id: renderUi.id,
        name: RENDER_UI_TOOL,
        final_json: JSON.stringify({ code }),
      },
    });
  }
  schedule.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
  return { fixture, schedule };
}

export function loadReplayFixture(file) {
  const absolute = path.resolve(file);
  const fixture = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  return expandReplayFixture(fixture);
}
