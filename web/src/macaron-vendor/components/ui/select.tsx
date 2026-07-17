import React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/style";

/** Root for a dropdown selection control. */
const Select = SelectPrimitive.Root;
/** Renders current value or placeholder inside SelectTrigger. */
const SelectValue = SelectPrimitive.Value;
/** Groups related options in SelectContent. */
const SelectGroup = SelectPrimitive.Group;

/** Visible control that opens the dropdown. */
const SelectTrigger = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-between gap-2 rounded-sm border border-black/[0.06] bg-white px-2.5 text-[13px] font-440 text-[#6F655B] shadow-none outline-none transition-[border-color,color,background-color,box-shadow,opacity] duration-200 ease-out hover:border-black/[0.1] hover:bg-[#F1EFE9] hover:text-[#171411] active:border-black/[0.14] active:bg-[#E2DFD8] focus:border-black/[0.1] focus:text-[#171411] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-[#6F655B] data-[state=open]:border-black/[0.12] data-[state=open]:bg-[#E9E7E2] data-[state=open]:text-[#171411]",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 shrink-0 opacity-70" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/**
 * Dropdown panel for options.
 * @param position Use "popper" when the panel should match trigger width and position like a floating menu.
 */
const SelectContent = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(({ className, children, position = "item-aligned", sideOffset = 6, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={sideOffset}
      className={cn(
        "relative z-50 min-w-[8rem] overflow-hidden rounded-sm border border-black/[0.06] bg-white text-[#171411] shadow-[0_8px_24px_-12px_rgba(23,20,17,0.12)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className={cn("p-1", position === "popper" && "min-w-[var(--radix-select-trigger-width)]")}>
        <div className="flex flex-col gap-0.5">{children}</div>
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

/** Selectable option row. The value prop is required by Radix even when label text is visible. */
const SelectItem = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex h-8 cursor-default select-none items-center rounded-sm py-1 pl-2 pr-8 text-[13px] font-440 text-[#6F655B] outline-none transition-[background-color,color] duration-150 hover:bg-[#F1EFE9] hover:text-[#171411] active:bg-[#E2DFD8] focus:bg-[#F1EFE9] focus:text-[#171411] data-[highlighted]:bg-[#F1EFE9] data-[highlighted]:text-[#171411] data-[state=checked]:bg-[#F8F6F2] data-[state=checked]:text-[#171411]",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <span className="absolute right-2 inline-flex h-4 w-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

/** Non-selectable label for an option group. */
const SelectLabel = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Label>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>>(({ className, ...props }, ref) => <SelectPrimitive.Label ref={ref} className={cn("px-2 py-1.5 text-[12px] font-440 text-[#8A7E72]", className)} {...props} />);
SelectLabel.displayName = SelectPrimitive.Label.displayName;

/** Divider between option groups. */
const SelectSeparator = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Separator>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>>(({ className, ...props }, ref) => <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-black/[0.06]", className)} {...props} />);
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
