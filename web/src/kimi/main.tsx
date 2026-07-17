// Kimi WebUI entry. Separate from the claude entry so it doesn't pull in
// the GenUI runtime, macaron-vendor, UnoCSS, etc. This bundle stays small
// and focused on chat.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { KimiApp } from './KimiApp';
import { KimiChat } from './KimiChat';
import { KimiSettings } from './KimiSettings';
import { KimiWorkspace } from './KimiWorkspace';
import { AuthGate } from '../components/AuthGate';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/Confirm';
import { consumeHandoff } from '../lib/auth';
import { registerServiceWorker } from '../lib/pwa';
import './styles.css';
import '../chat-code.css';

// Pick up the hosted-mode handoff (docs connect page stashed {server, token}
// same-tab in sessionStorage). The handoff binds the token to its server origin;
// nothing secret rides the URL.
consumeHandoff();

const router = createHashRouter([
  {
    path: '/',
    element: <KimiApp />,
    children: [
      { index: true, element: <KimiChat /> },
      { path: 't/:sid', element: <KimiChat /> },
      { path: 'w/:project', element: <KimiWorkspace /> },
      { path: 'w/:project/t/:sid', element: <KimiWorkspace /> },
      { path: 'settings', element: <KimiSettings /> },
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
