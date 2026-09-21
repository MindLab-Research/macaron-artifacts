import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useState, type RefObject } from 'react';
import { Copy, Download, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { downloadHtml, snapshotHtml } from '../ui4a/export';

export function ExportMenu({ target, filename = 'macaron-card', disabled = false, kind = 'surface' }: { target: RefObject<HTMLElement | null>; filename?: string; disabled?: boolean; kind?: 'surface' | 'chat' }) {
  const label = kind === 'chat' ? '对话 HTML' : ' HTML 快照';
  const [busy, setBusy] = useState(false);
  const run = async (copy: boolean) => {
    setBusy(true);
    const notification = toast.loading(copy ? '正在复制 HTML…' : '正在导出 HTML…', { description: filename, dismissible: false });
    let preparationError: unknown;
    try {
      const surface = target.current?.querySelector<HTMLElement>(kind === 'chat' ? '[data-chat-content]' : '[data-ui4a-ready="true"]');
      if (!surface || disabled) throw new Error('预览尚未就绪，请稍后重试');
      if (copy && !navigator.clipboard) throw new Error('浏览器不支持复制，请下载 HTML');
      const html = kind === 'chat' ? import('../chat/export').then(module => module.chatHtml(surface, filename)).catch(error => { preparationError = error; throw error; }) : snapshotHtml(surface, filename);
      if (copy) {
        // Start the clipboard operation during the click, even when chat highlighting completes asynchronously.
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({ 'text/plain': Promise.resolve(html).then(text => new Blob([text], { type: 'text/plain' })) })]);
        else await navigator.clipboard.writeText(await html);
      } else downloadHtml(await html, filename);
      toast.success(copy ? '已复制 HTML' : '已下载 HTML', { id: notification, description: filename, dismissible: true });
    } catch (error) { const reason = preparationError ?? error; toast.error(copy ? '复制失败' : '导出失败', { id: notification, description: reason instanceof Error ? reason.message : '请稍后重试', duration: Infinity, dismissible: true }); }
    finally { setBusy(false); }
  };
  return <Menu as="div" className="shrink-0">
      <MenuButton type="button" title={disabled ? kind === 'chat' ? '对话完成后可导出' : '预览完成后可导出' : `导出${label}`} aria-label={`导出${label}`} aria-busy={busy} disabled={disabled || busy} className="export-trigger btn-icon size-9 rounded-md data-[open]:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Download aria-hidden className="size-4" />}</MenuButton>
      <MenuItems anchor={{ to: 'bottom end', gap: 6, padding: 8 }} className="theme-menu z-popover w-44 max-w-[calc(100vw-16px)] rounded-lg p-1 outline-none">
        <MenuItem><button type="button" onClick={() => void run(false)} className="export-menu-item menu-item min-h-10 w-full rounded-md px-3 py-2 text-left"><Download aria-hidden className="size-4 shrink-0" />下载{label}</button></MenuItem>
        <MenuItem><button type="button" onClick={() => void run(true)} className="export-menu-item menu-item min-h-10 w-full rounded-md px-3 py-2 text-left"><Copy aria-hidden className="size-4 shrink-0" />复制{label}</button></MenuItem>
      </MenuItems>
    </Menu>;
}
