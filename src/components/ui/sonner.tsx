import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps, toast } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useToastStore } from "@/stores/toastStore"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
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
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast shadow-[var(--shadow-toast)]',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
