"use client";

import React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/style";

/** Inline expandable content for FAQ/show-more sections. */
const Accordion = AccordionPrimitive.Root;

/** One expandable section. Its value must be unique within the parent Accordion. */
const AccordionItem = React.forwardRef<React.ComponentRef<typeof AccordionPrimitive.Item>, React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>>(({ className, ...props }, ref) => <AccordionPrimitive.Item ref={ref} className={cn("border-b", className)} {...props} />);
AccordionItem.displayName = "AccordionItem";

/** Clickable summary row with the built-in chevron. */
const AccordionTrigger = React.forwardRef<React.ComponentRef<typeof AccordionPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger ref={ref} className={cn("flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180", className)} {...props}>
      {children}
      <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionTriggerRed = React.forwardRef<React.ComponentRef<typeof AccordionPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger ref={ref} className={cn("text-left flex flex-1 gap-x-3 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>.trigger]:-rotate-90 [&[data-state=open]>*>.inner]:opacity-0", className)} {...props}>
      {children}
      <div className="trigger relative flex h-6 w-6 shrink-0 items-center justify-center transition-transform duration-200">
        <div className="h-6 w-[1px] bg-red-600" />
        <div className="inner absolute flex h-6 w-6 items-center justify-center transition-opacity duration-200">
          <div className="h-[1px] w-6 bg-red-600" />
        </div>
      </div>
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTriggerRed.displayName = AccordionPrimitive.Trigger.displayName;

/** Expanded body. Keep padding/content inside the child wrapper rather than on AccordionItem. */
const AccordionContent = React.forwardRef<React.ComponentRef<typeof AccordionPrimitive.Content>, React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content ref={ref} className="overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down" {...props}>
    <div className={cn("whitespace-pre-wrap pb-4 pt-0", className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger, AccordionTriggerRed };
