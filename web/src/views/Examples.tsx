// Examples gallery — curated seed prompts that showcase what render_ui +
// sendUserMessage can do when the model uses them well. Each card's Try
// button stashes the prompt via setPendingPrompt(project, ...) and lands
// on /w/<project>, where Workspace's auto-draft picks the seed up and
// Session's isNew branch auto-sends it.

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, Calendar, Compass, FolderTree, Moon, Palette, PenLine, Settings } from 'lucide-react';
import { api } from '../lib/api';
import type { Workspace } from '@macaron/shared';
import { setPendingPrompt } from '../lib/newSession';

type Example = {
  id: string;
  icon: ReactNode;
  title: string;
  blurb: string;
  category: 'interactive' | 'preview' | 'data';
  prompt: string;
};

const EXAMPLES: Example[] = [
  // ---- Interactive (asks the user something → click to answer) ----
  {
    id: 'framework-picker',
    icon: <Compass size={20} aria-hidden="true" />,
    title: 'Pick a framework',
    blurb: 'A/B/C decision as clickable cards — no typing back.',
    category: 'interactive',
    prompt:
      "I'm starting a new web project — help me pick between Next.js / Vite+React / Remix / Astro. " +
      'Use render_ui to draw a comparison card: one column per candidate, listing where it fits ' +
      '(SSR / SPA / static site), ecosystem activity, learning curve, deploy story. ' +
      'Below, four Buttons — clicking one calls sendUserMessage with "Start the project with <framework>", ' +
      "carrying the original context (\"new web project\") so the next turn has everything it needs.",
  },
  {
    id: 'config-wizard',
    icon: <Settings size={20} aria-hidden="true" />,
    title: 'Service config wizard',
    blurb: 'Structured form → posts a JSON payload back.',
    category: 'interactive',
    prompt:
      'Help me draft the initial config for a new service. Use render_ui to render a form card with fields: ' +
      'service name (Input), port (Input number, default 8080), Node version (Select: 18/20/22), ' +
      'enable SSL (Switch), log level (RadioGroup: debug/info/warn/error), max concurrency (Slider 1-200). ' +
      'The submit Button onClick should call sendUserMessage with a one-sentence summary + a fenced JSON ' +
      'block containing every field, so the next turn can read the structured data directly.',
  },
  {
    id: 'destructive-confirm',
    icon: <AlertTriangle size={20} aria-hidden="true" />,
    title: 'Destructive confirm',
    blurb: 'Diff summary + Apply / Cancel buttons.',
    category: 'interactive',
    prompt:
      "Pretend I asked you to clean up every node_modules directory in the project. Do NOT actually run anything — " +
      'this is a demo. Use render_ui to draw a confirmation card, red warning styling, listing 12 plausible ' +
      'candidate paths in the middle. Bottom row: a grey Cancel button + a destructive red "Delete 12 folders" ' +
      'button. On click, each calls sendUserMessage with "cancel" or "confirmed, do it" respectively.',
  },

  // ---- UI Change Previews (ui-preview skill in action) ----
  {
    id: 'redesign-statusbar',
    icon: <Palette size={20} aria-hidden="true" />,
    title: 'Redesign StatusBar',
    blurb: 'Read source → preview redesign → Apply writes files.',
    category: 'preview',
    prompt:
      'Read web/src/components/StatusBar.tsx, then follow the ui-preview skill: ' +
      'render_ui a full preview of the redesigned StatusBar (more compact, gradient status dots, unified ' +
      'font sizes, context-usage and permission-mode collapsed into two small badges instead of plain text), ' +
      'with three buttons at the bottom — Apply / Tweak / Discard. Do NOT touch the file until I click Apply.',
  },
  {
    id: 'copy-variants',
    icon: <PenLine size={20} aria-hidden="true" />,
    title: 'Landing copy A/B/C',
    blurb: 'Three hero variants side-by-side; click your favorite.',
    category: 'preview',
    prompt:
      'Draft hero copy for a hypothetical AI coding IDE. Use render_ui to render a 3-column card, each ' +
      'column a different tone: (1) minimalist and direct, (2) emotional, (3) developer-insider. ' +
      'Below each column, a "Use this" button that calls sendUserMessage with "Go with variant X (full copy)". ' +
      'That way the next turn can iterate on the chosen variant or ship it into the landing component.',
  },
  {
    id: 'dark-mode-preview',
    icon: <Moon size={20} aria-hidden="true" />,
    title: 'Dark mode preview',
    blurb: 'Toggle-driven color scheme preview with Apply.',
    category: 'preview',
    prompt:
      'Read web/src/views/Home.tsx and use render_ui to build a "dark mode preview" card: ' +
      'up top, a mini mock of the page (logo + composer + button + a line of text); below, a Switch ' +
      'labelled "Dark mode" that recolours the mock live via useState. At the bottom, Apply / Discard buttons — ' +
      'Apply calls sendUserMessage with "Apply this dark palette to the Home page for real". ' +
      "Do NOT edit the file yet — wait for my Apply click.",
  },

  // ---- Data & status ----
  {
    id: 'csv-visualize',
    icon: <BarChart3 size={20} aria-hidden="true" />,
    title: 'Visualize this CSV',
    blurb: 'Paste tabular data, get a chart + summary.',
    category: 'data',
    prompt:
      'Make up 168 rows of "hourly API request volume over the past 7 days" (weekday peaks + weekend dips + ' +
      "one spike). Use render_ui to render a dashboard: 4 Stats on top (total / peak / mean / peak-to-trough ratio), " +
      'a LineChart of the time series below, a PieChart on the right breaking it down by endpoint, and one ' +
      'AI-generated "insight" sentence at the bottom. Use the Chart components from macaron-ui.',
  },
  {
    id: 'git-summary',
    icon: <Calendar size={20} aria-hidden="true" />,
    title: 'This week in commits',
    blurb: 'git log → dashboard: commits, files, contributors.',
    category: 'data',
    prompt:
      'Run `git log --since="7 days ago" --pretty=format:"%h|%an|%ad|%s" --date=short --shortstat` in Bash ' +
      "to fetch this repo's last 7 days of commits. Then render_ui a weekly-report card: a Stat grid on top " +
      '(commits / files changed / lines +/-/ contributors), a Timeline of the main commits grouped by day ' +
      'below, and a PillRow of top contributors on the right. ' +
      'Add a button "Write as Markdown weekly report" — on click, sendUserMessage tells the next turn to ' +
      'draft the markdown and drop it into docs/weekly-2026-Wxx.md.',
  },
  {
    id: 'file-explorer',
    icon: <FolderTree size={20} aria-hidden="true" />,
    title: 'Project file map',
    blurb: 'Read the workspace tree into a visual explorer.',
    category: 'data',
    prompt:
      'Run `find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -200` ' +
      'in Bash to sample the file tree. Group by extension (.tsx / .ts / .css / .md / .json / other) and ' +
      'render_ui a StatGrid: one tile per type showing file count + total LOC (a rough wc -l sampling is fine). ' +
      'Below, a Table of the 10 largest files (by line count), each row with a "View" button that ' +
      'sendUserMessage "Open <file>" so I can drill in next turn.',
  },
];

