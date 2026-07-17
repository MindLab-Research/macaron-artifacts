import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Tab, Tabs, TabsList, TabsTrigger } from 'fumadocs-ui/components/tabs';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useCopyButton } from 'fumadocs-ui/utils/use-copy-button';
import { Link } from 'react-router';
import { Check, Clipboard, MonitorPlay, MessagesSquare, SlidersHorizontal, Wand2, Puzzle, Terminal } from 'lucide-react';
import ClaudeCode from '@lobehub/icons/es/ClaudeCode/components/Mono';
import Codex from '@lobehub/icons/es/Codex/components/Mono';
import Kimi from '@lobehub/icons/es/Kimi/components/Mono';
import { baseOptions } from '@/lib/layout.shared';
import ChatShowcase from '@/components/chat-showcase';

function CommandCopyButton({ code }: { code: string }) {
  const [checked, onClick] = useCopyButton(() => navigator.clipboard.writeText(code));

  return (
    <button
      type="button"
      data-checked={checked || undefined}
      className="inline-flex items-center justify-center rounded-md p-1 text-sm font-medium transition-colors duration-100 hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring data-checked:text-fd-accent-foreground [&_svg]:size-4"
      aria-label={checked ? 'Copied Text' : 'Copy Text'}
      onClick={onClick}
    >
      {checked ? <Check /> : <Clipboard />}
    </button>
  );
}

// Keep the Fumadocs highlighting while binding each copy action directly to its command.
function Command({ code }: { code: string }) {
  return (
    <DynamicCodeBlock
      lang="bash"
      code={code}
      codeblock={{
        allowCopy: false,
        Actions: ({ className }) => (
          <div className={className}>
            <CommandCopyButton code={code} />
          </div>
        ),
      }}
    />
  );
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Macaron Artifacts' },
    { name: 'description', content: 'The local WebUI, GenUI tooling, and plugin manifests for running Macaron with Claude Code, Codex, and Kimi Code.' },
  ];
}

