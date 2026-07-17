import React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/style";

/** Lightweight floating content for date pickers, compact menus, or contextual detail. */
const Popover = PopoverPrimitive.Root;
/** Element that opens the floating content. */
const PopoverTrigger = PopoverPrimitive.Trigger;
/** Anchor target when floating content should position against an element that is not the trigger. */
const PopoverAnchor = PopoverPrimitive.Anchor;
/** Element that closes the floating content from within the panel. */
const PopoverClose = PopoverPrimitive.Close;

/**
 * Floating panel; keep it compact and aligned to the trigger.
 * @param align Horizontal alignment against the anchor/trigger.
 * @param sideOffset Gap between trigger and panel in pixels.
 */
const PopoverContent = React.forwardRef<React.ComponentRef<typeof PopoverPrimitive.Content>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(({ className, align = "center", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-[16px] border border-black/[0.08] bg-white/95 p-4 text-[#171411] shadow-[0_18px_48px_rgba(23,20,17,0.16)] outline-none backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

/** Small header block for titled popover panels. */
const PopoverHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} className={cn("grid gap-1.5", className)} {...props} />);
PopoverHeader.displayName = "PopoverHeader";

/** Compact popover title. */
const PopoverTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, children, ...props }, ref) => (
  <h4 ref={ref} className={cn("text-sm font-semibold leading-none tracking-[-0.01em]", className)} {...props}>
    {children}
  </h4>
));
PopoverTitle.displayName = "PopoverTitle";

/** Supporting copy below a popover title. */
const PopoverDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, ...props }, ref) => <p ref={ref} className={cn("text-sm leading-5 text-[#6F655B]", className)} {...props} />);
PopoverDescription.displayName = "PopoverDescription";

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
