import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-app-button text-app-button-text hover:bg-app-button/90',
        warning: 'bg-app-warning text-app-primary-text hover:bg-app-warning/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        destructiveOutline: 'border border-destructive bg-transparent text-destructive hover:bg-transparent hover:text-destructive',
        destructiveSoft: 'bg-destructive/10 text-destructive hover:bg-destructive/15 active:bg-destructive/20',
        outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
        soft: 'bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.11] active:bg-foreground/[0.14]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        plain: 'bg-transparent',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 py-2 leading-none',
        xs: 'h-6 rounded-md px-2 text-xs leading-none [&_svg]:size-3',
        sm: 'h-8 rounded-md px-2.5 text-xs leading-none [&_svg]:size-3.5',
        lg: 'h-10 rounded-md px-4 leading-none',
        icon: 'h-9 w-9',
        'icon-xs': 'size-6 rounded-md [&_svg]:size-3',
        'icon-sm': 'size-8 rounded-md [&_svg]:size-3.5',
      },
    },
    compoundVariants: [
      { variant: 'secondary', size: 'icon-sm', class: 'hover:bg-accent' },
      { variant: 'soft', size: 'sm', class: 'rounded-lg px-3' },
      { variant: 'destructiveSoft', size: 'sm', class: 'rounded-lg px-3' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
