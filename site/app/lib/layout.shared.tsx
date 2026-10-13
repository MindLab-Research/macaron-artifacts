import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { PaletteSwitch } from '@/components/palette';

export function baseOptions(): BaseLayoutProps {
  return {
    slots: { themeSwitch: PaletteSwitch },
    nav: {
      // JSX supported
      title: appName,
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'UI4A Paper', url: 'https://www.mindlab.im/updates/ui4a-a-component-native-harness-for-generative-ui', external: true },
      { text: 'Playground', url: 'https://genui.macaron.im', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
