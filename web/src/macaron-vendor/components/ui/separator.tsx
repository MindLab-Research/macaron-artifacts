"use client";

import React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/style";

/** Single subtle divider. Avoid stacked or colored divider lines on tinted cards. */
const Separator = React.forwardRef<React.ComponentRef<typeof SeparatorPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root ref={ref} decorative={decorative} orientation={orientation} className={cn("shrink-0 bg-black/[0.06]", orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]", className)} {...props} />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;

export { Separator };
