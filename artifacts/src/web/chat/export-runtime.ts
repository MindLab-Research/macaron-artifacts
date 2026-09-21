/** This function is serialized into the download. Keep it self-contained and limited to host transcript controls. */
export function initializeChatExport() {
  const hostElements = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)].filter(element => !element.closest('.ui4a-surface'));
  const updates: (() => void)[] = [];
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; for (const update of updates) update(); }); };
  const observer = new ResizeObserver(schedule);
  const restoreScroll = (element: HTMLElement) => {
    if (element.clientHeight && element.dataset.exportScrollTop) { element.scrollTop = Number(element.dataset.exportScrollTop); delete element.dataset.exportScrollTop; }
  };
  for (const section of hostElements('[data-export-collapsible]')) {
    const scroller = section.querySelector<HTMLElement>('[data-export-scroller]');
    const content = section.querySelector<HTMLElement>('[data-export-content]');
    if (!scroller || !content) continue;
    const cap = Number(section.dataset.exportCap), ramp = Number(section.dataset.exportRamp), reveal = Number(section.dataset.exportReveal);
    const toggles = [...section.querySelectorAll<HTMLButtonElement>(':scope > [data-export-toggle]')];
    const pointerMotion = () => section.removeAttribute('data-keyboard');
    section.addEventListener('pointerdown', pointerMotion, { capture: true });
    section.addEventListener('wheel', pointerMotion, { passive: true });
    const update = () => {
      const height = content.getBoundingClientRect().height;
      if (!height) return; // Closed native details are measured when they open, not frozen at zero height.
      const overflowing = height > cap, collapsed = overflowing && section.dataset.exportOpen !== 'true';
      scroller.tabIndex = collapsed ? 0 : -1;
      scroller.style.height = `${collapsed ? cap : height}px`;
      restoreScroll(scroller);
      const ratio = (value: number) => Math.round(Math.min(1, Math.max(0, value / ramp)) * 50) / 50;
      const top = collapsed ? ratio(scroller.scrollTop) : 0, bottom = collapsed ? ratio(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0;
      section.style.setProperty('--fade-top', String(top)); section.style.setProperty('--fade-bottom', String(bottom));
      for (const button of toggles) {
        const fallback = collapsed && top <= reveal && bottom <= reveal && button.dataset.exportToggle === 'bottom';
        button.toggleAttribute('data-export-fallback', fallback);
        button.hidden = !fallback && (button.dataset.exportToggle === 'collapse' ? !(overflowing && !collapsed) : !collapsed || (button.dataset.exportToggle === 'top' ? top : bottom) <= reveal);
        button.setAttribute('aria-expanded', String(!collapsed));
      }
    };
    for (const button of toggles) button.addEventListener('click', event => {
      const keyboard = event.detail === 0, ownsFocus = document.activeElement === button;
      section.toggleAttribute('data-keyboard', keyboard);
      section.dataset.exportOpen = String(button.dataset.exportToggle !== 'collapse');
      update();
      if (ownsFocus) {
        const next = toggles.find(item => !item.hidden) ?? scroller;
        if (next === scroller) scroller.tabIndex = -1;
        next.focus({ preventScroll: !keyboard });
      }
    });
    updates.push(update); scroller.addEventListener('scroll', schedule, { passive: true });
    observer.observe(content); observer.observe(scroller);
  }
  for (const section of hostElements('.reasoning')) {
    const viewport = section.querySelector<HTMLElement>('.reasoning-viewport');
    const content = section.querySelector<HTMLElement>('.reasoning-content');
    if (!viewport || !content) continue;
    const update = () => {
      restoreScroll(viewport);
      const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
      viewport.style.setProperty('--reasoning-fade-top', String(Math.min(1, viewport.scrollTop / 24)));
      viewport.style.setProperty('--reasoning-fade-bottom', String(Math.min(1, bottom / 24)));
      if (viewport.scrollHeight > viewport.clientHeight + 2) viewport.tabIndex = 0; else viewport.removeAttribute('tabindex');
    };
    const button = section.querySelector<HTMLButtonElement>('[data-export-reasoning-toggle]');
    button?.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open)); button.toggleAttribute('data-open', open);
      button.title = open ? '仅显示最新摘要' : '查看先前摘要';
      button.querySelector('span')!.textContent = open ? '仅显示最新' : `${button.dataset.reasoningCount} 段摘要`;
      for (const entry of section.querySelectorAll<HTMLElement>('[data-reasoning-entry]')) {
        entry.hidden = !open && entry.dataset.reasoningLatest !== 'true';
      }
      if (!open) viewport.scrollTop = viewport.scrollHeight;
      update();
    });
    updates.push(update); viewport.addEventListener('scroll', schedule, { passive: true });
    observer.observe(content); observer.observe(viewport);
  }
  document.addEventListener('toggle', schedule, true);
  document.addEventListener('load', schedule, true);
  schedule();
}
