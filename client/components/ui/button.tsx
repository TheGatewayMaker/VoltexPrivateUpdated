import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[1rem] border border-transparent text-sm font-semibold uppercase tracking-[0.2em] ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-primary/25 bg-[linear-gradient(180deg,hsl(var(--primary))_0%,hsl(var(--primary)/0.84)_100%)] text-primary-foreground shadow-[0_14px_34px_rgba(0,114,92,0.3),inset_0_1px_0_rgba(255,255,255,0.1)] hover:border-primary/38 hover:bg-[linear-gradient(180deg,hsl(var(--primary)/0.98)_0%,hsl(var(--primary)/0.8)_100%)] hover:shadow-[0_18px_40px_rgba(0,114,92,0.34),inset_0_1px_0_rgba(255,255,255,0.14)]",
        destructive:
          "border-destructive/30 bg-[linear-gradient(180deg,hsl(var(--destructive))_0%,hsl(var(--destructive)/0.88)_100%)] text-destructive-foreground shadow-[0_12px_28px_rgba(127,29,29,0.24)] hover:border-destructive/45 hover:bg-[linear-gradient(180deg,hsl(var(--destructive)/0.98)_0%,hsl(var(--destructive)/0.82)_100%)]",
        outline:
          "border-border/72 bg-transparent text-foreground shadow-none hover:border-primary/28 hover:bg-accent/72 hover:text-accent-foreground",
        secondary:
          "border-border/70 bg-secondary/78 text-secondary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-primary/24 hover:bg-accent/80",
        ghost:
          "bg-transparent text-foreground/88 hover:bg-accent/68 hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 px-8",
        icon: "h-10 w-10 rounded-[0.95rem] px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
