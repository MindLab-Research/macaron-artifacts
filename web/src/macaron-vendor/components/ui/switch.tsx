import React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/style";

/** Use Switch for immediate on/off settings. For switches/toggles, import and use the local <Switch checked={state} onCheckedChange={setState} />; do not hand-roll a switch with button/span, aria-checked, data-state, or runtime-composed translate classes because missing thumb-position state makes on/off both appear on the left. */
const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer group inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-black/[0.08] p-px transition-[background-color,border-color,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#161615] data-[state=checked]:bg-[#161615] data-[state=checked]:hover:border-[#20201F] data-[state=checked]:hover:bg-[#20201F] data-[state=checked]:active:border-[#2A2A29] data-[state=checked]:active:bg-[#2A2A29] data-[state=unchecked]:bg-[#E9E7E2] data-[state=unchecked]:hover:border-black/[0.12] data-[state=unchecked]:hover:bg-[#E2DFD8] data-[state=unchecked]:active:border-black/[0.16] data-[state=unchecked]:active:bg-[#DAD8D3]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full border border-black/[0.08] bg-white ring-0 transition-[transform,background-color,border-color] group-active:bg-[#F1EFE9] data-[state=checked]:[transform:translateX(1.25rem)] data-[state=unchecked]:[transform:translateX(0)]" />
  </SwitchPrimitive.Root>
));

Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
