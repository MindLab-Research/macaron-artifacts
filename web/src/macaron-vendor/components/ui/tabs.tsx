"use client";

import React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/style";

type TabsProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & {
  items?: string[];
  onValueChange?: (value: string) => void;
};

/**
 * Mutually exclusive views; avoid tabs for content that should be compared side-by-side.
 * @param items Convenience labels that auto-render TabsList/TabsTrigger when children are omitted.
 */
const Tabs = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Root>, TabsProps>(({ className, items, value, defaultValue, children, ...props }, ref) => {
  const safeItems = Array.isArray(items) ? items : [];
  return (
    <TabsPrimitive.Root ref={ref} data-slot="tabs" value={value} defaultValue={defaultValue ?? safeItems[0]} className={cn("flex flex-col gap-2", className)} {...props}>
      {safeItems.length > 0 && !children ? (
        <TabsList>
          {safeItems.map((item) => (
            <TabsTrigger key={item} value={item}>
              {item}
            </TabsTrigger>
          ))}
        </TabsList>
      ) : (
        children
      )}
    </TabsPrimitive.Root>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

/** Horizontal trigger container. */
const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} data-slot="tabs-list" className={cn("inline-flex h-10 w-fit items-center justify-center gap-1 rounded-full bg-[#F1EFE9] p-1 text-[#6F6B66]", className)} {...props} />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/** Selectable tab label. value must match its TabsContent. */
const TabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-medium text-[#6F6B66] transition-[background-color,color,filter,opacity] duration-200 ease-out hover:bg-[#E9E7E2] hover:text-[#2A2A29] active:bg-[#E2DFD8] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white/[0.92] data-[state=active]:text-[#161615] data-[state=active]:hover:bg-white data-[state=active]:active:bg-white/[0.82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/** Panel for one tab value. */
const TabsContent = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Content>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} data-slot="tabs-content" className={cn("mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
