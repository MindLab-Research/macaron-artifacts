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
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
