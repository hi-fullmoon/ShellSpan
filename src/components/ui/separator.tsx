import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 border-0 data-horizontal:border-t data-horizontal:border-border data-horizontal:w-full data-vertical:border-l data-vertical:border-border data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
