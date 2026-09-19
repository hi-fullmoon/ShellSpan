"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  menuPopupClassName,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            menuPopupClassName,
            "w-max min-w-32 max-w-[calc(100vw-16px)]",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

const ContextMenuGroup = DropdownMenuGroup

function ContextMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem
      className={cn("w-full px-2.5 py-1.5 text-left text-xs leading-4", className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuSeparator>) {
  return <DropdownMenuSeparator className={cn("mx-0 my-0.5", className)} {...props} />
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
}
