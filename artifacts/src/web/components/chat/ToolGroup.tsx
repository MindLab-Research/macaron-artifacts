import { Icon } from '../Icon';
import { ToolCall } from './ToolCall';
import { toolHint, type ToolPart } from './tool-presentation';

export function ToolGroup({ parts, cwd, outputs, onArtifact }: { parts: ToolPart[]; cwd: string; outputs: Map<string, string>; onArtifact(path: string): void }) {
  return <details onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.currentTarget.dataset.keyboard = "true"; }} onPointerDown={event => { delete event.currentTarget.dataset.keyboard; }} className="tool-group rounded-xl border border-contrast text-xs"><summary className="interactive flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-muted hover:bg-surface-2"><Icon name="check" className="size-3.5" /><span className="font-medium">读取与搜索 · {parts.length} 次</span><span className="min-w-0 flex-1 truncate">{parts.slice(0, 3).map(toolHint).join(' · ')}</span><Icon name="chevronDown" className="tool-group-icon size-3.5" /></summary><div className="flex flex-col gap-1 p-2">{parts.map((part, index) => <ToolCall key={part.toolCallId ?? index} part={part} cwd={cwd} commandOutput={part.toolCallId ? outputs.get(part.toolCallId) : undefined} onArtifact={onArtifact} />)}</div></details>;
}
