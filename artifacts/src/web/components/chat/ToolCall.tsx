import { memo, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';
import { Icon } from '../Icon';
import { toolOutput } from './tool-output';
import { artifactEntryPath } from '../../../shared/artifact-path';
import { editDiff, type ToolPart } from './tool-presentation';

type Tool = ToolPart;
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
  const diff = useMemo(() => editDiff(part), [part.state, part.input, part.toolName, part.type, part.errorText]);
  // Keep the sticky summary on the chat plane; only expanded output takes the code palette.
  return <details className="tool-call overflow-clip rounded-lg bg-surface-2 text-xs" open={working || undefined}><summary className="interactive sticky top-0 z-sticky flex cursor-pointer list-none items-center gap-2 bg-surface px-3 py-2 text-muted hover:bg-surface-3 hover:text-hover-fg">{working ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : <Icon name={part.state === 'output-error' ? 'x' : 'check'} className="size-3.5 shrink-0" />}<span className="shrink-0 font-medium">{name}</span><span className="min-w-0 flex-1 truncate">{hint}</span>{diff ? <span aria-label={`编辑片段：新增 ${diff.added} 行，删除 ${diff.removed} 行`} className="flex shrink-0 gap-1.5 font-mono"><span className="text-success">+{diff.added}</span><span className="text-danger">−{diff.removed}</span></span> : null}<ChevronRight aria-hidden className="tool-disclosure-icon size-3.5 shrink-0" /></summary>{diff ? <div className="theme-code"><p className="px-3 pt-2 text-xs text-muted">编辑片段</p><Collapsible><CodeBlock code={diff.code} lang="diff" /></Collapsible></div> : null}{source && !diff ? <Collapsible className="theme-code"><CodeBlock code={source} lang={typeof input?.content === 'string' ? 'tsx' : typeof command === 'string' ? 'bash' : 'json'} /></Collapsible> : null}{source && diff ? <details className="px-3 py-2"><summary className="cursor-pointer text-muted">原始参数</summary><Collapsible className="theme-code"><CodeBlock code={source} lang="json" /></Collapsible></details> : null}{output ? <Collapsible className="theme-code"><CodeBlock code={output} lang="text" /></Collapsible> : null}{part.errorText ? <p className="px-3 py-2 whitespace-pre-wrap text-danger">{part.errorText}</p> : null}{canvas ? <button type="button" onClick={() => onArtifact(file as string)} className="interactive m-2 rounded-md px-2 py-1 text-muted hover:bg-surface-3 hover:text-hover-fg">在 Canvas 中打开</button> : null}</details>;
});
