// Codex WebUI entry. Separate from the claude entry so it doesn't pull in
// the GenUI runtime, macaron-vendor, UnoCSS, etc. This bundle stays small
// and focused on chat.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { CodexApp } from './CodexApp';
import { CodexChat } from './CodexChat';
import { CodexSettings } from './CodexSettings';
import { CodexWorkspace } from './CodexWorkspace';
import { AuthGate } from '../components/AuthGate';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/Confirm';
import { consumeHandoff } from '../lib/auth';
import { registerServiceWorker } from '../lib/pwa';
// Engine-agnostic pages (user-scope APIs) reused from the Claude bundle so
// Codex users get the same management surface without a parallel rewrite.
// Anything that touches ~/.claude/projects or Claude-only session shape
// (Dashboard, ShareView, per-workspace Hooks) is skipped intentionally.
import { Skills } from '../views/Skills';
import { Mcp } from '../views/Mcp';
import { Agents } from '../views/Agents';
import { Prompts } from '../views/Prompts';
import { Schedules } from '../views/Schedules';
import { Analytics } from '../views/Analytics';
import { Examples } from '../views/Examples';
import { Hooks } from '../views/Hooks';
import { FileExplorer } from '../views/FileExplorer';
import './styles.css';
import '../chat-code.css';
// Claude-side stylesheet, needed because the borrowed views under `../views/`
// (Analytics, Examples, Skills, …) style themselves with class names defined
// only in the Claude bundle (`.examples-*`, `.heatmap-*`, `.ti-*`, `.ws-*`).
// Codex's own `.cx-*` scope is disjoint from those, so importing after the
// Codex sheet is safe — no class collisions.
import '../styles.css';

// Pick up the hosted-mode handoff (docs connect page stashed {server, token}
// same-tab in sessionStorage). The handoff binds the token to its server origin;
// nothing secret rides the URL.
consumeHandoff();

const router = createHashRouter([
  {
    path: '/',
    element: <CodexApp />,
    children: [
      { index: true, element: <CodexChat /> },
      { path: 't/:sid', element: <CodexChat /> },
      { path: 'w/:project', element: <CodexWorkspace /> },
      { path: 'w/:project/t/:sid', element: <CodexWorkspace /> },
      { path: 'w/:project/files', element: <FileExplorer /> },
      { path: 'settings', element: <CodexSettings /> },
      // Engine-agnostic management surfaces — same components + same server
      // routes as the Claude bundle. Codex users get skills/mcp/agents/…
      // parity without a parallel rewrite; the pages touch user-scope config
      // (~/.claude/skills, ~/.claude/agents, plugin's own bookkeeping) that
      // both engines share on the same machine.
      { path: 'examples', element: <Examples /> },
      { path: 'usage', element: <Analytics /> },
      { path: 'prompts', element: <Prompts /> },
      { path: 'agents', element: <Agents /> },
      { path: 'skills', element: <Skills /> },
      { path: 'mcp', element: <Mcp /> },
      { path: 'hooks', element: <Hooks /> },
      { path: 'schedules', element: <Schedules /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </AuthGate>
  </React.StrictMode>,
);

registerServiceWorker();
