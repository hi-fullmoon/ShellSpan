import type { SessionStatus } from "../types";

export function shouldDisableTerminalInput(status: SessionStatus) {
  return status === "connecting";
}

export function shouldReconnectFromInput(status: SessionStatus, data: string) {
  return (
    (status === "disconnected" || status === "error") &&
    (data === "\r" || data === "\n")
  );
}