const CATEGORY_LABEL: Record<Example['category'], string> = {
  interactive: 'Interactive (buttons / forms / picker)',
  preview: 'UI change previews',
  data: 'Data & status',
};

export function Examples() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [target, setTarget] = useState<string>('');
  const navigate = useNavigate();

  useEffect(() => {
    api.workspaces().then((r) => {
      setWorkspaces(r.workspaces);
      if (r.workspaces.length > 0 && !target) setTarget(r.workspaces[0]!.project);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runExample = (ex: Example) => {
    if (!target) return;
    setPendingPrompt(target, ex.prompt);
    navigate(`/w/${encodeURIComponent(target)}`);
  };

  const grouped = groupBy(EXAMPLES, (e) => e.category);

  return (
    <div className="examples-view">
      <div className="examples-head">
        <div>
          <h1 className="examples-title">Examples</h1>
          <p className="examples-sub">
            Curated prompts that show what <code>render_ui</code> + <code>sendUserMessage</code> can do
            when Macaron uses them well. Pick a workspace, click Try — a new session opens with the
            prompt seeded and the model responds with a live widget you can click / fill / submit.
          </p>
        </div>
        <label className="examples-target">
          <span>Run in</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {workspaces.length === 0 && <option value="">No workspaces yet</option>}
            {workspaces.map((w) => (
              <option key={w.project} value={w.project}>{w.name}</option>
            ))}
          </select>
        </label>
      </div>

      {(['interactive', 'preview', 'data'] as const).map((cat) => {
        const items = grouped.get(cat) ?? [];
        if (items.length === 0) return null;
        return (
          <section className="examples-section" key={cat}>
            <h2 className="examples-section-title">{CATEGORY_LABEL[cat]}</h2>
            <div className="examples-grid">
              {items.map((ex) => (
                <article className="example-card" key={ex.id}>
                  <div className="example-card-emoji">{ex.icon}</div>
                  <div className="example-card-body">
                    <h3 className="example-card-title">{ex.title}</h3>
                    <p className="example-card-blurb">{ex.blurb}</p>
                    <details className="example-card-details">
                      <summary>Show prompt</summary>
                      <pre>{ex.prompt}</pre>
                    </details>
                  </div>
                  <button
                    className="example-card-try"
                    onClick={() => runExample(ex)}
                    disabled={!target}
                    title={target ? `Try in ${target}` : 'Pick a workspace first'}
                  >
                    Try <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const t of arr) {
    const k = key(t);
    const bucket = m.get(k);
    if (bucket) bucket.push(t);
    else m.set(k, [t]);
  }
  return m;
}
