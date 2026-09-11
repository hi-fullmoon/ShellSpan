import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full rounded-lg border text-left has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] *:[svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground *:[svg]:row-span-2 *:[svg]:translate-y-0.5",
        subtle:
          "items-center border-transparent bg-transparent text-[color:var(--app-primary)] *:data-[slot=alert-description]:text-current *:[svg]:row-span-1 *:[svg]:translate-y-0",
        warning:
          "border-app-warning/40 bg-app-warning/10 text-app-warning *:data-[slot=alert-description]:text-app-warning/90 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current",
        destructiveSubtle:
          "border-destructive/20 bg-destructive/5 text-foreground *:data-[slot=alert-description]:text-muted-foreground *:[svg]:row-span-1 *:[svg]:translate-y-0 *:[svg]:text-destructive",
      },
      size: {
        default: "gap-0.5 px-2.5 py-2 text-sm has-[>svg]:gap-x-2 *:[svg:not([class*='size-'])]:size-4",
        sm: "gap-0.5 px-2 py-1.5 text-xs has-[>svg]:gap-x-2 *:[svg:not([class*='size-'])]:size-3.5",
        xs: "gap-0 px-1.5 py-1 text-xs has-[>svg]:gap-x-1.5 *:[svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Alert({
  className,
  variant,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-size={size}
      role="alert"
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground group-data-[size=sm]/alert:text-xs group-data-[size=xs]/alert:text-xs md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
