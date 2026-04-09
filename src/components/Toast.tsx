import { createPortal } from "react-dom";
import { useEffect } from "react";
import { cn } from "../lib/ui";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastProps {
  action?: ToastAction;
  durationMs?: number;
  message: string;
  onClose: () => void;
  open: boolean;
  tone?: "success" | "error" | "info";
}

function toastTone(tone: NonNullable<ToastProps["tone"]>) {
  switch (tone) {
    case "success":
      return "border-emerald-900 bg-emerald-950/90 text-emerald-200";
    case "error":
      return "border-rose-900 bg-rose-950/90 text-rose-200";
    case "info":
      return "border-cyan-900 bg-slate-950/95 text-slate-100";
  }
}

export function Toast({
  action,
  durationMs = 2600,
  message,
  onClose,
  open,
  tone = "info",
}: ToastProps) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const timer = window.setTimeout(onClose, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed right-2 top-2 z-[70] flex max-w-sm">
      <div
        className={cn(
          "pointer-events-auto flex min-w-[220px] items-center gap-2 rounded-xl border px-3 py-2 shadow-[0_12px_36px_rgba(2,6,23,0.45)] backdrop-blur",
          toastTone(tone),
        )}
        role="status"
      >
        <span className="min-w-0 flex-1 text-xs">{message}</span>
        {action ? (
          <button
            className="rounded-md px-2 py-1 text-[11px] transition hover:bg-white/10"
            onClick={action.onClick}
            type="button"
          >
            {action.label}
          </button>
        ) : null}
        <button
          className="rounded-md px-2 py-1 text-[11px] transition hover:bg-white/10"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}
