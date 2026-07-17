import React from "react";
import { cn } from "@/lib/style";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line text entry for notes or long input. Do not use it as decorative body text. */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "flex min-h-[96px] w-full rounded-[14px] border border-black/[0.08] bg-[#F1EFE9]/[0.82] px-4 py-3 text-sm text-[#161615] ring-offset-background transition-[background-color,border-color,color,opacity] duration-200 ease-out placeholder:text-[#ABAAA6] hover:border-black/[0.12] hover:bg-[#EAE8E2] active:border-black/[0.16] active:bg-[#E2DFD8] focus-visible:border-black/[0.12] focus-visible:bg-white/[0.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));

Textarea.displayName = "Textarea";

export { Textarea };
