import { buildRemoteConnectionRequest, invokeListLocalDirectory, invokeListRemoteDirectory, invokeSupersedeRemoteDirectoryRequest } from '@/lib/ipc/tauri';
import type { TerminalSession } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';

let directoryRequestId = 0;

export function directoryQuery(value: string, local: boolean) {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  const windows = local && /^[A-Za-z]:[\\/]/.test(value);
  if (!windows && !value.startsWith('/')) return null;
  const separator = windows && value.includes('\\') ? '\\' : '/';
  const split = value.lastIndexOf(separator) + 1;
  return { parent: value.slice(0, split), prefix: value.slice(split), separator };
}

/** Read-only browsing: never creates an Agent session or binds its root. */
export async function listProjectDirectories(session: TerminalSession, value: string, signal: AbortSignal): Promise<readonly string[]> {
  const local = session.host === 'local' && session.port === 0;
  const query = directoryQuery(value, local);
  if (!query || signal.aborted) return [];
  const requestKey = `project-directory-${session.sessionId}`;
  const requestId = directoryRequestId += 2;
  const cancel = () => { void invokeSupersedeRemoteDirectoryRequest(requestKey, requestId + 1).catch(() => {}); };
  try {
    let listing;
    if (local) listing = await invokeListLocalDirectory(query.parent);
    else {
      const profile = session.profileId ? useProfileStore.getState().getProfile(session.profileId) : undefined;
      if (!profile || profile.host !== session.host || profile.port !== session.port || profile.username !== session.username) throw new Error('Unavailable');
      signal.addEventListener('abort', cancel, { once: true });
      listing = await invokeListRemoteDirectory({ ...buildRemoteConnectionRequest(profile), path: query.parent, requestKey, requestId });
    }
    if (signal.aborted) return [];
    return listing.entries.filter(entry => entry.kind === 'directory' && entry.name.startsWith(query.prefix))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50)
      .map(entry => `${query.parent}${entry.name}${query.separator}`);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
