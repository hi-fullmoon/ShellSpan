import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocalStorage } from './useLocalStorage';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import type { ConnectionProfile } from '../types';

const profilesLogger = createLogger('app');

export interface UseSavedProfilesResult {
  savedProfiles: ConnectionProfile[];
  setSavedProfiles: Dispatch<SetStateAction<ConnectionProfile[]>>;
  pendingDeleteProfileId: string | undefined;
  setPendingDeleteProfileId: (id: string | undefined) => void;
  handleDeleteSavedProfile: (profileId: string) => void;
  handleToggleSavedProfilePinned: (profileId: string) => void;
  handleToggleSavedProfileFavorite: (profileId: string) => void;
  handleRenameSavedProfile: (profileId: string, name: string) => void;
  confirmDeleteSavedProfile: () => void;
}

export function useSavedProfiles(): UseSavedProfilesResult {
  const [savedProfiles, setSavedProfiles] = useLocalStorage<ConnectionProfile[]>('termbridge.savedProfiles', [], ['windbridge.savedProfiles']);
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string>();

  const handleDeleteSavedProfile = (profileId: string) => {
    const target = savedProfiles.find((item) => item.id === profileId);
    if (!target) {
      return;
    }

    setPendingDeleteProfileId(profileId);
  };

  const handleToggleSavedProfilePinned = (profileId: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              pinned: !profile.pinned,
            }
          : profile,
      ),
    );
  };

  const handleToggleSavedProfileFavorite = (profileId: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              favorite: !profile.favorite,
            }
          : profile,
      ),
    );
  };

  const handleRenameSavedProfile = (profileId: string, name: string) => {
    setSavedProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              name,
            }
          : profile,
      ),
    );
  };

  const confirmDeleteSavedProfile = () => {
    if (!pendingDeleteProfileId) {
      return;
    }

    profilesLogger.info('删除历史连接', { profileId: pendingDeleteProfileId });
    if (isTauriRuntime()) {
      void invoke('remove_password', { profileId: pendingDeleteProfileId }).catch((error) => {
        profilesLogger.warn('Failed to remove password from keychain', { error: String(error) });
      });
    }
    setSavedProfiles((current) => current.filter((item) => item.id !== pendingDeleteProfileId));
    setPendingDeleteProfileId(undefined);
  };

  // Migrate passwords from localStorage to OS keychain (one-time)
  useEffect(() => {
    if (!isTauriRuntime() || !savedProfiles.length) {
      return;
    }

    const migrated = localStorage.getItem('termbridge.passwordsMigrated');
    if (migrated === '1') {
      return;
    }

    const passwordsToMigrate: Array<[string, string]> = [];
    for (const profile of savedProfiles) {
      if (profile.rememberPassword && profile.password) {
        passwordsToMigrate.push([profile.id, profile.password]);
      }
    }

    if (passwordsToMigrate.length === 0) {
      localStorage.setItem('termbridge.passwordsMigrated', '1');
      return;
    }

    profilesLogger.info('Migrating passwords to keychain', { count: passwordsToMigrate.length });

    invoke<Array<[string, boolean]>>('migrate_passwords', {
      profiles: passwordsToMigrate,
    })
      .then((results) => {
        const allSucceeded = results.every(([, ok]) => ok);
        if (allSucceeded) {
          localStorage.setItem('termbridge.passwordsMigrated', '1');
          setSavedProfiles((current) =>
            current.map((p) => ({
              ...p,
              password: '',
            })),
          );
          profilesLogger.info('Passwords migrated to keychain successfully');
        } else {
          profilesLogger.warn('Some passwords failed to migrate', { results });
        }
      })
      .catch((error) => {
        profilesLogger.error('Password migration failed', { error: String(error) });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    savedProfiles,
    setSavedProfiles,
    pendingDeleteProfileId,
    setPendingDeleteProfileId,
    handleDeleteSavedProfile,
    handleToggleSavedProfilePinned,
    handleToggleSavedProfileFavorite,
    handleRenameSavedProfile,
    confirmDeleteSavedProfile,
  };
}
