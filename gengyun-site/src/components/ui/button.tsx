import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--site-accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[var(--site-accent)] text-[var(--site-on-accent)] hover:opacity-90",
        outline:
          "border border-[var(--site-border)] bg-transparent text-[var(--site-fg)] hover:bg-[var(--gy-green-soft)]",
        ghost: "text-[var(--site-fg)] hover:bg-[var(--gy-green-soft)]",
        secondary: "bg-[var(--gy-green-soft)] text-[var(--gy-green-deep)] hover:opacity-90",
        link: "text-[var(--site-accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-[40px] px-4",
        sm: "min-h-[36px] px-3 text-[13px]",
        lg: "min-h-[46px] px-6 text-base",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
