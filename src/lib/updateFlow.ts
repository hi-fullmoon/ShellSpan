import type { UpdateAction, UpdateState } from "../types";

export function updateFlowReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "checkStarted":
      return {
        phase: "checking",
        version: state.version,
      };
    case "noUpdateFound":
      return {
        phase: "no_update",
        version: state.version,
      };
    case "updateFound":
      return {
        phase: "update_available",
        version: {
          ...state.version,
          latestVersion: action.payload.latestVersion,
        },
      };
    case "downloadStarted":
      return {
        phase: "downloading",
        version: state.version,
      };
    case "downloadCompleted":
      return {
        phase: "downloaded",
        version: {
          ...state.version,
          downloadedVersion: action.payload.downloadedVersion,
        },
      };
    case "downloadFailed":
      return {
        phase: "error",
        error: action.payload.message,
        version: state.version,
      };
    case "reset":
      return {
        phase: "idle",
      };
    default:
      return state;
  }
}
