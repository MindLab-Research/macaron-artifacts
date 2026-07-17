"use client";

import React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/style";

const labelVariants = cva("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70");
type LabelProps = React.ComponentPropsWithoutRef<"label"> & { asChild?: boolean } & VariantProps<typeof labelVariants>;

// Keep wrapper props explicit so Monaco does not lose `children`/`htmlFor` on the Radix forwarded type.
/** Text label for form controls or compact settings fields. */
const Label = React.forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />);
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
