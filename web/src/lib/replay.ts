import type { Message } from '@macaron/shared';

export type ReplayTiming = 'exact' | 'natural' | 'compact';

export type ReplayTimelineEntry = { message: Message; start: number; end: number; renderUICode?: string };

// Historical jsonl has no token-level timing, so the stream start is
// back-calculated from the recorded tool_use completion time at this rate.
const RENDER_UI_TOKENS_PER_SECOND = 50;
const CHARS_PER_TOKEN = 4;

function timestamp(message: Message): number | undefined {
  const value = message.timestamp ? new Date(message.timestamp).getTime() : NaN;
  return Number.isFinite(value) ? value : undefined;
}

export function compressReplayGap(gap: number, timing: ReplayTiming): number {
  if (timing === 'exact') return gap;
  if (timing === 'compact') return Math.min(2_000, gap);
  if (gap <= 2_000) return gap;
  return 2_000 + 2_000 * Math.log(gap / 2_000);
}

export function createReplayTimeline(messages: Message[], timing: ReplayTiming = 'natural'): ReplayTimelineEntry[] {
  let elapsed = 0;
  return messages.map((message, index) => {
    if (index > 0) {
      const current = timestamp(message);
      const previous = timestamp(messages[index - 1]!);
      const gap = current === undefined || previous === undefined ? 250 : compressReplayGap(Math.max(0, current - previous), timing);
      elapsed += gap;
      const renderUICode = getRenderUICode(message);
      const streamDuration = renderUICode ? compressReplayGap(renderUICode.length / CHARS_PER_TOKEN / RENDER_UI_TOKENS_PER_SECOND * 1_000, timing) : 0;
      return { message, start: Math.max(0, elapsed - streamDuration), end: elapsed, renderUICode };
    }
    return { message, start: 0, end: 0 };
  });
}

export function replayFrame(timeline: ReplayTimelineEntry[], position: number): Message[] {
  const visible: Message[] = [];
  for (const entry of timeline) {
    if (position >= entry.end) {
      visible.push(entry.message);
      continue;
    }
    if (entry.renderUICode && position >= entry.start) {
      // 不能在此 break：render_ui 的落盘时间 ≈ 同一 message 的文本块（工具调用在
      // text 之后成对落盘），反推的 streaming 起点却远早于两者。若遇到未到时间
      // 的 text 就 break，streaming 窗口内永远轮不到这条 render_ui 出现。
      const progress = (position - entry.start) / (entry.end - entry.start);
      visible.push(withRenderUICode(entry.message, partialCodeAt(entry.renderUICode, progress)));
    }
    // end 单调递增，未到时间的普通消息之后也不会到时间，继续扫描只为找到
    // start 更早的 streaming render_ui。
  }
  return visible;
}

// 任意字符位置截断会把标识符切成半截，partial 编译基本必挂；按行边界截断
// 后 partial-react 才能逐行 salvage 出越来越多的内容。
function partialCodeAt(code: string, progress: number): string {
  const target = Math.max(1, Math.floor(code.length * Math.min(1, progress)));
  if (target >= code.length) return code;
  const newline = code.indexOf('\n', target);
  return code.slice(0, newline === -1 ? code.length : newline + 1);
}

function getRenderUICode(message: Message): string | undefined {
  for (const block of message.blocks) {
    if (block.kind !== 'tool_use' || !(block.name === 'mcp:macaron/render_ui' || block.name.endsWith('__render_ui'))) continue;
    const code = (block.input as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code) return code;
  }
}

function withRenderUICode(message: Message, code: string): Message {
  return { ...message, blocks: message.blocks.map((block) => block.kind === 'tool_use' && (block.name === 'mcp:macaron/render_ui' || block.name.endsWith('__render_ui')) ? { ...block, input: { ...(block.input as Record<string, unknown>), code, _replayStreaming: true } } : block) };
}
