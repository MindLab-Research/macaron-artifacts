import React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/style";

/**
 * Range or multi-value numeric control. Use TickSlider for a single knob.
 * @param value Controlled array; one thumb is rendered per value slot.
 * @param defaultValue Uncontrolled array; omit it to get a two-thumb min/max range.
 */
const Slider = React.forwardRef<React.ComponentRef<typeof SliderPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>>(({ className, defaultValue, value, min = 0, max = 100, ...props }, ref) => {
  // Mirror shadcn: one thumb per value slot. A scalar default would otherwise collapse to a single knob.
  const values = React.useMemo(() => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]), [value, defaultValue, min, max]);

  return (
    <SliderPrimitive.Root
      ref={ref}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn("group relative flex w-full touch-none select-none items-center data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col", className)}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-2.5 w-full grow overflow-hidden rounded-full bg-black/[0.08] transition-colors duration-200 ease-out group-hover:bg-black/[0.1] group-active:bg-black/[0.13] data-[orientation=vertical]:h-full data-[orientation=vertical]:w-2.5">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-macaron-gradient-new data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {Array.from({ length: values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          data-slot="slider-thumb"
          className="block h-5 w-5 rounded-full border border-black/[0.1] bg-white ring-offset-background transition-[background-color,border-color,opacity] duration-200 ease-out hover:border-black/[0.16] hover:bg-[#FFFCF8] active:border-black/[0.2] active:bg-[#E2DFD8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  );
});

Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
