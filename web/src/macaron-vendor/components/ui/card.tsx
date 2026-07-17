import React from "react";
import { cn } from "@/lib/style";

const CARD_PADDING_CLASS = { 0: "p-0", 1: "p-1", 2: "p-2", 3: "p-3", 4: "p-4", 5: "p-5", 6: "p-6" } as const;
type CardPadding = keyof typeof CARD_PADDING_CLASS;
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
}

/**
 * Framed container for repeated items or a clearly bounded section. Do not default the whole generated output to one large top-level Card.
 * @param padding Numeric spacing shortcut for simple cards; omit it when CardHeader/CardContent/CardFooter already own the spacing.
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, padding, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    className={cn("min-w-0 overflow-hidden rounded-[16px] border border-black/[0.08] bg-white/82 text-card-foreground shadow-[0_10px_30px_rgba(22,22,21,0.04),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-[18px]", typeof padding === "number" ? CARD_PADDING_CLASS[padding] : "", className)}
    {...props}
  />
));
Card.displayName = "Card";

/** Header area when a Card needs grouped title, description, or top metadata. */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} data-slot="card-header" className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />);
CardHeader.displayName = "CardHeader";

/** Card-local heading; keep hero-scale typography outside cards. */
const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, children, ...props }, ref) => (
  <h3 ref={ref} data-slot="card-title" className={cn("text-2xl font-semibold leading-none tracking-[-0.02em]", className)} {...props}>
    {children}
  </h3>
));
CardTitle.displayName = "CardTitle";

/** Supporting copy for a CardTitle; keep it brief enough to scan. */
const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, ...props }, ref) => <p ref={ref} data-slot="card-description" className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} />);
CardDescription.displayName = "CardDescription";

/** Main card body. Pair with CardHeader/CardFooter only when the card structure needs those regions. */
const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} data-slot="card-content" className={cn("p-6 pt-0", className)} {...props} />);
CardContent.displayName = "CardContent";

/** Footer row for secondary actions or summary metadata, not for primary page navigation. */
const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} data-slot="card-footer" className={cn("flex items-center gap-2 p-6 pt-0", className)} {...props} />);
CardFooter.displayName = "CardFooter";

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
