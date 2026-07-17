import React from "react";
import { cn } from "@/lib/style";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** Single-line text entry. Avoid form-heavy defaults unless the prompt explicitly asks for input. */
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      "flex h-11 w-full rounded-[14px] border border-black/[0.08] bg-[#F1EFE9]/[0.82] px-4 py-2 text-sm text-[#161615] ring-offset-background transition-[background-color,border-color,color,opacity] duration-200 ease-out file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[#ABAAA6] hover:border-black/[0.12] hover:bg-[#EDEBE5] active:border-black/[0.16] active:bg-[#E2DFD8] focus-visible:border-black/[0.12] focus-visible:bg-white/[0.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/[0.08] focus-visible:ring-offset-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));

Input.displayName = "Input";

export { Input };
