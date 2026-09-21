import type { CSSProperties } from 'react';
import { Toaster } from 'sonner';
import { useTheme } from '../theme/ThemeProvider';

export function Notifications() {
  const { appearance } = useTheme();
  return <Toaster className="app-notifications" theme={appearance.dark ? 'dark' : 'light'} position="top-right" offset={{ top: 64, left: 24, right: 24 }} mobileOffset={{ top: 64, left: 24, right: 24 }} closeButton customAriaLabel="通知" toastOptions={{ closeButtonAriaLabel: '关闭通知', style: { boxShadow: '0 4px 12px var(--widget-shadow)' }, classNames: { content: 'min-w-0 break-words', description: 'break-words' } }} style={{ '--normal-bg': 'var(--widget-bg)', '--normal-bg-hover': 'var(--widget-hover)', '--normal-text': 'var(--widget-fg)', '--normal-border': 'var(--widget-border)' } as CSSProperties} />;
}