// pkg.pr.new ships prebuilt tarballs per commit; __COMMIT_SHA__ is injected at build time (falls back to `<sha>`).
const PKG = `https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcc@${__COMMIT_SHA__}`;
const PKG_MCX = `https://pkg.pr.new/MindLab-Research/macaron-artifacts/mcx@${__COMMIT_SHA__}`;
const PKG_MKX = `https://pkg.pr.new/MindLab-Research/macaron-artifacts/mkx@${__COMMIT_SHA__}`;

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-col items-center flex-1 px-4">
        <section className="flex flex-col items-center text-center max-w-2xl pt-20 pb-16">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-fd-muted-foreground mb-6">
            <Terminal className="size-3.5" /> Claude Code &amp; Codex &amp; Kimi Code
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">Macaron Artifacts</h1>
          <p className="text-fd-muted-foreground text-lg mb-8">
            The local WebUI, GenUI tooling, and plugin manifests for running Macaron with Claude Code, Codex, and Kimi Code — visual
            sessions, live chat, and generated UI, straight from your terminal.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              className="text-sm bg-fd-primary text-fd-primary-foreground rounded-full font-medium px-5 py-2.5 transition-opacity hovered:opacity-90"
              to="/docs"
            >
              Read the Docs
            </Link>
            <Link
              className="text-sm border rounded-full font-medium px-5 py-2.5 transition-colors hovered:bg-fd-accent hovered:text-fd-accent-foreground"
              to="/docs/usage"
            >
              Quick Start
            </Link>
            <Link
              className="text-sm border rounded-full font-medium px-5 py-2.5 transition-colors hovered:bg-fd-accent hovered:text-fd-accent-foreground"
              to="/connect"
            >
              Connect a Server
            </Link>
          </div>
        </section>

        <section className="w-full max-w-xl pb-20">
          <ChatShowcase />
        </section>

        <section className="w-full max-w-3xl pb-20">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold mb-1">Install</h2>
            <p className="text-fd-muted-foreground">
              Add the plugin to your agent, or run the published build with no install at all.
            </p>
          </div>

          <div className="mb-4 text-sm font-medium text-fd-muted-foreground">Plugin Marketplace</div>
          <Tabs defaultValue="claude-code">
            <TabsList>
              <TabsTrigger value="claude-code" className="gap-2">
                <ClaudeCode size={16} /> Claude Code
              </TabsTrigger>
              <TabsTrigger value="codex" className="gap-2">
                <Codex size={16} /> Codex
              </TabsTrigger>
              <TabsTrigger value="kimi-code" className="gap-2">
                <Kimi size={16} /> Kimi Code
              </TabsTrigger>
            </TabsList>
            <Tab value="claude-code">
              <Steps>
                <Step>
                  <p className="font-medium">Add the Marketplace Source</p>
                  <Command code="claude plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts" />
                </Step>
                <Step>
                  <p className="font-medium">Install the Plugin</p>
                  <Command code="claude plugin install macaron@macaron" />
                </Step>
                <Step>
                  <p className="font-medium">Run It and Open the WebUI</p>
                  <Command code="/macaron" />
                  <p className="text-sm text-fd-muted-foreground">
                    Run it in a session — the WebUI opens on{' '}
                    <a className="text-fd-foreground underline underline-offset-4" href="http://localhost:7878">http://localhost:7878</a>.
                  </p>
                </Step>
              </Steps>
            </Tab>
            <Tab value="codex">
              <Steps>
                <Step>
                  <p className="font-medium">Add the Marketplace Source</p>
                  <Command code="codex plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts" />
                </Step>
                <Step>
                  <p className="font-medium">Add the Plugin</p>
                  <Command code="codex plugin add macaron@macaron" />
                </Step>
                <Step>
                  <p className="font-medium">Run It and Open the WebUI</p>
                  <p className="text-sm text-fd-muted-foreground">
                    Ask Codex to open the Macaron WebUI — it serves on{' '}
                    <a className="text-fd-foreground underline underline-offset-4" href="http://localhost:7979">http://localhost:7979</a>.
                  </p>
                </Step>
              </Steps>
            </Tab>
            <Tab value="kimi-code">
              <Steps>
                <Step>
                  <p className="font-medium">Install from GitHub</p>
                  <Command code="/plugins install https://github.com/MindLab-Research/macaron-artifacts" />
                  <p className="text-sm text-fd-muted-foreground">
                    Run it in a Kimi Code session, then <code className="text-fd-foreground">/reload</code> to activate.
                  </p>
                </Step>
                <Step>
                  <p className="font-medium">Run It and Open the WebUI</p>
                  <Command code="/macaron:macaron" />
                  <p className="text-sm text-fd-muted-foreground">
                    The WebUI opens on{' '}
                    <a className="text-fd-foreground underline underline-offset-4" href="http://localhost:7980">http://localhost:7980</a>.
                  </p>
                </Step>
              </Steps>
            </Tab>
          </Tabs>

          <div className="mt-8 mb-4 text-sm font-medium text-fd-muted-foreground">Run Without Installing</div>
          <p className="mb-3 text-sm text-fd-muted-foreground">
            The <code className="text-fd-foreground">pkg.pr.new</code> tarball ships prebuilt bundles and three bins —{' '}
            <code className="text-fd-foreground">mcc</code> (Claude, port 7878),{' '}
            <code className="text-fd-foreground">mcx</code> (Codex, port 7979) and{' '}
            <code className="text-fd-foreground">mkx</code> (Kimi, port 7980). The commands are pinned to this
            build's commit; swap in any other commit on <code className="text-fd-foreground">main</code> to pull that build.
          </p>
          <Tabs items={['bun', 'npm']}>
            <Tab value="bun">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <ClaudeCode size={15} /> Claude — <code className="text-fd-muted-foreground">mcc</code>
                  </div>
                  <Command code={`bunx mcc@${PKG}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Codex size={15} /> Codex — <code className="text-fd-muted-foreground">mcx</code>
                  </div>
                  <Command code={`bunx mcx@${PKG_MCX}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Kimi size={15} /> Kimi — <code className="text-fd-muted-foreground">mkx</code>
                  </div>
                  <Command code={`bunx mkx@${PKG_MKX}`} />
                </div>
              </div>
            </Tab>
            <Tab value="npm">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <ClaudeCode size={15} /> Claude — <code className="text-fd-muted-foreground">mcc</code>
                  </div>
                  <Command code={`npx mcc@${PKG}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Codex size={15} /> Codex — <code className="text-fd-muted-foreground">mcx</code>
                  </div>
                  <Command code={`npx mcx@${PKG_MCX}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Kimi size={15} /> Kimi — <code className="text-fd-muted-foreground">mkx</code>
                  </div>
                  <Command code={`npx mkx@${PKG_MKX}`} />
                </div>
              </div>
            </Tab>
          </Tabs>
        </section>

        <section className="w-full max-w-5xl pb-24">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold mb-1">Run Agents With a UI</h2>
            <p className="text-fd-muted-foreground">Drive Macaron sessions from the browser and watch every turn as it happens.</p>
          </div>
          <Cards className="grid-cols-1 sm:grid-cols-3">
            <Card icon={<MonitorPlay />} title="Visual Sessions" href="/docs/usage">
              Browse workspaces and sessions with previews, then continue a turn from the browser.
            </Card>
            <Card icon={<MessagesSquare />} title="Live Chat" href="/docs/usage">
              Stream thinking, tool calls, and GenUI previews from supported agent runtimes.
            </Card>
            <Card icon={<SlidersHorizontal />} title="Provider Controls" href="/docs/usage">
              Run against an ambient login or a compatible endpoint such as Macaron, OpenRouter, or LiteLLM.
            </Card>
          </Cards>

          <div className="mt-12 mb-6">
            <h2 className="text-2xl font-semibold mb-1">Generate and Extend</h2>
            <p className="text-fd-muted-foreground">GenUI tooling and plugin manifests that plug into your existing agent setup.</p>
          </div>
          <Cards>
            <Card icon={<Wand2 />} title="genui-builder Skill" href="/docs/usage">
              The bundled skill lets supported agents produce GenUI TSX from the command line.
            </Card>
            <Card icon={<Puzzle />} title="Plugin Manifests" href="/docs">
              Ship the manifests that register Macaron Artifacts with Claude Code, Codex, and Kimi Code.
            </Card>
          </Cards>
        </section>
      </div>
    </HomeLayout>
  );
}
