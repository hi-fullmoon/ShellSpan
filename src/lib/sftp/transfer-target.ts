import { getSftpPaneConnectionKey, getSftpPaneSource, type SftpConnection, type SftpSide } from '@/stores/sftpStore';

// A completed transfer may refresh only its original visible destination.
export function isTransferTargetCurrent(
  original: SftpConnection,
  current: SftpConnection | undefined,
  side: SftpSide,
  destination: string,
): current is SftpConnection {
  const source = getSftpPaneSource(original, side);
  return Boolean(current && current.id === original.id &&
    getSftpPaneSource(current, side) === source &&
    (source !== 'remote' || getSftpPaneConnectionKey(current, side) === getSftpPaneConnectionKey(original, side)) &&
    (side === 'local' ? current.localPath : current.remotePath) === destination);
}
