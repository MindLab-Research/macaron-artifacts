import { lazy, Suspense, useRef, useState } from 'react';
import type { Artifact, SessionSummary } from '../../shared/types';
import { CodeBlock } from './code/CodeBlock';
import { Icon } from './Icon';
import { Select } from './Select';
import { ExportMenu } from './ExportMenu';

const Ui4aSurface = lazy(() => import('../ui4a/Ui4aSurface').then(module => ({ default: module.Ui4aSurface })));
const artifactName = (path: string) => path.split('/').at(-1)?.replace(/\.ui4a\.tsx$/, '').replace(/\.tsx$/, '') ?? path;

export function ArtifactPanel({ session, artifacts, selected, onSelect, onClose, onSend }: { session: SessionSummary; artifacts: Artifact[]; selected?: string; onSelect: (path: string) => void; onClose: () => void; onSend: (text: string) => void }) {
  const [source, setSource] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const artifact = artifacts.find(item => item.path === selected);
  return <section className="theme-panel @container flex h-full min-w-0 flex-col" aria-label="Canvas"><header className="flex h-12 shrink-0 items-center gap-2 px-3">
    {artifacts.length > 1 ? <div className="min-w-0 flex-1"><Select label="选择 Canvas" value={selected ?? artifacts[0].path} options={artifacts.map(item => ({ value: item.path, label: artifactName(item.path), title: item.path }))} onChange={onSelect} /></div> : <span title={artifact?.path} className="min-w-0 flex-1 truncate text-sm font-medium">{artifact ? artifactName(artifact.path) : 'Canvas'}</span>}
    {artifact ? <button type="button" onClick={() => setSource(value => !value)} aria-pressed={source} className="artifact-source-toggle interactive h-9 shrink-0 rounded-md px-2 text-xs text-muted hover:bg-surface-3 hover:text-hover-fg">{source ? '预览' : '源码'}</button> : null}
    {artifact ? <ExportMenu key={artifact.path} target={target} filename={artifactName(artifact.path)} disabled={artifact.streaming || source} /> : null}
    <button type="button" onClick={onClose} title="关闭 Canvas" aria-label="关闭 Canvas" className="artifact-close btn-icon size-7 shrink-0 rounded-md"><Icon name="x" className="size-3.5" /></button>
  </header><div ref={target} className="min-h-0 flex-1 overflow-y-auto">
    {artifact ? source ? <CodeBlock code={artifact.source} /> : <Suspense fallback={<CodeBlock code={artifact.source} />}><Ui4aSurface key={`${session.id}:${artifact.path}`} source={artifact.source} streaming={artifact.streaming} scope={`${session.id}:canvas:${artifact.path}`} sessionId={session.id} filename={artifact.path} revision={artifact.streaming ? undefined : artifact.revision} onSend={onSend} /></Suspense> : artifacts.length ? <ul className="flex flex-col gap-1 p-3">{artifacts.map(item => <li key={item.path}><button type="button" title={item.path} onClick={() => onSelect(item.path)} className="interactive w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-3 hover:text-hover-fg">{artifactName(item.path)}</button></li>)}</ul> : <p className="p-6 text-center text-xs leading-relaxed text-muted">还没有 Canvas。让模型在 <code className="rounded bg-inline-code px-1 text-inline-code-fg">.artifacts/</code> 中创建一个界面。</p>}
  </div></section>;
}
