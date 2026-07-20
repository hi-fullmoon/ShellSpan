import { useEffect, useRef } from "react"
import { useTheme } from "@/hooks/useTheme"
import { Toaster as Sonner, type ToasterProps, toast } from "sonner"
import { CircleCheckIcon, InfoIcon, CircleAlertIcon, CircleXIcon, Loader2Icon } from "lucide-react"
import { useToastStore } from "@/stores/toastStore"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme = "light" } = useTheme()
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)
  const shownRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const t of toasts) {
      if (shownRef.current.has(t.id)) continue
      shownRef.current.add(t.id)

      switch (t.variant) {
        case "success":
          toast.success(t.message, {
            id: t.id,
            duration: t.duration,
            onDismiss: () => removeToast(t.id),
            onAutoClose: () => removeToast(t.id),
          })
          break
        case "error":
          toast.error(t.message, {
            id: t.id,
            duration: t.duration,
            onDismiss: () => removeToast(t.id),
            onAutoClose: () => removeToast(t.id),
          })
          break
        case "info":
        default:
          toast(t.message, {
            id: t.id,
            duration: t.duration,
            onDismiss: () => removeToast(t.id),
            onAutoClose: () => removeToast(t.id),
          })
          break
      }
    }
  }, [toasts])

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps["theme"]}
      className="toaster group"
      position="top-right"
      gap={8}
      offset={{ top: 56, right: 16 }}
      icons={{
        success: (
          <CircleCheckIcon className="toast-icon-filled size-4 text-[#52c41a]" />
        ),
        info: (
          <InfoIcon className="toast-icon-filled size-4 text-[#1677ff]" />
        ),
        warning: (
          <CircleAlertIcon className="toast-icon-filled size-4 text-[#faad14]" />
        ),
        error: (
          <CircleXIcon className="toast-icon-filled size-4 text-[#ff4d4f]" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin text-[#1677ff]" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            'w-auto! min-w-60! max-w-[var(--width)]! gap-2! px-4! py-[9px]! text-sm! shadow-[var(--shadow-toast)]!',
          icon: 'mt-[3px]! self-start!',
          title: 'font-normal!',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
