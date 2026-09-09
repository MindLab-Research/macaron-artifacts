import { memo } from 'react';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';
import { Icon } from '../Icon';
import { toolOutput } from './tool-output';
import { artifactEntryPath } from '../../../shared/artifact-path';

type Tool = { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown; errorText?: string; toolCallId?: string };
export const ToolCall = memo(function ToolCall({ part, commandOutput, cwd = '', onArtifact }: { part: Tool; commandOutput?: string; cwd?: string; onArtifact: (path: string) => void }) {
  const name = part.toolName ?? part.type.replace(/^tool-/, '');
  const input = part.input as Record<string, unknown> | undefined;
  const file = input?.file_path ?? input?.path ?? input?.filePath ?? input?.filename;
  const command = input?.command ?? input?.cmd;
  const hint = typeof file === 'string' ? file : typeof command === 'string' ? command : '';
  const working = part.state === 'input-streaming' || part.state === 'input-available';
  const source = typeof input?.content === 'string' ? input.content : typeof command === 'string' ? command : input ? JSON.stringify(input, null, 2) : '';
  const output = toolOutput(part, commandOutput);
  const canvas = typeof file === 'string' ? artifactEntryPath(file, cwd) : undefined;
  return <details className="overflow-clip rounded-lg border border-border text-xs" open={working || undefined}><summary className="interactive sticky top-0 z-20 flex cursor-pointer list-none items-center gap-2 bg-surface px-3 py-2 text-muted hover:text-fg">{working ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : <Icon name={part.state === 'output-error' ? 'x' : 'check'} className="size-3.5 shrink-0" />}<span className="shrink-0 font-medium">{name}</span><span className="min-w-0 flex-1 truncate">{hint}</span></summary>{source ? <Collapsible className="border-t border-border"><CodeBlock code={source} lang={typeof input?.content === 'string' ? 'tsx' : typeof command === 'string' ? 'bash' : 'json'} /></Collapsible> : null}{output ? <Collapsible className="border-t border-border"><CodeBlock code={output} lang="text" /></Collapsible> : null}{part.errorText ? <p className="px-3 py-2 whitespace-pre-wrap text-danger">{part.errorText}</p> : null}{canvas ? <button type="button" onClick={() => onArtifact(file as string)} className="interactive m-2 rounded-md px-2 py-1 text-muted hover:bg-surface-3">在 Canvas 中打开</button> : null}</details>;
});
