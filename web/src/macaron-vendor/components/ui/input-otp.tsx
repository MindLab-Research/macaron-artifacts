import React from "react";
import { OTPInput, OTPInputContext, type OTPInputProps } from "input-otp";
import { MinusIcon } from "lucide-react";
import { cn } from "@/lib/style";

/** One-time password input with paste support. Use InputOTPSlot children whose indexes are less than maxLength. */
const InputOTP = React.forwardRef<React.ComponentRef<typeof OTPInput>, OTPInputProps>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput ref={ref} data-slot="input-otp" containerClassName={cn("flex items-center gap-2 has-[:disabled]:opacity-50", containerClassName)} className={cn("disabled:cursor-not-allowed", className)} {...props} />
));
InputOTP.displayName = "InputOTP";

/** Visual group for adjacent OTP slots. */
function InputOTPGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="input-otp-group" className={cn("flex items-center", className)} {...props} />;
}

/** Single OTP character slot. The index points into the parent InputOTP value. */
function InputOTPSlot({ index, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { index: number }) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const slot = inputOTPContext.slots[index];
  const char = slot?.char ?? null;
  const hasFakeCaret = slot?.hasFakeCaret ?? false;
  const isActive = slot?.isActive ?? false;
  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive || undefined}
      className={cn(
        "relative flex h-10 w-10 items-center justify-center border-y border-r border-black/[0.08] bg-white text-sm font-medium text-[#171411] transition-all first:rounded-l-md first:border-l last:rounded-r-md data-[active=true]:z-10 data-[active=true]:ring-2 data-[active=true]:ring-black/[0.08]",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-pulse bg-[#171411]" />
        </div>
      ) : null}
    </div>
  );
}

/** Visual separator between OTP slot groups. */
function InputOTPSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="input-otp-separator" role="separator" className={cn("px-1 text-[#8A7E72]", className)} {...props}>
      <MinusIcon className="h-4 w-4" />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot };
