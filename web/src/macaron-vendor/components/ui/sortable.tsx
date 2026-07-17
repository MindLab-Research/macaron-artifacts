import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useLayoutEffect, useMemo, useState, type CSSProperties, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifiers,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, defaultAnimateLayoutChanges, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/style";

const SortableItemContext = createContext<{ attributes?: DraggableAttributes; listeners: DraggableSyntheticListeners | undefined; setActivatorNodeRef?: (element: HTMLElement | null) => void; registerHandle?: () => () => void; isDragging?: boolean; disabled?: boolean }>({
  listeners: undefined,
  isDragging: false,
  disabled: false,
});
const IsOverlayContext = createContext(false);
const SortableInternalContext = createContext<{ activeId: UniqueIdentifier | null; modifiers?: Modifiers; registerOverlay?: () => () => void }>({ activeId: null, modifiers: undefined });
const animateLayoutChanges: AnimateLayoutChanges = (args) => defaultAnimateLayoutChanges({ ...args, wasDragging: true });
const dropAnimationConfig: DropAnimation = { sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }) };
const resolveStrategy = (strategy: SortableStrategy | SortableLayout) => (strategy === "vertical" ? verticalListSortingStrategy : rectSortingStrategy);

export type SortableStrategy = "horizontal" | "vertical" | "grid";
export type SortableLayout = SortableStrategy | "nested";

export interface SortableProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, "onDragStart" | "onDragEnd"> {
  value: T[];
  onValueChange: (value: T[]) => void;
  getItemValue: (item: T) => string;
  children: ReactNode;
  layout?: SortableLayout;
  strategy?: SortableStrategy;
  onMove?: (event: { event: DragEndEvent; activeIndex: number; overIndex: number }) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  collisionDetection?: CollisionDetection;
  modifiers?: Modifiers;
  asChild?: boolean;
}

/**
 * Drag-and-drop sortable root for vertical lists, grids, and nested-looking groups. Children should be SortableItem elements keyed by getItemValue(item).
 * @param value Ordered items backing the rendered children.
 * @param onValueChange Receives reordered items after a completed drag unless onMove is supplied.
 * @param getItemValue Returns the stable string ID for each item.
 * @param layout Visual sorting layout; `nested` uses grid collision behavior and leaves nesting visuals to your markup.
 * @param collisionDetection Sort target detector; defaults to closestCenter so lists with gaps still reorder predictably.
 * @example <Sortable value={items} onValueChange={setItems} getItemValue={(item) => item.id}>{items.map((item) => <SortableItem key={item.id} value={item.id}><SortableItemHandle />{item.label}</SortableItem>)}</Sortable>
 * @see https://reui.io/docs/components/radix/sortable
 */
function Sortable<T>({ value, onValueChange, getItemValue, className, asChild = false, onMove, layout, strategy, onDragStart, onDragEnd, collisionDetection = closestCenter, modifiers, children, ...props }: SortableProps<T>) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [mounted, setMounted] = useState(false);
  const [customOverlayCount, setCustomOverlayCount] = useState(0);
  const resolvedStrategy = strategy ?? layout ?? "vertical";

  useLayoutEffect(() => setMounted(true), []);
  const registerOverlay = useCallback(() => {
    setCustomOverlayCount((count) => count + 1);
    return () => setCustomOverlayCount((count) => Math.max(0, count - 1));
  }, []);

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 10 } }), useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(event.active.id);
      onDragStart?.(event);
    },
    [onDragStart],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      onDragEnd?.(event);
      if (!over) return;
      const activeIndex = value.findIndex((item) => getItemValue(item) === active.id);
      const overIndex = value.findIndex((item) => getItemValue(item) === over.id);
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return;
      if (onMove) onMove({ event, activeIndex, overIndex });
      else onValueChange(arrayMove(value, activeIndex, overIndex));
    },
    [getItemValue, onDragEnd, onMove, onValueChange, value],
  );
  const itemIds = useMemo(() => value.map(getItemValue), [getItemValue, value]);
  const contextValue = useMemo(() => ({ activeId, modifiers, registerOverlay }), [activeId, modifiers, registerOverlay]);
  const overlayContent = useMemo(() => {
    if (!activeId) return null;
    let result: ReactNode = null;
    Children.forEach(children, (child) => {
      if (isValidElement(child) && (child.props as { value?: UniqueIdentifier }).value === activeId) result = cloneElement(child as ReactElement<{ className?: string }>, { className: cn((child.props as { className?: string }).className, "z-50") });
    });
    return result;
  }, [activeId, children]);
  const Comp = asChild ? Slot : "div";

  return (
    <SortableInternalContext.Provider value={contextValue}>
      <DndContext sensors={sensors} collisionDetection={collisionDetection} modifiers={modifiers} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveId(null)}>
        <SortableContext items={itemIds} strategy={resolveStrategy(resolvedStrategy)}>
          <Comp data-slot="sortable" data-dragging={activeId !== null} className={cn(activeId !== null && "cursor-grabbing", className)} {...props}>
            {children}
          </Comp>
        </SortableContext>
        {mounted && customOverlayCount === 0
          ? createPortal(
              <DragOverlay dropAnimation={dropAnimationConfig} modifiers={modifiers} className={cn("z-50", activeId && "cursor-grabbing")}>
                <IsOverlayContext.Provider value={true}>{overlayContent}</IsOverlayContext.Provider>
              </DragOverlay>,
              document.body,
            )
          : null}
      </DndContext>
    </SortableInternalContext.Provider>
  );
}

