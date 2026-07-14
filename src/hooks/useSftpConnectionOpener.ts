import { useCallback } from 'react';
import { buildRemoteConnectionRequest } from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore } from '@/stores/sftpStore';
import type { ConnectionProfile } from '@/types';

export function useSftpConnectionOpener(): {
  open: (profile: ConnectionProfile) => Promise<void>;
} {
  const ensurePassword = useProfileStore((state) => state.ensurePassword);
  const addConnection = useSftpStore((state) => state.addConnection);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const touchProfile = useRecentProfilesStore((state) => state.touchProfile);

  const open = useCallback(
    async (profile: ConnectionProfile) => {
      const profileWithPassword = await ensurePassword(profile);
      const connection = buildRemoteConnectionRequest(profileWithPassword);
      const summary = {
        sessionId: generateId(),
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      addConnection(summary, connection, profile.id);
      touchProfile(profile.id);
      setActiveSection('sftp');
    },
    [ensurePassword, addConnection, setActiveSection, touchProfile],
  );

  return { open };
}
