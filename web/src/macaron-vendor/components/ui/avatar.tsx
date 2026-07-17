import React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/style";

type AvatarSize = "sm" | "default" | "lg";
type AvatarProps = React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & { size?: AvatarSize };
const AVATAR_SIZE_CLASS: Record<AvatarSize, string> = { sm: "h-8 w-8 text-xs", default: "h-10 w-10 text-sm", lg: "h-14 w-14 text-base" };

/** User, team, or entity avatar. Always provide alt text on AvatarImage when the image identifies a person. */
const Avatar = React.forwardRef<React.ComponentRef<typeof AvatarPrimitive.Root>, AvatarProps>(({ className, size = "default", ...props }, ref) => <AvatarPrimitive.Root ref={ref} data-slot="avatar" className={cn("relative flex shrink-0 overflow-hidden rounded-full", AVATAR_SIZE_CLASS[size], className)} {...props} />);
Avatar.displayName = AvatarPrimitive.Root.displayName;

/** Avatar image. Pair it with AvatarFallback so failed or slow images still identify the entity. */
const AvatarImage = React.forwardRef<React.ComponentRef<typeof AvatarPrimitive.Image>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} data-slot="avatar-image" className={cn("aspect-square h-full w-full object-cover", className)} {...props} />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

/** Text or icon fallback for an avatar image. Keep initials short. */
const AvatarFallback = React.forwardRef<React.ComponentRef<typeof AvatarPrimitive.Fallback>, React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback ref={ref} data-slot="avatar-fallback" className={cn("flex h-full w-full items-center justify-center rounded-full bg-[#F1EFE9] font-medium text-[#6F655B]", className)} {...props} />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

/** Small status marker anchored to the avatar edge. */
function AvatarBadge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="avatar-badge" className={cn("absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-[#22C55E]", className)} {...props} />;
}

/** Overlapping avatar stack for compact teams or assignees. */
function AvatarGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="avatar-group" className={cn("flex items-center -space-x-2 [&_[data-slot=avatar]]:ring-2 [&_[data-slot=avatar]]:ring-white", className)} {...props} />;
}

/** Count chip for hidden members in an AvatarGroup. */
function AvatarGroupCount({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="avatar-group-count" className={cn("z-10 flex h-10 w-10 items-center justify-center rounded-full bg-[#171411] text-xs font-semibold text-white ring-2 ring-white", className)} {...props} />;
}

export { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage };
