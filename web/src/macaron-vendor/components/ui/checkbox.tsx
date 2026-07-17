import React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/style";

/** Boolean or multi-select control for real settings/form flows, not a decorative checklist icon. */
const Checkbox = React.forwardRef<React.ComponentRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-[5px] border border-black/[0.12] bg-white/70 ring-offset-background transition-[background-color,border-color,color,opacity] duration-200 ease-out hover:border-black/[0.16] hover:bg-[#F1EFE9] active:border-black/[0.18] active:bg-[#E2DFD8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#161615] data-[state=checked]:bg-[#161615] data-[state=checked]:text-primary-foreground data-[state=checked]:hover:border-[#20201F] data-[state=checked]:hover:bg-[#20201F] data-[state=checked]:active:border-[#2A2A29] data-[state=checked]:active:bg-[#2A2A29]",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));

Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
