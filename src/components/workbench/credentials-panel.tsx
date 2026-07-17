import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRoundIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import {
  invokeClearCredentialCache,
  invokeListCachedCredentialProfileIds,
} from '@/lib/tauri';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';

interface CredentialsPanelProps {
  onEdit: (profile: ConnectionProfile) => void;
}

function hasStoredPassword(profile: ConnectionProfile): boolean {
  if (profile.passwordStored !== undefined) {
    return profile.passwordStored;
  }
  return profile.authMethod === 'password' && !profile.password;
}

export const CredentialsPanel: React.FC<CredentialsPanelProps> = ({ onEdit }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const removeStoredPassword = useProfileStore(
    (state) => state.removeStoredPassword,
  );
  const [cachedProfileIds, setCachedProfileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<ConnectionProfile>();

  const loadCacheStatus = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const profileIds = await invokeListCachedCredentialProfileIds();
      setCachedProfileIds(new Set(profileIds));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCacheStatus();
  }, [loadCacheStatus]);

  const credentials = useMemo(
    () => profiles.filter(hasStoredPassword),
    [profiles],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCredentials = credentials.filter((profile) => {
    if (!normalizedQuery) return true;
    return [profile.name, profile.host, profile.username, String(profile.port)]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const handleClearCache = async (): Promise<void> => {
    setError(undefined);
    try {
      await invokeClearCredentialCache();
      setCachedProfileIds(new Set());
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
  };

  const handleRemove = async (): Promise<void> => {
    if (!removing) return;
    setError(undefined);
    try {
      await removeStoredPassword(removing.id);
      setCachedProfileIds((current) => {
        const next = new Set(current);
        next.delete(removing.id);
        return next;
      });
      setRemoving(undefined);
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-app-border px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-app-text">
            {t('workbench.credentials.title')}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {t('workbench.credentials.count', {
              count: filteredCredentials.length,
              total: credentials.length,
            })}
          </div>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-64">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workbench.credentials.searchPlaceholder')}
              className="h-8"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={loadCacheStatus}
            aria-label={t('common.refresh')}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {t('common.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={cachedProfileIds.size === 0}
            onClick={handleClearCache}
          >
            {t('workbench.credentials.clearCache')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {error && (
          <div className="mb-2 text-xs text-destructive">
            {t('workbench.credentials.operationFailed')}: {error}
          </div>
        )}
        {loading && credentials.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {!loading && credentials.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title={t('workbench.credentials.empty')}
              description={t('workbench.credentials.emptyDescription')}
              icon={<KeyRoundIcon className="size-5" />}
            />
          </div>
        )}
        {!loading && credentials.length > 0 && filteredCredentials.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <EmptyState title={t('workbench.credentials.filteredEmpty')} />
          </div>
        )}
        {filteredCredentials.length > 0 && (
          <ResponsiveCardGrid
            columns={1}
            breakpoints={[
              { minWidth: 800, columns: 2 },
              { minWidth: 900, columns: 3 },
            ]}
            gap="0.375rem"
          >
            {filteredCredentials.map((profile) => {
              const cached = cachedProfileIds.has(profile.id);
              return (
                <div
                  key={profile.id}
                  className="group flex flex-col gap-2 rounded-[10px] border border-app-border bg-app-surface p-2 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-app-primary/10 text-app-primary">
                        <KeyRoundIcon className="size-3.5" />
                      </div>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium text-app-text">
                          {profile.name}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {profile.username}@{profile.host}:{profile.port}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onEdit(profile)}
                        aria-label={t('common.edit')}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRemoving(profile)}
                        aria-label={t('common.delete')}
                      >
                        <Trash2Icon className="text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {t('workbench.credentials.passwordCredential')}
                    </span>
                    <Badge variant={cached ? 'secondary' : 'outline'}>
                      {cached
                        ? t('workbench.credentials.cached')
                        : t('workbench.credentials.stored')}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </ResponsiveCardGrid>
        )}
      </div>

      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('workbench.credentials.removeTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {removing
                ? t('workbench.credentials.removeConfirm', {
                    name: removing.name,
                  })
                : ''}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={handleRemove}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
