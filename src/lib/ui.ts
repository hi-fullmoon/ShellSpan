import type { RemoteFileKind, SessionStatus } from "../types";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function sessionStatusTone(status: SessionStatus) {
  switch (status) {
    case "connected":
      return "bg-emerald-500/12 text-emerald-300";
    case "connecting":
      return "bg-sky-500/12 text-sky-300";
    case "error":
      return "bg-rose-500/12 text-rose-300";
    case "disconnected":
      return "bg-slate-500/12 text-slate-300";
  }
}

export function sessionStatusDot(status: SessionStatus) {
  switch (status) {
    case "connected":
      return "bg-emerald-400";
    case "connecting":
      return "bg-sky-400";
    case "error":
      return "bg-rose-400";
    case "disconnected":
      return "bg-slate-400";
  }
}

export function fileKindTone(kind: RemoteFileKind) {
  switch (kind) {
    case "directory":
      return "bg-cyan-500/12 text-cyan-300";
    case "symlink":
      return "bg-violet-500/12 text-violet-300";
    case "file":
      return "bg-slate-500/12 text-slate-300";
    case "other":
      return "bg-amber-500/12 text-amber-300";
  }
}

