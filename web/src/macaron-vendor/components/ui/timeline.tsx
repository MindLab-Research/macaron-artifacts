"use client";

import React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/style";

type TimelineContextValue = {
  activeStep: number;
  setActiveStep: (step: number) => void;
  orientation: TimelineOrientation;
};
type TimelineItemContextValue = {
  completed: boolean;
  lineCompleted: boolean;
  step: number;
};
type TimelineOrientation = "horizontal" | "vertical";
export interface TimelineProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue?: number;
  value?: number;
  onValueChange?: (value: number) => void;
  orientation?: TimelineOrientation;
}
export interface TimelineItemProps extends React.HTMLAttributes<HTMLDivElement> {
  step: number;
}
export interface TimelineDateProps extends React.HTMLAttributes<HTMLTimeElement> {
  asChild?: boolean;
}
export interface TimelineIndicatorProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

const TimelineContext = React.createContext<TimelineContextValue | null>(null);
const TimelineItemContext = React.createContext<TimelineItemContextValue | null>(null);

const useTimeline = () => {
  const context = React.useContext(TimelineContext);
  if (!context) throw new Error("Timeline compound components must be used inside Timeline.");
  return context;
};
const useTimelineItem = () => {
  const context = React.useContext(TimelineItemContext);
  if (!context) throw new Error("TimelineIndicator and TimelineSeparator must be used inside TimelineItem.");
  return context;
};

/**
 * Chronological event or workflow step list. Use `defaultValue` or `value` as the active/completed step and put each event in a `TimelineItem`.
 * @param orientation Vertical for activity feeds and process histories; horizontal for 3-4 compact milestones.
 * @example <Timeline defaultValue={2}><TimelineItem step={1}><TimelineHeader><TimelineDate>March</TimelineDate><TimelineTitle>Started</TimelineTitle></TimelineHeader><TimelineIndicator /><TimelineSeparator /><TimelineContent>Kickoff complete.</TimelineContent></TimelineItem></Timeline>
 * @see https://reui.io/docs/components/radix/timeline
 */
function Timeline({ defaultValue = 1, value, onValueChange, orientation = "vertical", className, children, ...props }: TimelineProps) {
  const [internalStep, setInternalStep] = React.useState(defaultValue);
  const currentStep = value ?? internalStep;
  const setActiveStep = React.useCallback(
    (step: number) => {
      if (value === undefined) setInternalStep(step);
      onValueChange?.(step);
    },
    [onValueChange, value],
  );
  const contextValue = React.useMemo(() => ({ activeStep: currentStep, setActiveStep, orientation }), [currentStep, orientation, setActiveStep]);
  return (
    <TimelineContext.Provider value={contextValue}>
      <div data-slot="timeline" data-orientation={orientation} className={cn("group/timeline flex data-[orientation=horizontal]:w-full data-[orientation=horizontal]:flex-row data-[orientation=vertical]:flex-col", className)} {...props}>
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

/** Single timeline event. `step` controls completed styling relative to the parent Timeline active value. */
function TimelineItem({ step, className, children, ...props }: TimelineItemProps) {
  const { activeStep } = useTimeline();
  const completed = step <= activeStep;
  const lineCompleted = step < activeStep;
  const contextValue = React.useMemo(() => ({ completed, lineCompleted, step }), [completed, lineCompleted, step]);
  return (
    <TimelineItemContext.Provider value={contextValue}>
      <div
        aria-current={step === activeStep ? "step" : undefined}
        data-slot="timeline-item"
        data-completed={completed || undefined}
        className={cn("group/timeline-item relative flex flex-1 flex-col gap-0.5 group-data-[orientation=horizontal]/timeline:mt-8 group-data-[orientation=horizontal]/timeline:not-last:pe-8 group-data-[orientation=vertical]/timeline:ms-8 group-data-[orientation=vertical]/timeline:not-last:pb-6", className)}
        {...props}
      >
        {children}
      </div>
    </TimelineItemContext.Provider>
  );
}

/** Header row for the date and title of a timeline event. */
function TimelineHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="timeline-header" className={cn(className)} {...props} />;
}

/** Date or relative time label for a timeline event. Use `asChild` when rendering a custom time/link element. */
function TimelineDate({ asChild = false, className, ...props }: TimelineDateProps) {
  const Comp = asChild ? Slot : "time";
  return <Comp data-slot="timeline-date" className={cn("mb-1 block text-xs font-medium text-[#8A7E72] group-data-[orientation=vertical]/timeline:max-sm:h-4", className)} {...props} />;
}

/** Event title. Keep it concise so horizontal timelines do not wrap awkwardly. */
function TimelineTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 data-slot="timeline-title" className={cn("m-0 text-sm font-semibold leading-5 text-[#171411]", className)} {...props}>
      {children}
    </h3>
  );
}

/** Indicator dot/icon for a timeline event. Click to activate this step. */
function TimelineIndicator({ asChild = false, className, children, onClick, type, ...props }: TimelineIndicatorProps) {
  const { completed, step } = useTimelineItem();
  const { setActiveStep } = useTimeline();
  const Comp = asChild ? Slot : "button";
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (!event.defaultPrevented) setActiveStep(step);
    },
    [onClick, setActiveStep, step],
  );
  return (
    <Comp
      aria-label={`Activate timeline step ${step}`}
      data-slot="timeline-indicator"
      data-completed={completed || undefined}
      type={type ?? "button"}
      className={cn(
        "absolute size-4 rounded-full border-2 bg-white p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#EE5C2A] group-data-[orientation=horizontal]/timeline:-top-6 group-data-[orientation=horizontal]/timeline:left-0 group-data-[orientation=horizontal]/timeline:-translate-y-1/2 group-data-[orientation=vertical]/timeline:top-0 group-data-[orientation=vertical]/timeline:-left-6 group-data-[orientation=vertical]/timeline:-translate-x-1/2",
        completed ? "border-[#EE5C2A]" : "border-[#EE5C2A]/24",
        className,
      )}
      onClick={handleClick}
      {...props}
    >
      {children}
    </Comp>
  );
}

/** Connector line between timeline indicators. It hides automatically on the last item. */
function TimelineSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { lineCompleted } = useTimelineItem();
  return (
    <div
      aria-hidden="true"
      data-slot="timeline-separator"
      data-completed={lineCompleted || undefined}
      className={cn(
        "absolute self-start transition-colors group-last/timeline-item:hidden group-data-[orientation=horizontal]/timeline:-top-6 group-data-[orientation=horizontal]/timeline:h-0.5 group-data-[orientation=horizontal]/timeline:w-[calc(100%-1rem-0.25rem)] group-data-[orientation=horizontal]/timeline:translate-x-[1.125rem] group-data-[orientation=horizontal]/timeline:-translate-y-1/2 group-data-[orientation=vertical]/timeline:-left-6 group-data-[orientation=vertical]/timeline:h-[calc(100%-1rem-0.25rem)] group-data-[orientation=vertical]/timeline:w-0.5 group-data-[orientation=vertical]/timeline:-translate-x-1/2 group-data-[orientation=vertical]/timeline:translate-y-[1.125rem]",
        lineCompleted ? "bg-[#EE5C2A]" : "bg-[#EE5C2A]/12",
        className,
      )}
      {...props}
    />
  );
}

/** Supporting event details. Keep long prose here rather than inside TimelineTitle. */
function TimelineContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="timeline-content" className={cn("text-sm leading-6 text-[#6F655B]", className)} {...props} />;
}

export { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle };
