import React from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, getDefaultClassNames, type ChevronProps, type DayButtonProps, type RootProps, type WeekNumberProps } from "react-day-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/style";

type CalendarProps = React.ComponentProps<typeof DayPicker> & { buttonVariant?: React.ComponentProps<typeof Button>["variant"] };
type CalendarDayButtonProps = DayButtonProps & { locale?: CalendarProps["locale"] };

const CalendarRoot = ({ className, rootRef, ...props }: RootProps) => <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />;

const CalendarChevron = ({ className, orientation, ...props }: ChevronProps) => {
  const Icon = orientation === "left" ? ChevronLeft : orientation === "right" ? ChevronRight : ChevronDown;
  return <Icon className={cn("h-4 w-4", className)} {...props} />;
};

const CalendarWeekNumber = ({ children, ...props }: WeekNumberProps) => (
  <td {...props}>
    <div className="flex h-[--cell-size] w-[--cell-size] items-center justify-center text-center">{children}</div>
  </td>
);

/** Date picking or calendar display. Pair with Popover for compact pickers instead of showing a large calendar by default. */
function Calendar({ className, classNames, showOutsideDays = true, captionLayout = "label", buttonVariant = "ghost", locale, formatters, components, ...props }: CalendarProps) {
  const defaultClassNames = getDefaultClassNames();
  const dayButton = React.useCallback((props: DayButtonProps) => <CalendarDayButton locale={locale} {...props} />, [locale]);
  const resolvedComponents = React.useMemo<CalendarProps["components"]>(() => ({ Root: CalendarRoot, Chevron: CalendarChevron, DayButton: dayButton, WeekNumber: CalendarWeekNumber, ...components }), [components, dayButton]);
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout={captionLayout}
      locale={locale}
      formatters={{ formatMonthDropdown: (date) => date.toLocaleString(locale?.code, { month: "short" }), ...formatters }}
      className={cn("group/calendar w-fit bg-transparent p-3 [--cell-size:2rem]", className)}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn("relative flex flex-col gap-4 md:flex-row", defaultClassNames.months),
        month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
        nav: cn("absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1", defaultClassNames.nav),
        button_previous: cn(buttonVariants({ variant: buttonVariant, size: "icon" }), "h-[--cell-size] w-[--cell-size] select-none rounded-md p-0 text-[#6F655B] aria-disabled:opacity-35", defaultClassNames.button_previous),
        button_next: cn(buttonVariants({ variant: buttonVariant, size: "icon" }), "h-[--cell-size] w-[--cell-size] select-none rounded-md p-0 text-[#6F655B] aria-disabled:opacity-35", defaultClassNames.button_next),
        month_caption: cn("flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]", defaultClassNames.month_caption),
        dropdowns: cn("flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium", defaultClassNames.dropdowns),
        dropdown_root: cn("relative rounded-md border border-black/[0.08] bg-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] focus-within:ring-2 focus-within:ring-black/[0.08]", defaultClassNames.dropdown_root),
        dropdown: cn("absolute inset-0 opacity-0", defaultClassNames.dropdown),
        caption_label: cn("select-none font-medium text-[#171411]", captionLayout === "label" ? "text-sm" : "flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:text-[#8A7E72]", defaultClassNames.caption_label),
        month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn("flex-1 select-none rounded-md text-[0.8rem] font-normal text-[#8A7E72]", defaultClassNames.weekday),
        week: cn("mt-2 flex w-full", defaultClassNames.week),
        week_number_header: cn("w-[--cell-size] select-none", defaultClassNames.week_number_header),
        week_number: cn("select-none text-[0.8rem] text-[#8A7E72]", defaultClassNames.week_number),
        day: cn("group/day relative aspect-square h-full w-full select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md", defaultClassNames.day),
        range_start: cn("rounded-l-md bg-[#F1EFE9]", defaultClassNames.range_start),
        range_middle: cn("rounded-none bg-[#F1EFE9]", defaultClassNames.range_middle),
        range_end: cn("rounded-r-md bg-[#F1EFE9]", defaultClassNames.range_end),
        today: cn("rounded-md bg-[#F1EFE9] text-[#171411] data-[selected=true]:rounded-none", defaultClassNames.today),
        outside: cn("text-[#B7AEA5] aria-selected:text-[#B7AEA5]", defaultClassNames.outside),
        disabled: cn("text-[#B7AEA5] opacity-50", defaultClassNames.disabled),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={resolvedComponents}
      {...props}
    />
  );
}

function CalendarDayButton({ className, day, modifiers, locale, ...props }: CalendarDayButtonProps) {
  const defaultClassNames = getDefaultClassNames();
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-selected-single={modifiers.selected && !modifiers.range_start && !modifiers.range_end && !modifiers.range_middle}
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "flex aspect-square h-auto w-full min-w-[--cell-size] flex-col gap-1 rounded-md text-[13px] font-normal leading-none text-[#2D2925] hover:bg-[#F1EFE9] hover:text-[#171411] data-[range-end=true]:rounded-md data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-[#F1EFE9] data-[range-start=true]:rounded-md data-[selected-single=true]:bg-[#171411] data-[selected-single=true]:text-white data-[range-end=true]:bg-[#171411] data-[range-end=true]:text-white data-[range-start=true]:bg-[#171411] data-[range-start=true]:text-white group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-2 group-data-[focused=true]/day:ring-black/[0.08] [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day_button,
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