export interface SortableItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  disabled?: boolean;
  asChild?: boolean;
}

/** Draggable sortable item. Put one SortableItemHandle inside when only part of the row should start drags. */
function SortableItem({ value, className, asChild = false, disabled, children, style, ...props }: SortableItemProps) {
  const isOverlay = useContext(IsOverlayContext);
  const { setNodeRef, setActivatorNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({ id: value, disabled: disabled || isOverlay, animateLayoutChanges });
  const [handleCount, setHandleCount] = useState(0);
  const Comp = asChild ? Slot : "div";
  const registerHandle = useCallback(() => {
    setHandleCount((count) => count + 1);
    return () => setHandleCount((count) => Math.max(0, count - 1));
  }, []);
  const overlayContextValue = useMemo(() => ({ listeners: undefined, isDragging: true, disabled: false }), []);
  const itemContextValue = useMemo(() => ({ attributes, listeners, setActivatorNodeRef, registerHandle, isDragging, disabled }), [attributes, disabled, isDragging, listeners, registerHandle, setActivatorNodeRef]);
  if (isOverlay) {
    return (
      <SortableItemContext.Provider value={overlayContextValue}>
        <Comp data-slot="sortable-item" data-value={value} data-dragging={true} style={style} className={className} {...props}>
          {children}
        </Comp>
      </SortableItemContext.Provider>
    );
  }
  const sortableStyle = { ...style, transition, transform: CSS.Transform.toString(transform) } as CSSProperties;
  const itemActivatorProps = handleCount === 0 ? { ...attributes, ...listeners } : undefined;
  return (
    <SortableItemContext.Provider value={itemContextValue}>
      <Comp data-slot="sortable-item" data-value={value} data-dragging={isDragging} data-disabled={disabled} ref={setNodeRef} style={sortableStyle} {...itemActivatorProps} className={cn(isDragging && "z-50 opacity-50", disabled && "opacity-50", className)} {...props}>
        {children}
      </Comp>
    </SortableItemContext.Provider>
  );
}

export interface SortableItemHandleProps extends HTMLAttributes<HTMLDivElement> {
  cursor?: boolean;
  asChild?: boolean;
}

/** Drag handle for a SortableItem. Use asChild when the handle should be a button or icon-only control. */
function SortableItemHandle({ className, asChild = false, cursor = true, children, ...props }: SortableItemHandleProps) {
  const { attributes, listeners, setActivatorNodeRef, registerHandle, isDragging, disabled } = useContext(SortableItemContext);
  const Comp = asChild ? Slot : "div";
  useLayoutEffect(() => registerHandle?.(), [registerHandle]);
  return (
    <Comp data-slot="sortable-item-handle" data-dragging={isDragging} data-disabled={disabled} ref={setActivatorNodeRef} {...attributes} {...listeners} className={cn(cursor && (isDragging ? "cursor-grabbing" : "cursor-grab"), className)} {...props}>
      {children}
    </Comp>
  );
}

export interface SortableOverlayProps extends Omit<React.ComponentProps<typeof DragOverlay>, "children"> {
  children?: ReactNode | ((params: { value: UniqueIdentifier }) => ReactNode);
}

/** Optional custom overlay; omit it to use the default active child clone overlay. */
function SortableOverlay({ children, className, ...props }: SortableOverlayProps) {
  const { activeId, modifiers, registerOverlay } = useContext(SortableInternalContext);
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => setMounted(true), []);
  useLayoutEffect(() => registerOverlay?.(), [registerOverlay]);
  const content = activeId && children ? (typeof children === "function" ? children({ value: activeId }) : children) : null;
  if (!mounted) return null;
  return createPortal(
    <DragOverlay dropAnimation={dropAnimationConfig} modifiers={modifiers} className={cn("z-50", activeId && "cursor-grabbing", className)} {...props}>
      <IsOverlayContext.Provider value={true}>{content}</IsOverlayContext.Provider>
    </DragOverlay>,
    document.body,
  );
}

export { Sortable, SortableItem, SortableItemHandle, SortableOverlay };
