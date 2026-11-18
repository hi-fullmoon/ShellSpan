import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, autoComplete = "off", ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      autoComplete={autoComplete}
      data-slot="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-input-surface px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
