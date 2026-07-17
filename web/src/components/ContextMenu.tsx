import { useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem =
  | { icon?: ReactNode; label: string; danger?: boolean; onClick: () => void }
  | 'separator';

type Props = {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
};

// Rendered via a portal on document.body so no ancestor with `will-change`,
// `transform`, `overflow`, or a stacking context can trap the fixed
// positioning. That fixes the case where a workspace tile draws over the
// sidebar's context menu labels.
export function ContextMenu({ items, x, y, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);

  const node = (
    <div className="ctx-menu" ref={ref} style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={'ctx-item' + (item.danger ? ' danger' : '')}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon && <span className="ctx-icon">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );

  return createPortal(node, document.body);
}
