import { create } from 'zustand';

export interface HostKeyDialogState {
  open: boolean;
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  onTrust: () => void;
}

const CLOSED_DIALOG: HostKeyDialogState = {
  open: false,
  host: '',
  port: 22,
  mismatch: false,
  onTrust: () => {},
};

interface HostKeyDialogStoreState {
  dialog: HostKeyDialogState;
  /** Session that emitted the async ssh-session-error, when the prompt is event-driven. */
  errorSessionId: string | null;
  openDialog: (dialog: Omit<HostKeyDialogState, 'open'>, errorSessionId?: string | null) => void;
  closeDialog: () => void;
}

export const useHostKeyDialogStore = create<HostKeyDialogStoreState>()((set) => ({
  dialog: CLOSED_DIALOG,
  errorSessionId: null,

  openDialog: (dialog, errorSessionId = null) =>
    set({ dialog: { ...dialog, open: true }, errorSessionId }),

  closeDialog: () => set({ dialog: CLOSED_DIALOG, errorSessionId: null }),
}));
