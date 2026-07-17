import React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/style";

/**
 * One-of-many selection when the prompt explicitly asks for a choice control.
 * @param value Controlled selected option.
 * @param defaultValue Initial selected option for uncontrolled usage.
 */
const RadioGroup = React.forwardRef<React.ComponentRef<typeof RadioGroupPrimitive.Root>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>>(({ className, ...props }, ref) => <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-2", className)} {...props} />);
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

/** Option control. Pair it with visible text via label/htmlFor or an adjacent Label. */
const RadioGroupItem = React.forwardRef<React.ComponentRef<typeof RadioGroupPrimitive.Item>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-black/[0.12] bg-white/70 text-[#161615] ring-offset-background transition-[background-color,border-color,color,opacity] duration-200 ease-out hover:border-black/[0.16] hover:bg-[#F1EFE9] active:border-black/[0.18] active:bg-[#E2DFD8] focus:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#161615] data-[state=checked]:bg-[#F1EFE9] data-[state=checked]:hover:bg-[#E9E7E2] data-[state=checked]:active:bg-[#E2DFD8]",
      className,
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator
      forceMount
      className="pointer-events-none absolute left-1/2 top-1/2 block size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-0 scale-0 transition-[transform,opacity] duration-200 ease-out data-[state=checked]:opacity-100 data-[state=checked]:scale-100 data-[state=unchecked]:opacity-0 data-[state=unchecked]:scale-0"
    />
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
