import React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/style";

const buttonVariants = cva("demo-motion-ease inline-flex items-center justify-center whitespace-nowrap rounded-full font-medium transition-[background-color,color,border-color,filter,opacity,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2", {
  variants: {
    variant: {
      default: "bg-[#161615] text-primary-foreground hover:bg-[#343330] active:bg-[#4A4843]",
      destructive: "bg-destructive text-destructive-foreground hover:bg-[#B91C1C] active:bg-[#991B1B]",
      outline: "border border-black/[0.08] bg-white/[0.78] text-[#161615] hover:border-black/[0.14] hover:bg-[#F1EFE9] active:border-black/[0.18] active:bg-[#E2DFD8]",
      secondary: "bg-[#F1EFE9] text-[#2A2A29] hover:bg-[#E9E7E2] active:bg-[#E2DFD8]",
      tertiary: "border border-black/[0.06] bg-black/[0.03] text-[#2A2A29] hover:border-black/[0.1] hover:bg-black/[0.05] active:border-black/[0.14] active:bg-black/[0.06]",
      ghost: "text-[#6F655B] hover:bg-[#F1EFE9] hover:text-[#161615] active:bg-[#E2DFD8]",
      link: "text-primary underline-offset-4 hover:underline",
      primary: ["bg-gradient-to-br from-yellow-400 via-pink-500 to-red-500", "text-white", "border border-white/70", "rounded-full", "hover:brightness-105 hover:saturate-110 active:brightness-95 active:saturate-125"],
      macaron: ["bg-macaron-gradient", "noise-background", "text-white", "border border-white/70", "rounded-full", "hover:brightness-105 hover:saturate-110 active:brightness-95 active:saturate-125"],
      "macaron-new": ["bg-macaron-gradient-new", "text-white", "backdrop-blur-[120px]", "ring-[1px] ring-white/40 ring-inset", "px-4 md:px-5", "rounded-full", "hover:brightness-105 hover:saturate-110 active:brightness-95 active:saturate-125"],
    },
    disabled: {
      true: ["pointer-events-none", "bg-[#DAD8D3]", "text-white", "rounded-full", "border border-white/30", "shadow-none", "cursor-not-allowed"],
    },
    size: {
      default: "h-10 px-4 py-2",
      sm: "h-9 rounded-full px-3 text-sm",
      lg: "h-11 rounded-full px-8 text-base",
      xl: "h-14 rounded-full px-10 text-base",
      icon: "h-10 w-10 rounded-full",
    },
    full: {
      true: "w-full",
    },
  },
  compoundVariants: [{ variant: "macaron-new", disabled: true, className: "bg-macaron-gradient-new border-none opacity-20" }],
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  full?: boolean;
  disabled?: boolean;
}

/**
 * Command control for explicit user actions. Set size/variant deliberately; do not leave primary CTAs on defaults when the surrounding surface has a custom visual system.
 * @param full Expands to the full available width, useful for stacked mobile actions.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, full, size, asChild = false, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className, full, disabled }))} ref={ref} disabled={disabled} {...props} />;
});

Button.displayName = "Button";

export { Button, buttonVariants };
