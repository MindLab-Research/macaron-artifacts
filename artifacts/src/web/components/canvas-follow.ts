import { createScrollFollow } from './code/scroll-follow';

/** Source and rendered UI share one viewport, but the first preview starts a new reading position. */
export function createCanvasFollow(viewport: HTMLElement, content: HTMLElement, streaming: boolean, waitForRender = true) {
  let live = streaming, pending = streaming && waitForRender;
  viewport.scrollTop = 0;
  const follow = createScrollFollow(viewport, { following: live, enabled: () => live || pending, resumeWhenContentFits: false });
  const observer = new ResizeObserver(() => follow.update());
  observer.observe(viewport); observer.observe(content);
  follow.update();
  return {
    update(streaming: boolean) {
      const started = !live && streaming, finished = live && !streaming;
      live = streaming;
      if (started) pending = waitForRender;
      if (finished && !pending) follow.finish();
      else if (started) follow.grow();
      else follow.update();
    },
    preview: follow.reset,
    // Tool completion can precede the final asynchronous compile and its layout change.
    rendered() { pending = false; if (!live) follow.finish(); },
    destroy() { observer.disconnect(); follow.destroy(); },
  };
}
