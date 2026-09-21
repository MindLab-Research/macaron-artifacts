/** Capture the visible result, never the generated module or its privileged host bridges. */
export function snapshotHtml(surface: HTMLElement, title: string): string {
  return `<!doctype html>\n${snapshotDocument(surface, title).documentElement.outerHTML}`;
}

export function snapshotDocument(surface: HTMLElement, title: string, kind: 'surface' | 'chat' = 'surface'): Document {
  const sourceDocument = surface.ownerDocument;
  const output = sourceDocument.implementation.createHTMLDocument(title);
  const root = sourceDocument.documentElement;
  for (const name of ['lang', 'dir', 'data-theme', 'style']) { const value = root.getAttribute(name); if (value !== null) output.documentElement.setAttribute(name, value); }
  const charset = output.createElement('meta'); charset.setAttribute('charset', 'utf-8'); output.head.prepend(charset);
  const viewport = output.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; output.head.append(viewport);
  const policy = output.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"; output.head.append(policy);
  for (const sheet of sourceDocument.styleSheets) {
    if (sheet.disabled) continue;
    const style = output.createElement('style');
    try { style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n').replace(/</g, '\\3c '); }
    catch {
      if (!sheet.href) throw new Error('部分样式无法读取，暂时无法导出完整 HTML');
      const link = output.createElement('link'); link.rel = 'stylesheet'; link.href = sheet.href; link.media = sheet.media.mediaText; output.head.append(link); continue;
    }
    style.media = sheet.media.mediaText; output.head.append(style);
  }
  // App chrome locks body scrolling; exported documents need their own scrollable viewport.
  const layout = output.createElement('style'); layout.textContent = `html,body{height:auto;min-height:100%;overflow:auto}body{margin:0;container-type:inline-size}${kind === 'surface' ? '.ui4a-surface{min-height:100vh}' : '[data-chat-content] [hidden]{display:none!important}'}`; output.head.append(layout);
  const clone = surface.cloneNode(true) as HTMLElement;
  // Canvas inherits a panel palette that is different from the document palette.
  const computed = sourceDocument.defaultView!.getComputedStyle(surface);
  for (const name of computed) if (name.startsWith('--') || ['color', 'font-family', 'font-size', 'line-height', 'color-scheme'].includes(name)) clone.style.setProperty(name, computed.getPropertyValue(name));
  const originals = [surface, ...surface.querySelectorAll('*')], copies = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!, copy = copies[index]!;
    if (kind === 'chat' && original.scrollTop) copy.setAttribute('data-export-scroll-top', String(original.scrollTop));
    if (original instanceof HTMLInputElement) {
      if (original.type === 'password' || original.type === 'file') copy.removeAttribute('value');
      else copy.setAttribute('value', original.value);
      copy.toggleAttribute('checked', original.checked);
    }
    if (original instanceof HTMLTextAreaElement) copy.textContent = original.value;
    if (original instanceof HTMLOptionElement) copy.toggleAttribute('selected', original.selected);
    if (original instanceof HTMLCanvasElement) {
      const image = output.createElement('img');
      for (const attribute of copy.attributes) image.setAttribute(attribute.name, attribute.value);
      try { image.src = original.toDataURL(); } catch { throw new Error('画布包含无法读取的图片，请等待图片加载或检查跨域权限'); }
      image.width = original.width; image.height = original.height; copy.replaceWith(image);
    }
    if (original instanceof HTMLImageElement) {
      copy.removeAttribute('srcset'); copy.removeAttribute('sizes');
      const src = original.currentSrc || original.src;
      if (src.startsWith('blob:')) {
        if (!original.complete || !original.naturalWidth) throw new Error('图片尚未加载完成，请稍后重试');
        const canvas = sourceDocument.createElement('canvas'); canvas.width = original.naturalWidth; canvas.height = original.naturalHeight;
        try { canvas.getContext('2d')!.drawImage(original, 0, 0); copy.setAttribute('src', canvas.toDataURL()); } catch { throw new Error('无法读取图片，请检查图片的跨域权限'); }
      } else copy.setAttribute('src', src);
    }
    if (original instanceof HTMLAnchorElement && original.getAttribute('href') && !original.getAttribute('href')!.startsWith('#')) copy.setAttribute('href', original.href);
    if (original instanceof HTMLMediaElement || original instanceof HTMLSourceElement) {
      if (original.src.startsWith('blob:')) throw new Error('临时音视频无法导出，请先使用可访问的媒体链接');
      if (original.getAttribute('src')) copy.setAttribute('src', original.src);
    }
    if (original instanceof HTMLVideoElement && original.poster) copy.setAttribute('poster', original.poster);
    for (const attribute of [...copy.attributes]) if (/^on/i.test(attribute.name) || ['data-ui4a-scope', 'data-ui4a-streaming', 'data-ui4a-ready'].includes(attribute.name)) copy.removeAttribute(attribute.name);
  }
  // The selected picture is already captured in img.currentSrc; old source sets can override it when reopened.
  clone.querySelectorAll('script, iframe, object, embed, picture source, [data-export-control]').forEach(node => node.remove());
  output.body.append(clone);
  return output;
}

export function downloadHtml(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.+$/, '').slice(0, 120) || 'macaron-card'}.html`;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
