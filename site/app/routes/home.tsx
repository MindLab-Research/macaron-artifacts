import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { Link } from 'react-router';
import { Check, Clipboard, MonitorPlay, MessagesSquare, SlidersHorizontal, Wand2, Layers, Terminal } from 'lucide-react';
import { baseOptions } from '@/lib/layout.shared';
import { track, type SiteEvents } from '@/lib/telemetry';
import ChatShowcase from '@/components/chat-showcase';
import { syntaxThemes } from '@/lib/palettes';

function CommandCopyButton({ code, on }: { code: string; on: SiteEvents['command_copy'] }) {
  const [checked, onClick] = useCopyButton(() => { navigator.clipboard.writeText(code); track('command_copy', on); });
  return <button type="button" data-checked={checked || undefined} className="site:inline-flex site:items-center site:justify-center site:rounded-md site:p-1 site:text-sm site:font-medium site:transition-colors site:duration-100 site:hover:text-fd-accent-foreground site:focus-visible:outline-none site:focus-visible:ring-2 site:focus-visible:ring-fd-ring site:data-[checked]:text-fd-accent-foreground site:[&_svg]:size-4" aria-label={checked ? 'Copied Text' : 'Copy Text'} onClick={onClick}>{checked ? <Check /> : <Clipboard />}</button>;
}

function Command({ code }: { code: string }) {
  return <DynamicCodeBlock lang="bash" code={code} options={{ themes: syntaxThemes }} codeblock={{ allowCopy: false, Actions: ({ className }) => <div className={className}><CommandCopyButton code={code} on={{ engine: 'shared', kind: 'bunx' }} /></div> }} />;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Macaron Artifacts' }, { name: 'description', content: 'One local WebUI for six coding harnesses, streaming conversations, generated UI, and shared Shiki themes.' }];
}

// The package name and CLI stay the same whichever harness a conversation uses.
const PKG = `https://pkg.pr.new/MindLab-Research/macaron-artifacts/macaron-artifacts@${__COMMIT_SHA__}`;

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="site:flex site:flex-col site:items-center site:flex-1 site:px-4">
        <section className="site:flex site:flex-col site:items-center site:text-center site:max-w-2xl site:pt-20 site:pb-16">
          <span className="site:inline-flex site:items-center site:gap-1.5 site:rounded-full site:border site:px-3 site:py-1 site:text-xs site:text-fd-muted-foreground site:mb-6"><Terminal className="site:size-3.5" /> Claude Code, Codex, OpenCode, pi, Hermes &amp; OpenClaw</span>
          <h1 className="site:text-4xl site:sm:text-5xl site:font-bold site:mb-4">Macaron Artifacts</h1>
          <p className="site:text-fd-muted-foreground site:text-lg site:mb-8">One local WebUI for your coding harnesses. Stream conversations and interactive UI with Claude Code, Codex, OpenCode, pi, Hermes, or OpenClaw.</p>
          <div className="site:flex site:flex-wrap site:items-center site:justify-center site:gap-3">
            <Link className="site:text-sm site:bg-fd-primary site:text-fd-primary-foreground site:rounded-full site:font-medium site:px-5 site:py-2.5 site:transition-opacity site:hovered:opacity-90" to="/docs" onClick={() => track('cta_click', { target: 'docs', section: 'hero' })}>Read the Docs</Link>
            <Link className="site:text-sm site:border site:rounded-full site:font-medium site:px-5 site:py-2.5 site:transition-colors site:hovered:bg-fd-accent site:hovered:text-fd-accent-foreground" to="/docs/usage" onClick={() => track('cta_click', { target: 'quick-start', section: 'hero' })}>Quick Start</Link>
          </div>
        </section>

        <section className="site:w-full site:max-w-xl site:pb-20"><ChatShowcase /></section>

        <section className="site:w-full site:max-w-3xl site:pb-20">
          <div className="site:mb-6 site:text-center"><h2 className="site:text-2xl site:font-semibold site:mb-1">Install</h2><p className="site:text-fd-muted-foreground">One package, one local server. Choose the harness inside the app.</p></div>
          <Command code={`bunx macaron-artifacts@${PKG}`} />
          <p className="site:mt-3 site:text-sm site:text-fd-muted-foreground">Requires Node.js 22.19 or newer. Use an authenticated Claude Code, Codex, or OpenCode CLI, or the included pi SDK with your local pi configuration. The preview package is pinned to this build's commit.</p>
          <p className="site:mt-3 site:text-sm site:text-fd-muted-foreground">Open <a className="site:text-fd-foreground site:underline site:underline-offset-4" href="http://127.0.0.1:43860">http://127.0.0.1:43860</a>, then create a conversation with your harness and workspace. See <Link className="site:text-fd-foreground site:underline site:underline-offset-4" to="/docs/usage">Quick Start</Link> for installation and configuration.</p>
        </section>

        <section className="site:w-full site:max-w-5xl site:pb-24">
          <div className="site:mb-6"><h2 className="site:text-2xl site:font-semibold site:mb-1">Run Agents With a UI</h2><p className="site:text-fd-muted-foreground">The same conversation interface, whichever harness you choose.</p></div>
          <Cards className="site:grid-cols-1 site:sm:grid-cols-3">
            <Card icon={<MonitorPlay />} title="Shared Interface" href="/docs/usage" onClick={() => track('cta_click', { target: 'shared-interface', section: 'run-with-ui' })}>Choose Claude Code, Codex, OpenCode, pi, Hermes, or OpenClaw per conversation. Workspaces, sessions, and approvals stay in one app.</Card>
            <Card icon={<MessagesSquare />} title="Live Conversations" href="/docs/usage" onClick={() => track('cta_click', { target: 'live-chat', section: 'run-with-ui' })}>Follow native text, reasoning, and tool events as they arrive. Reconnect to active turns after refreshing.</Card>
            <Card icon={<SlidersHorizontal />} title="Native Configuration" href="/docs/usage" onClick={() => track('cta_click', { target: 'native-configuration', section: 'run-with-ui' })}>Use each harness's existing login, gateway, and settings, or select a Profile and model when starting a conversation.</Card>
          </Cards>
          <div className="site:mt-12 site:mb-6"><h2 className="site:text-2xl site:font-semibold site:mb-1">Generated UI, Two Ways</h2><p className="site:text-fd-muted-foreground">Small interactive answers in the conversation, persistent tools in Canvas.</p></div>
          <Cards>
            <Card icon={<Wand2 />} title="Inline UI4A" href="/docs/usage" onClick={() => track('cta_click', { target: 'inline-ui4a', section: 'extend' })}>A ui4a/tsx block renders while its source streams. Components inherit the same theme as the app.</Card>
            <Card icon={<Layers />} title="File Canvas" href="/docs/usage" onClick={() => track('cta_click', { target: 'file-canvas', section: 'extend' })}>Files in .artifacts open in the side panel, with relative modules and persistent component state.</Card>
          </Cards>
        </section>
      </div>
    </HomeLayout>
  );
}
