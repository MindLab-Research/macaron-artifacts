// Bootstrapper for the GenUI runtime — sets the __macaron_* globals the
// vendored sandbox shims re-export from at runtime, then re-exports
// GenuiPreview so the caller can render it. Split into its own module
// because the Claude bundle sets these globals at boot (see main.tsx) but
// the Codex bundle deliberately doesn't — this lets the Codex chat
// lazy-load the whole runtime the first time render_ui appears in a
// thread, keeping the default codex bundle small.
//
// Idempotent: if globals are already populated (e.g. we're inside the
// Claude bundle) we just re-export GenuiPreview without touching them.

import * as ReactNamespace from 'react';
import * as JSXRuntime from 'react/jsx-runtime';
import * as JSXDevRuntime from 'react/jsx-dev-runtime';
import * as ReactDOMNamespace from 'react-dom';
import * as MacaronUI from './macaron-vendor/macaron/source';
import * as MacaronCharts from './macaron-vendor/genui/charts';
import * as MacaronLucide from './macaron-vendor/genui/lucide-react';
import * as Motion from 'motion/react';

// UnoCSS runtime — the sandboxed TSX modules render Tailwind-style class
// strings at runtime (not present at build), so we need the runtime scanner
// to inject CSS as elements appear.
import initUnocssRuntime from '@unocss/runtime';
import presetWind3 from '@unocss/preset-wind3';
import presetAnimations from 'unocss-preset-animations';
import { unoTheme, unoShortcuts, unoRules } from './macaron-vendor/lib/standalone-uno';

// $macaron/ui primitives assume a Tailwind element reset (button/input/list
// normalize); without it native <button> UA borders leak through the
// preview. Loading these CSS files also has to happen once per session.
import '@unocss/reset/tailwind.css';
import './macaron-vendor/base.css';

const g = globalThis as unknown as Record<string, unknown>;

if (!g.__macaron_React) {
  g.__macaron_React = ReactNamespace;
  g.__macaron_JSXRuntime = JSXRuntime;
  g.__macaron_JSXDevRuntime = JSXDevRuntime;
  g.__macaron_ReactDOM = ReactDOMNamespace;
  g.__macaron_UI = MacaronUI;
  g.__macaron_Charts = MacaronCharts;
  g.__macaron_Lucide = MacaronLucide;
  g.__macaron_Motion = Motion;

  initUnocssRuntime({
    defaults: {
      presets: [presetWind3({ dark: 'class' }), presetAnimations()],
      theme: unoTheme,
      shortcuts: unoShortcuts,
      rules: unoRules,
    },
  });
}

export { GenuiPreview } from './components/GenuiPreview';
