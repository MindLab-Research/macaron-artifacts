import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ElementType,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, MotionConfig, motion, type Transition, type Variant } from "motion/react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { Checkbox } from "@/components/ui/checkbox";
import { FileUpload } from "@/components/ui/file-upload";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Sortable, SortableItem, SortableItemHandle, SortableOverlay } from "@/components/ui/sortable";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "@/components/ui/timeline";
import { getProgressiveBlurLayerStyle } from "@/lib/progressiveBlur";
import { cn } from "@/lib/style";
import NumberFlowBase, { continuous as numberFlowContinuous } from "@number-flow/react";
import { ArrowLeft, Search, User, X } from "lucide-react";

export {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
  Badge,
  Button,
  Calendar,
  CalendarDayButton,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  Checkbox,
  FileUpload,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Label,
  numberFlowContinuous,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Separator,
  Slider,
  Sortable,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
};
// Re-export motion / AnimatePresence through the host module. Bare motion/react can fall back to esm.sh in prod, pull a second React runtime, and crash hooks.
export { AnimatePresence, motion } from "motion/react";
export { REGEXP_ONLY_CHARS, REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
export type { CarouselApi } from "@/components/ui/carousel";

/**
 * Animated numeric value for counters, prices, totals, ratings, scores, percentages, and other changing numbers. Use plain text for compact ratios like "2 / 4". Large values at text-[28px] or larger need min-w-[9ch] and tabular-nums or their own full row.
 * @param prefix Put currency or leading units here instead of concatenating strings around the component.
 * @param suffix Put percent signs or trailing units here instead of concatenating strings around the component.
 */
export function NumberFlow(props: React.ComponentProps<typeof NumberFlowBase>) {
  return <NumberFlowBase {...props} />;
}

const GAP_CLASS = { none: "gap-0", xs: "gap-1", sm: "gap-2", md: "gap-3", lg: "gap-4", xl: "gap-6" } as const;
const NUMERIC_GAP_CLASS = { 0: "gap-0", 1: "gap-1", 2: "gap-2", 3: "gap-3", 4: "gap-4", 5: "gap-5", 6: "gap-6" } as const;
const PADDING_CLASS = { 0: "p-0", 1: "p-1", 2: "p-2", 3: "p-3", 4: "p-4", 5: "p-5", 6: "p-6" } as const;
const ALIGN_CLASS = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch", baseline: "items-baseline" } as const;
const JUSTIFY_CLASS = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between", around: "justify-around", evenly: "justify-evenly" } as const;
const GRID_COL_CLASS = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" } as const;
const GRID_BREAKPOINT_COL_CLASS = {
  sm: { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" },
  md: { 1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" },
  lg: { 1: "lg:grid-cols-1", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" },
  xl: { 1: "xl:grid-cols-1", 2: "xl:grid-cols-2", 3: "xl:grid-cols-3", 4: "xl:grid-cols-4" },
} as const;

type GapSize = keyof typeof GAP_CLASS;
type NumericSpacing = keyof typeof NUMERIC_GAP_CLASS;
type PaddingSize = keyof typeof PADDING_CLASS;
type Align = keyof typeof ALIGN_CLASS;
type Justify = keyof typeof JUSTIFY_CLASS;
type GridColumnCount = keyof typeof GRID_COL_CLASS;
type GridColumns = GridColumnCount | { base?: GridColumnCount; sm?: GridColumnCount; md?: GridColumnCount; lg?: GridColumnCount; xl?: GridColumnCount };
type SelectionGridItem = { label: ReactNode; value: string };
type GapValue = GapSize | NumericSpacing;
type TextTone = "default" | "muted" | "accent";
type TextProps = PropsWithChildren<{ tone?: TextTone; color?: TextTone; size?: "xs" | "sm" | "md" | "lg" | "xl"; weight?: "normal" | "medium" | "semibold" | "bold"; className?: string }>;
type DisclosureMotionVariant = { opacity?: number; scale?: number; x?: number; y?: number; filter?: string };
type DisclosureVariants = { expanded?: DisclosureMotionVariant; collapsed?: DisclosureMotionVariant };
type DisclosureTransition = { duration?: number; delay?: number };
type DisclosureContextValue = { open: boolean; toggle: () => void; contentId: string; variants?: DisclosureVariants; transition?: DisclosureTransition };
type TextShimmerProps = { children: string; as?: ElementType; className?: string; duration?: number; spread?: number };
type TextMorphProps = { children: string; as?: ElementType; className?: string; style?: CSSProperties; transition?: { duration?: number; delay?: number } };
type TextLoopVariant = { y?: number; opacity?: number; filter?: string; rotateX?: number; scale?: number };
type TextLoopProps = PropsWithChildren<{ className?: string; interval?: number; transition?: { duration?: number }; variants?: { initial?: TextLoopVariant; animate?: TextLoopVariant; exit?: TextLoopVariant }; onIndexChange?: (index: number) => void; trigger?: boolean; mode?: "sync" | "popLayout" | "wait" }>;
type GlowEffectMode = "rotate" | "pulse" | "breathe" | "colorShift" | "flowHorizontal" | "static";
type GlowEffectBlur = number | "softest" | "soft" | "medium" | "strong" | "stronger" | "strongest" | "none";
type GlowEffectProps = { className?: string; style?: CSSProperties; colors?: string[]; mode?: GlowEffectMode; blur?: GlowEffectBlur; transition?: { duration?: number }; scale?: number; duration?: number };
type SpinningTextProps = { children: string; style?: CSSProperties; duration?: number; className?: string; reverse?: boolean; fontSize?: number; radius?: number; transition?: { duration?: number } };
type TiltSpringOptions = { stiffness?: number; damping?: number; mass?: number };
type TiltProps = PropsWithChildren<HTMLAttributes<HTMLDivElement> & { rotationFactor?: number; isReverse?: boolean; springOptions?: TiltSpringOptions }>;
type ToolbarDynamicProps = { className?: string; style?: CSSProperties; compact?: ReactNode; expanded?: ReactNode; placeholder?: string; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; collapsedWidth?: number | string; expandedWidth?: number | string };
type ProgressiveBlurDirection = "top" | "right" | "bottom" | "left";
type ProgressiveBlurProps = { direction?: ProgressiveBlurDirection; blurLayers?: number; className?: string; blurIntensity?: number };
type MorphingDialogTransition = Transition;
type MorphingDialogVariants = { initial: Variant; animate: Variant; exit: Variant };
type MorphingDialogContextValue = { isOpen: boolean; setIsOpen: Dispatch<SetStateAction<boolean>>; uniqueId: string; triggerRef: RefObject<HTMLButtonElement | null> };
type MorphingDialogTriggerProps = PropsWithChildren<{ className?: string; style?: CSSProperties; triggerRef?: RefObject<HTMLButtonElement | null> }>;
type MorphingDialogContainerProps = PropsWithChildren<{ className?: string; style?: CSSProperties }>;
type MorphingDialogContentProps = PropsWithChildren<{ className?: string; style?: CSSProperties }>;
type MorphingDialogTextProps = PropsWithChildren<{ className?: string; style?: CSSProperties }>;
type MorphingDialogDescriptionProps = PropsWithChildren<{ className?: string; disableLayoutAnimation?: boolean; variants?: MorphingDialogVariants }>;
type MorphingDialogImageProps = { src: string; alt: string; className?: string; style?: CSSProperties };
type MorphingDialogCloseProps = { children?: ReactNode; className?: string; variants?: MorphingDialogVariants };
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const DisclosureContext = createContext<DisclosureContextValue | null>(null);
const MorphingDialogContext = createContext<MorphingDialogContextValue | null>(null);

function normalizeGridColumns(value: unknown): GridColumnCount | null {
  return typeof value === "number" && value in GRID_COL_CLASS ? (value as GridColumnCount) : null;
}

function resolveGridColsClass(raw: GridColumns | undefined): string {
  const classes: string[] = [GRID_COL_CLASS[1]];
  const scalar = normalizeGridColumns(raw);
  if (scalar) return GRID_COL_CLASS[scalar];
  if (!raw || typeof raw !== "object") return classes.join(" ");
  const base = normalizeGridColumns(raw.base);
  if (base) classes[0] = GRID_COL_CLASS[base];
  for (const breakpoint of ["sm", "md", "lg", "xl"] as const) {
    const columns = normalizeGridColumns(raw[breakpoint]);
    if (columns) classes.push(GRID_BREAKPOINT_COL_CLASS[breakpoint][columns]);
  }
  return classes.join(" ");
}

function resolveGapClass(value: GapValue | undefined, fallback: GapValue = "lg") {
  if (typeof value === "number" && value in NUMERIC_GAP_CLASS) return NUMERIC_GAP_CLASS[value as NumericSpacing];
  if (typeof value === "string" && value in GAP_CLASS) return GAP_CLASS[value as GapSize];
  return resolveGapClass(fallback);
}

function resolvePaddingClass(value: PaddingSize | undefined) {
  return typeof value === "number" && value in PADDING_CLASS ? PADDING_CLASS[value] : "";
}

type SurfaceProps = PropsWithChildren<{ kicker?: string; title: string; description?: string; actions?: ReactNode }>;

/**
 * Opinionated titled shell for screens that need kicker, title, description, actions, and a body. Prefer raw layout or Card for compact body-first content.
 * @param actions Right-aligned header affordance; keep it short because it shares the title row on desktop.
 */
export function Surface({ kicker, title, description, actions, children }: SurfaceProps) {
  return (
    <Card className="rounded-[24px] bg-[linear-gradient(180deg,rgba(255,255,255,0.88)_0%,rgba(249,247,241,0.96)_100%)] shadow-[0_20px_48px_rgba(22,22,21,0.05),inset_0_1px_0_rgba(255,255,255,0.8)]">
      <CardHeader className="space-y-5 p-6 md:p-7">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            {kicker ? (
              <Badge variant="outline" className="w-fit text-[11px] uppercase tracking-[0.22em]">
                {kicker}
              </Badge>
            ) : null}
            <div className="space-y-2">
              <CardTitle className="text-balance text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-[#161615]">{title}</CardTitle>
              {description ? <CardDescription className="max-w-2xl text-sm leading-6 text-[#595856]">{description}</CardDescription> : null}
            </div>
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </CardHeader>
      <Separator className="bg-black/[0.06]" />
      <CardContent className="pt-6 md:p-7 md:pt-6">{children}</CardContent>
    </Card>
  );
}

/**
 * Vertical composition with tokenized gap and optional padding.
 * @param gap Named or numeric gap token; use className for one-off responsive spacing.
 * @param padding Numeric padding token; omit when nested children already carry their own section padding.
 */
export function Stack({ children, gap = "lg", padding, className }: PropsWithChildren<{ gap?: GapValue; padding?: PaddingSize; className?: string }>) {
  return <div className={cn("flex min-w-0 flex-col", resolveGapClass(gap), resolvePaddingClass(padding), className)}>{children}</div>;
}

/** Simple two-column layout for naturally paired content on wide containers. */
export function TwoColumnGrid({ children }: PropsWithChildren) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

/**
 * Simple grid with tokenized columns/gap. Prefer raw className grids for responsive bento layouts that need spans or container-query breakpoints.
 * @param columns Responsive object form, e.g. { base: 1, md: 2 }; equivalent to cols when scalar.
 */
export function Grid({ children, cols, columns, gap = "md", className }: PropsWithChildren<{ cols?: GridColumns; columns?: GridColumns; gap?: GapValue; className?: string }>) {
  return <div className={cn("grid min-w-0", resolveGapClass(gap), resolveGridColsClass(cols ?? columns ?? 1), className)}>{children}</div>;
}

/**
 * Horizontal group for toolbar clusters and small inline layouts.
 * @param wrap Enables multi-line wrapping; leave false for controls that must keep a stable row.
 */
export function Row({ children, gap = "md", align = "start", justify = "start", wrap = false, className }: PropsWithChildren<{ gap?: GapValue; align?: Align; justify?: Justify; wrap?: boolean; className?: string }>) {
  return <div className={cn("flex min-w-0", resolveGapClass(gap), ALIGN_CLASS[align], JUSTIFY_CLASS[justify], wrap ? "flex-wrap" : "flex-nowrap", className)}>{children}</div>;
}

/**
 * Semantic text when tokenized tone/size/weight is enough. Use raw utility classes for bespoke hierarchy or exact wrapping behavior.
 * @param color Backwards-compatible alias for tone; prefer tone in new code.
 */
export function Text({ children, tone, color, size = "md", weight = "normal", className }: TextProps) {
  const resolvedTone = tone ?? color ?? "default";
  return (
    <p
      className={cn(
        "m-0",
        resolvedTone === "muted" ? "text-[#6F655B]" : resolvedTone === "accent" ? "text-[#EE5C2A]" : "text-[#171411]",
        size === "xs" ? "text-xs leading-5" : size === "sm" ? "text-sm leading-6" : size === "lg" ? "text-lg leading-7" : size === "xl" ? "text-xl leading-8" : "text-[15px] leading-6",
        weight === "bold" ? "font-bold" : weight === "semibold" ? "font-semibold" : weight === "medium" ? "font-medium" : "font-normal",
        className,
      )}
    >
      {children}
    </p>
  );
}

type FieldProps = PropsWithChildren<{ label: string; hint?: string }>;

/** Compact form field wrapper with label, optional hint, and one control. */
export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-semibold text-[#161615]">{label}</Label>
      {hint ? <p className="m-0 text-xs leading-5 text-[#ABAAA6]">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Short row of text chips when metadata belongs with content rather than top chrome. */
export function PillRow({ items }: { items: string[] }) {
  // Compare streams partial code, so tolerate one bad prop shape instead of crashing the whole preview tree.
  const safeItems = Array.isArray(items) ? items : [];
  return (
    <div className="flex flex-wrap gap-2">
      {safeItems.map((item) => (
        <Badge key={item} variant="outline">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function useDisclosureContext() {
  const context = useContext(DisclosureContext);
  if (!context) throw new Error("useDisclosure must be used within Disclosure");
  return context;
}

function resolveDisclosureTransitionMs(transition: DisclosureTransition | undefined) {
  return typeof transition?.duration === "number" ? `${Math.max(0, transition.duration) * 1000}ms` : "300ms";
}

function resolveDisclosureDelayMs(transition: DisclosureTransition | undefined) {
  return typeof transition?.delay === "number" ? `${Math.max(0, transition.delay) * 1000}ms` : undefined;
}

function resolveDisclosureVariantStyle(open: boolean, variant: DisclosureMotionVariant | undefined, transition: DisclosureTransition | undefined): CSSProperties {
  const x = typeof variant?.x === "number" ? variant.x : 0;
  const y = typeof variant?.y === "number" ? variant.y : 0;
  const scale = typeof variant?.scale === "number" ? variant.scale : 1;
  const opacity = typeof variant?.opacity === "number" ? variant.opacity : open ? 1 : 0;
  return { opacity, filter: variant?.filter, transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`, transitionDuration: resolveDisclosureTransitionMs(transition), transitionDelay: resolveDisclosureDelayMs(transition) };
}

function useMorphingDialog() {
  const context = useContext(MorphingDialogContext);
  if (!context) throw new Error("MorphingDialog components must be used within MorphingDialog");
  return context;
}

/**
 * Motion Primitives-style disclosure for FAQ/show-more text and lightweight inline reveals, not bento tile detail views.
 * @example <Disclosure><DisclosureTrigger><button>Details</button></DisclosureTrigger><DisclosureContent><p className="pt-2 text-sm">Extra context</p></DisclosureContent></Disclosure>
 * @see https://motion-primitives.com/docs/disclosure
 */
export function Disclosure({ open, onOpenChange, children, className, variants, transition, ...props }: PropsWithChildren<HTMLAttributes<HTMLDivElement> & { open?: boolean; onOpenChange?: (open: boolean) => void; variants?: DisclosureVariants; transition?: DisclosureTransition }>) {
  const contentId = useId();
  const [internalOpen, setInternalOpen] = useState(open ?? false);
  const resolvedOpen = open ?? internalOpen;
  const toggle = useCallback(() => {
    const nextOpen = !resolvedOpen;
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open, resolvedOpen]);
  const contextValue = useMemo(() => ({ open: resolvedOpen, toggle, contentId, variants, transition }), [contentId, resolvedOpen, toggle, transition, variants]);
  return (
    <DisclosureContext.Provider value={contextValue}>
      <div data-slot="disclosure" className={className} {...props}>
        {children}
      </div>
    </DisclosureContext.Provider>
  );
}

/** Toggle control for Disclosure. It clones its child, so pass one focusable or semantic element rather than a fragment of unrelated nodes. */
export function DisclosureTrigger({ children, className }: PropsWithChildren<{ className?: string }>) {
  const { open, toggle, contentId } = useDisclosureContext();
  return (
    <>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const element = child as ReactElement<HTMLAttributes<HTMLElement>>;
        return cloneElement(element, {
          role: "button",
          "aria-expanded": open,
          "aria-controls": contentId,
          tabIndex: 0,
          className: cn(className, element.props.className),
          onClick: (event: MouseEvent<HTMLElement>) => {
            element.props.onClick?.(event);
            if (!event.defaultPrevented) toggle();
          },
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            element.props.onKeyDown?.(event);
            if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              toggle();
            }
          },
        });
      })}
    </>
  );
}

/**
 * Revealed Disclosure region.
 * @param className Applied to the animated outer grid wrapper; put content styling on a child when inner spacing should not affect the collapse track.
 */
export function DisclosureContent({ children, className }: PropsWithChildren<{ className?: string }>) {
  const { open, contentId, variants, transition } = useDisclosureContext();
  const activeVariant = open ? variants?.expanded : variants?.collapsed;
  return (
    <div
      id={contentId}
      data-slot="disclosure-content"
      aria-hidden={!open}
      inert={!open || undefined}
      className={cn("grid overflow-hidden transition-[grid-template-rows] ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]", className)}
      style={{ transitionDuration: resolveDisclosureTransitionMs(transition), transitionDelay: resolveDisclosureDelayMs(transition) }}
    >
      <div className="min-h-0 overflow-hidden transition-[opacity,transform,filter] ease-out" style={resolveDisclosureVariantStyle(open, activeVariant, transition)}>
        {children}
      </div>
    </div>
  );
}

const DEFAULT_MORPHING_DIALOG_TRANSITION: MorphingDialogTransition = { type: "spring", bounce: 0.05, duration: 0.25 };

/**
 * Card-to-dialog expansion system for focused detail views, morphing media cards, and bento tiles that open into richer content.
 * @param transition Motion spring shared by trigger/content; keep duration short enough that layout changes still feel direct.
 * @example <MorphingDialog><MorphingDialogTrigger className="rounded-2xl p-4"><MorphingDialogTitle>Quarterly plan</MorphingDialogTitle></MorphingDialogTrigger><MorphingDialogContainer><MorphingDialogContent className="pointer-events-auto w-[min(92vw,560px)] rounded-[26px] p-6" style={{ backgroundColor: "#fffaf2", boxShadow: "0 24px 70px rgba(42,55,38,0.18)", borderRadius: 26 }}><MorphingDialogTitle>Quarterly plan</MorphingDialogTitle><MorphingDialogDescription>Expanded detail goes here.</MorphingDialogDescription><MorphingDialogClose /></MorphingDialogContent></MorphingDialogContainer></MorphingDialog>
 * @see https://motion-primitives.com/docs/morphing-dialog
 */
export function MorphingDialog({ children, transition = DEFAULT_MORPHING_DIALOG_TRANSITION }: PropsWithChildren<{ transition?: MorphingDialogTransition }>) {
  const uniqueId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const contextValue = useMemo<MorphingDialogContextValue>(() => ({ isOpen, setIsOpen, uniqueId, triggerRef }), [isOpen, uniqueId]);
  return (
    <MorphingDialogContext.Provider value={contextValue}>
      <MotionConfig transition={transition}>{children}</MotionConfig>
    </MorphingDialogContext.Provider>
  );
}

/**
 * Compact clickable surface for MorphingDialog. Keep visible trigger elements paired in MorphingDialogContent via matching primitives or layoutId wrappers, otherwise they can stretch or ghost during morph.
 * @param triggerRef Optional external ref to the generated button; do not pass onClick or aria props because this component owns them.
 */
export function MorphingDialogTrigger({ children, className, style, triggerRef }: MorphingDialogTriggerProps) {
  const { setIsOpen, isOpen, uniqueId, triggerRef: contextTriggerRef } = useMorphingDialog();
  const handleClick = useCallback(() => setIsOpen((value) => !value), [setIsOpen]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsOpen((value) => !value);
      }
    },
    [setIsOpen],
  );
  return (
    <motion.button
      ref={(node) => {
        contextTriggerRef.current = node;
        if (triggerRef) triggerRef.current = node;
      }}
      layoutId={`dialog-${uniqueId}`}
      className={cn("relative cursor-pointer", className)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={style}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-controls={`motion-ui-morphing-dialog-content-${uniqueId}`}
      aria-label={`Open dialog ${uniqueId}`}
    >
      {children}
    </motion.button>
  );
}

/**
 * Expanded MorphingDialog surface. It has no built-in card chrome, so className/style must create the visible panel and final dimensions.
 * @param className Include pointer-events-auto, comfortable width, rounded corners, and at least p-6; avoid transparent panels.
 * @param style Put backgroundColor, boxShadow, and borderRadius inline so layout animation can interpolate them.
 */
export function MorphingDialogContent({ children, className, style }: MorphingDialogContentProps) {
  const { setIsOpen, isOpen, uniqueId, triggerRef } = useMorphingDialog();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [firstFocusable, setFirstFocusable] = useState<HTMLElement | null>(null);
  const [lastFocusable, setLastFocusable] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
      if (event.key === "Tab" && firstFocusable && lastFocusable) {
        if (event.shiftKey) {
          if (document.activeElement === firstFocusable) {
            event.preventDefault();
            lastFocusable.focus();
          }
        } else if (document.activeElement === lastFocusable) {
          event.preventDefault();
          firstFocusable.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setIsOpen, firstFocusable, lastFocusable]);
  useEffect(() => {
    if (isOpen) {
      document.body.classList.add("overflow-hidden");
      const focusables = containerRef.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (focusables && focusables.length > 0) {
        setFirstFocusable(focusables[0]);
        setLastFocusable(focusables.item(focusables.length - 1));
        focusables[0].focus();
      }
    } else {
      document.body.classList.remove("overflow-hidden");
      triggerRef.current?.focus();
    }
  }, [isOpen, triggerRef]);
  return (
    <motion.div ref={containerRef} layoutId={`dialog-${uniqueId}`} className={cn("overflow-hidden", className)} style={style} role="dialog" aria-modal="true" aria-labelledby={`motion-ui-morphing-dialog-title-${uniqueId}`} aria-describedby={`motion-ui-morphing-dialog-description-${uniqueId}`}>
      {children}
    </motion.div>
  );
}

/** Portal/backdrop wrapper for MorphingDialogContent. Do not skip this layer or the dialog will not portal and focus correctly. */
export function MorphingDialogContainer({ children }: MorphingDialogContainerProps) {
  const { isOpen, setIsOpen, uniqueId } = useMorphingDialog();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence initial={false} mode="sync">
      {isOpen ? (
        <>
          <motion.div key={`backdrop-${uniqueId}`} className="fixed inset-0 z-40 h-full w-full bg-black/30 backdrop-blur-[6px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setIsOpen(false)} />
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">{children}</div>
        </>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** Shared title node for both trigger and content; identical text lets layout motion align instead of jumping. */
export function MorphingDialogTitle({ children, className, style }: MorphingDialogTextProps) {
  const { uniqueId } = useMorphingDialog();
  return (
    <motion.div layoutId={`dialog-title-container-${uniqueId}`} layout className={className} style={style}>
      {children}
    </motion.div>
  );
}

/** Shared subtitle node for both trigger and content; identical text prevents morph mismatch. */
export function MorphingDialogSubtitle({ children, className, style }: MorphingDialogTextProps) {
  const { uniqueId } = useMorphingDialog();
  return (
    <motion.div layoutId={`dialog-subtitle-container-${uniqueId}`} className={className} style={style}>
      {children}
    </motion.div>
  );
}

/**
 * Content-only detail that fades instead of morphing from the trigger; put long descriptions, feature lists, actions, and metric breakdowns here.
 * @param disableLayoutAnimation Set when the content should fade only and must not share layout with trigger text.
 */
export function MorphingDialogDescription({ children, className, variants, disableLayoutAnimation }: MorphingDialogDescriptionProps) {
  const { uniqueId } = useMorphingDialog();
  return (
    <motion.div key={`dialog-description-${uniqueId}`} layoutId={disableLayoutAnimation ? undefined : `dialog-description-content-${uniqueId}`} variants={variants} className={className} initial="initial" animate="animate" exit="exit" id={`dialog-description-${uniqueId}`}>
      {children}
    </motion.div>
  );
}

/**
 * Shared image between MorphingDialog trigger and content.
 * @param src Must be a string URL or data:image/svg+xml data URL; do not pass children or React nodes.
 */
export function MorphingDialogImage({ src, alt, className, style }: MorphingDialogImageProps) {
  const { uniqueId } = useMorphingDialog();
  return <motion.img src={src} alt={alt} className={className} layoutId={`dialog-img-${uniqueId}`} style={style} />;
}

/** Close control for MorphingDialogContent. Keep the default top-right placement unless the panel shape truly requires a custom position. */
export function MorphingDialogClose({ children, className, variants }: MorphingDialogCloseProps) {
  const { setIsOpen, uniqueId } = useMorphingDialog();
  const handleClose = useCallback(() => setIsOpen(false), [setIsOpen]);
  return (
    <motion.button onClick={handleClose} type="button" aria-label="Close dialog" key={`dialog-close-${uniqueId}`} className={cn("absolute top-6 right-6", className)} initial="initial" animate="animate" exit="exit" variants={variants}>
      {children ?? <X size={24} />}
    </motion.button>
  );
}

/**
 * Animated shimmer text for premium/loading/celebratory labels. Use as one accent, not ordinary body copy or dense labels.
 * @param spread Pixel width of the highlight band; larger text usually needs a wider spread.
 * @example <TextShimmer className="text-2xl font-semibold">Preparing insights</TextShimmer>
 * @see https://motion-primitives.com/docs/text-shimmer
 */
export function TextShimmer({ children, as: Component = "p", className, duration = 2, spread = 2 }: TextShimmerProps) {
  const dynamicSpread = Math.max(1, children.length * spread);
  return (
    <Component
      data-slot="text-shimmer"
      className={cn(
        "macaron-text-shimmer relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))] [--base-color:#a1a1aa] [--base-gradient-color:#000] dark:[--base-color:#71717a] dark:[--base-gradient-color:#ffffff]",
        className,
      )}
      style={
        {
          ["--spread" as never]: `${dynamicSpread}px`,
          backgroundImage: "var(--bg), linear-gradient(var(--base-color), var(--base-color))",
          backgroundPosition: "100% center, 0 0",
          backgroundRepeat: "no-repeat, no-repeat",
          backgroundSize: "250% 100%, auto",
          animation: `macaron-text-shimmer ${duration}s linear infinite`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
}

type TextMorphBox = { left: number; top: number; width: number; height: number };
type TextMorphCharacter = { id: string; label: string };
type TextMorphRendered = TextMorphCharacter & { isExiting: boolean };

/**
 * Character-level morph for short roomy headline/subheadline labels. Avoid buttons, badges, table cells, compact chips, and CJK text in narrow containers because characters are split into spans.
 * @param as Rendered tag for the text container; keep it inline-friendly unless the surrounding layout reserves block space.
 * @example <TextMorph as="h2" className="text-4xl font-semibold">Live results</TextMorph>
 * @see https://motion-primitives.com/docs/text-morph
 */
export function TextMorph({ children, as: Component = "p", className, style, transition }: TextMorphProps) {
  const uniqueId = useId();
  const durationMs = Math.max(60, (transition?.duration ?? 0.32) * 1000);
  const delayMs = Math.max(0, (transition?.delay ?? 0) * 1000);
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  const transitionStyle = `transform ${durationMs}ms ${easing} ${delayMs}ms, opacity ${durationMs}ms ${easing} ${delayMs}ms`;
  const characters = useMemo<TextMorphCharacter[]>(() => {
    const charCounts: Record<string, number> = {};
    return children.split("").map((char) => {
      const lowerChar = char.toLowerCase();
      charCounts[lowerChar] = (charCounts[lowerChar] || 0) + 1;
      return { id: `${uniqueId}-${lowerChar}${charCounts[lowerChar]}`, label: char === " " ? "\u00A0" : char };
    });
  }, [children, uniqueId]);
  const [renderedCharacters, setRenderedCharacters] = useState<TextMorphRendered[]>(() => characters.map((c) => ({ ...c, isExiting: false })));
  const exitTimerRef = useRef<number | null>(null);
  const measureRefs = useRef(new Map<string, HTMLSpanElement>());
  const visibleRefs = useRef(new Map<string, HTMLSpanElement>());
  const previousBoxesRef = useRef<Record<string, TextMorphBox>>({});
  const [boxes, setBoxes] = useState<Record<string, TextMorphBox>>({});
  const hasAnimatedRef = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const newIds = new Set(characters.map((c) => c.id));
    setRenderedCharacters((curr) => {
      const newlyExiting = curr.filter((c) => !c.isExiting && !newIds.has(c.id)).map((c) => ({ ...c, isExiting: true }));
      const stillExiting = curr.filter((c) => c.isExiting && !newIds.has(c.id));
      return [...characters.map((c) => ({ ...c, isExiting: false })), ...stillExiting, ...newlyExiting];
    });
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    exitTimerRef.current = window.setTimeout(
      () => {
        setRenderedCharacters((curr) => curr.filter((c) => !c.isExiting));
        exitTimerRef.current = null;
      },
      durationMs + delayMs + 40,
    );
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [characters, durationMs, delayMs]);

  useIsomorphicLayoutEffect(() => {
    const nextBoxes: Record<string, TextMorphBox> = {};
    for (const character of characters) {
      const element = measureRefs.current.get(character.id);
      if (!element) continue;
      nextBoxes[character.id] = { left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight };
    }
    const currentKeys = Object.keys(boxes).join("|");
    const nextKeys = Object.keys(nextBoxes).join("|");
    const changed =
      currentKeys !== nextKeys ||
      Object.keys(nextBoxes).some((id) => {
        const current = boxes[id];
        const next = nextBoxes[id];
        return !current || current.left !== next.left || current.top !== next.top || current.width !== next.width || current.height !== next.height;
      });
    if (changed) {
      previousBoxesRef.current = boxes;
      setBoxes(nextBoxes);
    }
  }, [boxes, characters]);

  useIsomorphicLayoutEffect(() => {
    const previousBoxes = previousBoxesRef.current;
    const startFrame = requestAnimationFrame(() => {
      for (const rendered of renderedCharacters) {
        const element = visibleRefs.current.get(rendered.id);
        if (!element) continue;
        if (rendered.isExiting) {
          element.style.transition = transitionStyle;
          element.style.opacity = "0";
          continue;
        }
        const nextBox = boxes[rendered.id];
        if (!nextBox) continue;
        const previousBox = previousBoxes[rendered.id];
        element.style.transition = "none";
        element.style.left = `${nextBox.left}px`;
        element.style.top = `${nextBox.top}px`;
        element.style.width = `${nextBox.width}px`;
        element.style.height = `${nextBox.height}px`;
        element.style.opacity = hasAnimatedRef.current && !previousBox ? "0" : "1";
        element.style.transform = hasAnimatedRef.current && previousBox ? `translate(${previousBox.left - nextBox.left}px, ${previousBox.top - nextBox.top}px)` : "translate(0, 0)";
      }
      requestAnimationFrame(() => {
        for (const rendered of renderedCharacters) {
          if (rendered.isExiting) continue;
          const element = visibleRefs.current.get(rendered.id);
          if (!element) continue;
          element.style.transition = transitionStyle;
          element.style.opacity = "1";
          element.style.transform = "translate(0, 0)";
        }
        hasAnimatedRef.current = true;
      });
    });
    previousBoxesRef.current = boxes;
    return () => cancelAnimationFrame(startFrame);
  }, [boxes, renderedCharacters, transitionStyle]);

  return (
    <Component data-slot="text-morph" aria-label={children} className={cn("relative inline-block align-baseline", className)} style={{ position: "relative", display: "inline-block", ...style }}>
      <span aria-hidden="true" className="pointer-events-none invisible relative inline-block whitespace-pre">
        {characters.map((character) => (
          <span
            key={character.id}
            ref={(node) => {
              if (node) measureRefs.current.set(character.id, node);
              else measureRefs.current.delete(character.id);
            }}
            className="inline-block whitespace-pre"
          >
            {character.label}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 whitespace-pre">
        {renderedCharacters.map((rendered) => (
          <span
            key={rendered.id}
            ref={(node) => {
              if (node) visibleRefs.current.set(rendered.id, node);
              else visibleRefs.current.delete(rendered.id);
            }}
            className="absolute inline-block whitespace-pre"
            style={{ left: 0, top: 0 }}
          >
            {rendered.label}
          </span>
        ))}
      </span>
    </Component>
  );
}

function resolveTextLoopVariantStyle(variant: TextLoopVariant | undefined): CSSProperties {
  const y = typeof variant?.y === "number" ? variant.y : 0;
  const rotateX = typeof variant?.rotateX === "number" ? variant.rotateX : 0;
  const scale = typeof variant?.scale === "number" ? variant.scale : 1;
  return { opacity: typeof variant?.opacity === "number" ? variant.opacity : undefined, filter: variant?.filter, transform: `translate3d(0, ${y}px, 0) rotateX(${rotateX}deg) scale(${scale})` };
}

function resolveGlowBlur(blur: GlowEffectBlur) {
  if (typeof blur === "number") return `${blur}px`;
  return { none: "0px", softest: "2px", soft: "4px", medium: "12px", strong: "16px", stronger: "24px", strongest: "32px" }[blur];
}

function resolveGlowBackground(colors: string[], mode: GlowEffectMode) {
  const palette = colors.length > 0 ? colors : ["#FF5733", "#33FF57", "#3357FF", "#F1C40F"];
  if (mode === "pulse" || mode === "breathe") return palette.map((color, index) => `radial-gradient(circle at ${30 + index * 18}% ${35 + (index % 2) * 30}%, ${color} 0%, transparent 42%)`).join(", ");
  if (mode === "flowHorizontal" || mode === "colorShift") return `linear-gradient(90deg, ${[...palette, ...palette].join(", ")})`;
  return mode === "static" ? `linear-gradient(90deg, ${palette.join(", ")})` : `conic-gradient(from 0deg at 50% 50%, ${palette.join(", ")}, ${palette[0]})`;
}

function resolveGlowAnimation(mode: GlowEffectMode) {
  return mode === "static" ? "none" : `macaron-glow-${mode}`;
}

const PROGRESSIVE_BLUR_ANGLES: Record<ProgressiveBlurDirection, number> = { top: 0, right: 90, bottom: 180, left: 270 };

/**
 * Progressive blur overlay for text, captions, metadata, or actions over images. Mount inside a relative parent and match hover visibility with the overlaid copy.
 * @param direction Edge where blur starts; use bottom for captions and top for sticky header fades.
 * @param blurLayers More layers make the fade smoother but heavier.
 * @example <div className="relative overflow-hidden rounded-2xl"><img src={photo} className="h-64 w-full object-cover" /><ProgressiveBlur direction="bottom" className="top-auto h-28" /><div className="absolute bottom-4 left-4 text-white">Caption</div></div>
 * @see https://motion-primitives.com/docs/progressive-blur
 */
export function ProgressiveBlur({ direction = "bottom", blurLayers = 8, className = "", blurIntensity = 0.25 }: ProgressiveBlurProps) {
  const layers = Math.max(2, Math.min(16, Math.floor(blurLayers)));
  const segmentSize = 1 / (layers + 1);
  const angle = PROGRESSIVE_BLUR_ANGLES[direction];
  return (
    <div aria-hidden="true" data-slot="progressive-blur" className={cn("pointer-events-none absolute inset-0", className)}>
      {Array.from({ length: layers }).map((_, index) => {
        return <div key={index} className="absolute inset-0 rounded-[inherit]" style={getProgressiveBlurLayerStyle({ layer: index, segmentSize, blur: index * blurIntensity, gradientDirection: `${angle}deg`, maskColor: "255,255,255", stopScale: 100 })} />;
      })}
    </div>
  );
}

/**
 * Rotating text for changing statuses, descriptor loops, or compact headline variations. Prefer it over TextMorph for label cycles in stable-width wrappers.
 * @param interval Seconds between item changes; keep long enough for the current phrase to be readable.
 * @param trigger Set false to freeze on the first child while preserving layout.
 * @example <TextLoop className="min-w-[9ch]"><span>Fast</span><span>Focused</span><span>Local</span></TextLoop>
 * @see https://motion-primitives.com/docs/text-loop
 */
export function TextLoop({ children, className, interval = 2, transition = { duration: 0.3 }, variants, onIndexChange, trigger = true }: TextLoopProps) {
  const items = Children.toArray(children);
  const [activeIndex, setActiveIndex] = useState(0);
  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [exitingIndex, setExitingIndex] = useState<number | null>(null);
  const activeIndexRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const durationMs = Math.min(interval * 1000, Math.max(0.08, transition.duration ?? 0.3) * 1000);
  const currentItem = items.length > 0 ? items[activeIndex % items.length] : null;
  const exitingItem = exitingIndex === null || items.length === 0 ? null : items[exitingIndex % items.length];

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    if (!trigger || items.length <= 1) return;
    const timer = window.setInterval(() => {
      const current = activeIndexRef.current % items.length;
      const next = (current + 1) % items.length;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      setExitingIndex(current);
      setExiting(false);
      setActiveIndex(next);
      activeIndexRef.current = next;
      setEntering(true);
      onIndexChange?.(next);
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => {
          setExiting(true);
          setEntering(false);
        });
      });
      exitTimerRef.current = window.setTimeout(() => {
        setExitingIndex(null);
        setExiting(false);
      }, durationMs);
    }, interval * 1000);
    return () => {
      window.clearInterval(timer);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    };
  }, [durationMs, interval, items.length, onIndexChange, trigger]);

  const enterStyle = resolveTextLoopVariantStyle(variants?.initial ?? { y: 10, opacity: 0, filter: "blur(4px)" });
  const visibleStyle = resolveTextLoopVariantStyle(variants?.animate ?? { y: 0, opacity: 1 });
  const exitStyle = resolveTextLoopVariantStyle(variants?.exit ?? { y: -10, opacity: 0, filter: "blur(4px)" });
  const transitionStyle = { transitionDuration: `${durationMs}ms`, transitionTimingFunction: "cubic-bezier(0.22,1,0.36,1)" };
  return (
    <span data-slot="text-loop" className={cn("relative inline-block whitespace-nowrap align-baseline [perspective:500px]", className)}>
      {exitingItem ? (
        <span key={`exit-${exitingIndex}`} className="pointer-events-none absolute left-0 top-0 inline-block transition-[opacity,transform,filter]" style={{ ...(exiting ? exitStyle : visibleStyle), ...transitionStyle }}>
          {exitingItem}
        </span>
      ) : null}
      <span key={`enter-${activeIndex}`} className="inline-block transition-[opacity,transform,filter]" style={{ ...(entering ? enterStyle : visibleStyle), ...transitionStyle }}>
        {currentItem}
      </span>
    </span>
  );
}

function resolveSpinningTextDiameter(fontSize: number, radius: number) {
  return `${Math.max(4, radius * 2 + fontSize * 2.5)}rem`;
}

/**
 * Circular rotating text for a badge, seal, orbit label, or one decorative ring. Render at most one per page.
 * @param radius Distance from center in character units; increase for longer text to avoid overlap.
 * @param fontSize Rem-based character size used by the circular layout math.
 * @example <SpinningText className="size-28 text-xs uppercase tracking-[0.18em]" radius={5}>new launch • new launch •</SpinningText>
 * @see https://motion-primitives.com/docs/spinning-text
 */
export function SpinningText({ children, style, duration = 10, className, reverse = false, fontSize = 1, radius = 5, transition }: SpinningTextProps) {
  const letters = Array.from(children);
  const totalLetters = Math.max(1, letters.length);
  const animationDuration = transition?.duration ?? duration;
  const diameter = resolveSpinningTextDiameter(fontSize, radius);
  // Default footprint via CSS variable consumed by :where() in index.css; className w-/h-/size- and `style.width` both override.
  const resolvedStyle: CSSProperties = {
    ...style,
    animation: `macaron-spinning-text ${animationDuration}s linear infinite`,
    animationDirection: reverse ? "reverse" : "normal",
    willChange: "rotate",
    ["--font-size" as never]: `${fontSize}`,
    ["--radius" as never]: `${radius}`,
    ["--macaron-spinning-text-diameter" as never]: diameter,
  };

  return (
    <div data-slot="spinning-text" aria-label={children} className={cn("relative inline-grid place-items-center overflow-visible align-middle", className)} style={resolvedStyle}>
      {letters.map((letter, index) => (
        <span
          key={`${index}-${letter}`}
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 inline-block whitespace-pre leading-none"
          style={
            {
              fontSize: "calc(var(--font-size, 1) * 1rem)",
              transform: `translate(-50%, -50%) rotate(calc(360deg / ${totalLetters} * ${index})) translateY(calc(var(--radius, 5) * -1ch))`,
              transformOrigin: "center",
            } as CSSProperties
          }
        >
          {letter}
        </span>
      ))}
      <span className="sr-only">{children}</span>
    </div>
  );
}

function resolveTiltTransition(springOptions: TiltSpringOptions | undefined) {
  const stiffness = typeof springOptions?.stiffness === "number" ? springOptions.stiffness : 100;
  const damping = typeof springOptions?.damping === "number" ? springOptions.damping : 10;
  const mass = typeof springOptions?.mass === "number" ? springOptions.mass : 1;
  // Approximate spring settle time: scales with sqrt(mass/stiffness) and damping factor.
  const ms = Math.max(120, Math.min(800, Math.round(1000 * Math.sqrt(mass / Math.max(0.01, stiffness)) * (damping / 5))));
  return `${ms}ms cubic-bezier(0.22, 1, 0.36, 1)`;
}

/**
 * Pointer-reactive depth for a focused card or collectible.
 * @param rotationFactor Higher values exaggerate tilt; keep low for dense dashboards.
 * @param isReverse Inverts the pointer direction for a pushed-in rather than lifted feel.
 * @example <Tilt rotationFactor={8} className="rounded-2xl"><Card>Interactive card</Card></Tilt>
 * @see https://motion-primitives.com/docs/tilt
 */
export function Tilt({ children, className, style, rotationFactor = 15, isReverse = false, springOptions, onMouseEnter, onMouseMove, onMouseLeave, ...props }: TiltProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reverse = isReverse;
  const baseTransform = typeof style?.transform === "string" ? style.transform : "";
  const tiltedTransform = (rotateX: number, rotateY: number) => `${baseTransform ? `${baseTransform} ` : ""}perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  // mousemove: snap (no transition) so the tilt tracks the cursor exactly; mouseleave: spring-curve back to 0.
  const handleMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    onMouseEnter?.(event);
    if (event.defaultPrevented || !ref.current) return;
    ref.current.style.transition = "none";
  };
  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    onMouseMove?.(event);
    if (!ref.current || event.defaultPrevented) return;
    const rect = ref.current.getBoundingClientRect();
    const xPos = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
    const yPos = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
    const rotateX = (reverse ? yPos : -yPos) * rotationFactor * 2;
    const rotateY = (reverse ? -xPos : xPos) * rotationFactor * 2;
    ref.current.style.transform = tiltedTransform(rotateX, rotateY);
  };
  const handleMouseLeave = (event: MouseEvent<HTMLDivElement>) => {
    onMouseLeave?.(event);
    if (event.defaultPrevented || !ref.current) return;
    ref.current.style.transition = `transform ${resolveTiltTransition(springOptions)}`;
    ref.current.style.transform = tiltedTransform(0, 0);
  };
  return (
    <div ref={ref} data-slot="tilt" className={className} style={{ transformStyle: "preserve-3d", ...style, transform: tiltedTransform(0, 0) }} onMouseEnter={handleMouseEnter} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} {...props}>
      {children}
    </div>
  );
}

function resolveToolbarWidth(value: number | string) {
  return typeof value === "number" ? `${value}px` : value;
}

function ToolbarDynamicButton({ children, onClick, disabled, ariaLabel }: { children: ReactNode; onClick?: () => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="relative flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg text-[#6F655B] transition-[background-color,color,transform] hover:bg-black/[0.05] hover:text-[#171411] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08]"
    >
      {children}
    </button>
  );
}

/**
 * Expanding toolbar for compact search/action surfaces.
 * @param compact Collapsed content; keep it short enough for collapsedWidth.
 * @param expanded Expanded content; height is measured, so dynamic result lists can animate.
 * @param collapsedWidth Width before expansion; must fit compact content.
 * @param expandedWidth Width after expansion; use a CSS length for responsive caps.
 * @example <ToolbarDynamic collapsedWidth={96} expandedWidth="min(80vw,360px)" compact={<Search className="h-5 w-5" />} expanded={<input className="h-9 w-full bg-transparent outline-none" placeholder="Search" />} />
 * @see https://motion-primitives.com/docs/toolbar-dynamic
 */
export function ToolbarDynamic({ className, style, compact, expanded, placeholder = "Search notes", defaultOpen = false, open, onOpenChange, collapsedWidth = 98, expandedWidth = 300 }: ToolbarDynamicProps) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [contentHeight, setContentHeight] = useState<number | undefined>();
  const isOpen = open ?? internalOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, setOpen]);

  // ResizeObserver tracks compact/expanded child swaps and expanded-content changes; the first auto-to-px measurement snaps, avoiding a fake initial animation.
  useIsomorphicLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContentHeight(el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const defaultCompact = (
    <div className="flex gap-2">
      <ToolbarDynamicButton disabled ariaLabel="User profile">
        <User className="h-5 w-5" />
      </ToolbarDynamicButton>
      <ToolbarDynamicButton ariaLabel={placeholder} onClick={() => setOpen(true)}>
        <Search className="h-5 w-5" />
      </ToolbarDynamicButton>
    </div>
  );
  const defaultExpanded = (
    <div className="flex gap-2">
      <ToolbarDynamicButton ariaLabel="Back" onClick={() => setOpen(false)}>
        <ArrowLeft className="h-5 w-5" />
      </ToolbarDynamicButton>
      <div className="relative w-full">
        <input className="h-9 w-full rounded-lg border border-black/[0.08] bg-transparent px-3 py-2 text-sm text-[#171411] placeholder:text-[#8A7E72] focus:outline-none focus:ring-2 focus:ring-black/[0.08]" aria-label={placeholder} placeholder={placeholder} />
      </div>
    </div>
  );

  return (
    <MotionConfig transition={{ type: "spring", bounce: 0.1, duration: 0.2 }}>
      <div ref={ref} data-slot="toolbar-dynamic" className={cn("w-fit rounded-xl border border-black/[0.08] bg-white/92 shadow-[0_12px_34px_rgba(22,22,21,0.08),inset_0_1px_0_rgba(255,255,255,0.84)] backdrop-blur-[18px]", className)} style={style}>
        <motion.div animate={{ width: resolveToolbarWidth(isOpen ? expandedWidth : collapsedWidth) }} initial={false}>
          <div className="overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ height: contentHeight }}>
            <div ref={innerRef} className="p-2">
              {isOpen ? (expanded ?? defaultExpanded) : (compact ?? defaultCompact)}
            </div>
          </div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}

/**
 * Glow layer for a selected item, CTA, status, or focal element inside a relative parent. Avoid unfocused decorative halos.
 * @param mode Animation style; use static when motion would distract from dense content.
 * @param scale Expands the glow beyond the parent bounds; requires parent overflow to allow it.
 * @example <div className="relative overflow-visible rounded-2xl"><GlowEffect scale={1.08} blur="medium" /><Card className="relative">Selected plan</Card></div>
 * @see https://motion-primitives.com/docs/glow-effect
 */
export function GlowEffect({ className, style, colors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F"], mode = "rotate", blur = "medium", transition, scale = 1, duration = 5 }: GlowEffectProps) {
  const animationDuration = transition?.duration ?? duration;
  return (
    <div
      aria-hidden="true"
      data-slot="glow-effect"
      className={cn("pointer-events-none absolute inset-0 h-full w-full rounded-[inherit] transform-gpu", className)}
      style={{
        background: resolveGlowBackground(colors, mode),
        backgroundSize: mode === "flowHorizontal" || mode === "colorShift" ? "240% 100%" : undefined,
        filter: `blur(${resolveGlowBlur(blur)})`,
        transform: `scale(${scale})`,
        animation: `${resolveGlowAnimation(mode)} ${animationDuration}s linear infinite`,
        willChange: "transform, opacity, background-position",
        backfaceVisibility: "hidden",
        ...style,
      }}
    />
  );
}

/**
 * Concise feature tile with title, optional description, badges, and optional action.
 * @param badges Short metadata strings; long sentences belong in description.
 */
export function FeatureCard({ title, description, badges, actionLabel }: { title: string; description?: string; badges: string[]; actionLabel?: string }) {
  return (
    <Card className="bg-white/76">
      <CardHeader className={description ? "space-y-2" : "space-y-0"}>
        <CardTitle className="text-xl leading-6 text-[#161615]">{title}</CardTitle>
        {description ? <CardDescription className="text-[#595856]">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <PillRow items={badges} />
      </CardContent>
      {actionLabel ? (
        <CardFooter className="pt-0">
          <Button variant="tertiary" size="sm">
            {actionLabel}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Container for a small set of Stat components. */
export function StatGrid({ children }: PropsWithChildren) {
  return <div className="grid gap-3 md:grid-cols-3">{children}</div>;
}

/** Compact metric label/value pair. */
export function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "accent" | "muted" }) {
  const toneClass = tone === "accent" ? "border-[#FBC1B6]/70 bg-[#FFF1EC]" : tone === "muted" ? "border-black/[0.06] bg-[#F1EFE9]" : "border-black/[0.06] bg-white/76";
  return (
    <div className={`rounded-[16px] border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-[14px] ${toneClass}`}>
      <div className="text-xs uppercase tracking-[0.18em] text-[#ABAAA6]">{label}</div>
      <div className="mt-2 text-xl font-semibold text-[#161615]">{value}</div>
    </div>
  );
}

/**
 * Single numeric knob. Use Slider for multi-value ranges.
 * @param value Source knob value; synced when generated source props change.
 */
const clampTickSliderValue = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function TickSlider({ value = 0, min = 0, max = 100, step = 1 }: { value?: number; min?: number; max?: number; step?: number }) {
  const [currentValue, setCurrentValue] = useState(clampTickSliderValue(value, min, max));
  useEffect(() => {
    // Streaming partial TSX can mount `<TickSlider />` before `value={...}` arrives; sync only on source prop changes so local drags still survive ordinary rerenders.
    setCurrentValue(clampTickSliderValue(value, min, max));
  }, [value, min, max]);
  return (
    <div className="flex w-full items-center gap-2">
      <input type="range" aria-label="Slider value" min={min} max={max} step={step} value={currentValue} className="w-full" onChange={(event) => setCurrentValue(Number(event.target.value))} />
      <span className="w-10 text-right text-xs text-[#667085]">{currentValue}</span>
    </div>
  );
}

/**
 * Compact choice grid for explicit option selection.
 * @param columns Visual column count, clamped to 1-3.
 * @param defaultValue Initially selected item value; falls back to the first item.
 */
export function SelectionGrid({ items, columns = 2, defaultValue }: { items: SelectionGridItem[]; columns?: number; defaultValue?: string }) {
  const [selectedValue, setSelectedValue] = useState(defaultValue ?? items[0]?.value ?? "");
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, columns))}, minmax(0, 1fr))` }}>
      {items.map((item, index) => {
        const active = item.value === selectedValue;
        return (
          <button key={`${item.value}-${index}`} type="button" className={`relative rounded-lg border px-3 py-2 text-sm ${active ? "border-[#8CA62A] bg-[#F6FAE8]" : "border-[#D0D5DD] bg-white"}`} onClick={() => setSelectedValue(item.value)}>
            <span className="absolute right-2 top-1 text-xs text-[#667085]">{active ? "✓" : ""}</span>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
