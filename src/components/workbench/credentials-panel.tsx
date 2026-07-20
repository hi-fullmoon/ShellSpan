import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DatabaseIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import {
  invokeClearCredentialCache,
  invokeListCachedCredentialProfileIds,
  invokeRetrievePassword,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
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
import { EmptyState, Spinner } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';

function hasStoredPassword(profile: ConnectionProfile): boolean {
  return profile.passwordStored === true || Boolean(profile.password);
}

export const CredentialsPanel: React.FC = () => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const removeStoredPassword = useProfileStore(
    (state) => state.removeStoredPassword,
  );
  const [cachedProfileIds, setCachedProfileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<ConnectionProfile>();
  const cacheRequestId = useRef(0);

  const loadCacheStatus = useCallback(async (): Promise<void> => {
    const requestId = ++cacheRequestId.current;
    setLoading(true);
    setError(undefined);
    try {
      const profileIds = await invokeListCachedCredentialProfileIds();
      if (requestId !== cacheRequestId.current) return;
      setCachedProfileIds(new Set(profileIds));
    } catch (loadError) {
      if (requestId !== cacheRequestId.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === cacheRequestId.current) setLoading(false);
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
  const selectedProfile = filteredCredentials.find(
    (profile) => profile.id === selectedId,
  );

  const handleClearCache = async (): Promise<void> => {
    ++cacheRequestId.current;
    setLoading(false);
    setClearing(true);
    setError(undefined);
    try {
      await invokeClearCredentialCache();
      setCachedProfileIds(new Set());
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setClearing(false);
    }
  };

  const markCredentialCached = useCallback((profileId: string): void => {
    setCachedProfileIds((current) => {
      if (current.has(profileId)) return current;
      const next = new Set(current);
      next.add(profileId);
      return next;
    });
  }, []);

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
      if (selectedId === removing.id) setSelectedId(undefined);
      setRemoving(undefined);
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-full min-w-0">
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-col gap-2 border-b border-app-border px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-sm font-medium text-app-text">
                {t('workbench.credentials.title')}
              </h1>
              <p className="text-[11px] text-muted-foreground">
                {t('workbench.credentials.count', {
                  count: filteredCredentials.length,
                  total: credentials.length,
                })}
              </p>
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
              <IconActionButton
                className="size-7 text-app-text hover:bg-app-text/10"
                onClick={loadCacheStatus}
                disabled={clearing}
                aria-label={t('common.refresh')}
                tooltip={t('common.refresh')}
              >
                <RefreshCwIcon
                  data-icon="inline-start"
                  className={cn(loading && 'animate-spin')}
                />
              </IconActionButton>
              <IconActionButton
                className="size-7 text-app-text hover:bg-app-text/10"
                disabled={cachedProfileIds.size === 0 || clearing}
                onClick={handleClearCache}
                aria-label={t('workbench.credentials.clearCache')}
                tooltip={t('workbench.credentials.clearCache')}
              >
                <EraserIcon data-icon="inline-start" />
              </IconActionButton>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {error && (
              <div className="mb-2 rounded-lg border border-app-error/30 bg-app-error/10 px-3 py-2 text-xs text-app-error">
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
            {!loading &&
              credentials.length > 0 &&
              filteredCredentials.length === 0 && (
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
                  const selected = selectedProfile?.id === profile.id;
                  return (
                    <ManagementCard
                      key={profile.id}
                      selected={selected}
                      className="flex-row items-center"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedId(profile.id)}
                        aria-pressed={selected}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ManagementCardIcon>
                          <KeyRoundIcon />
                        </ManagementCardIcon>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium text-app-text">
                            {profile.name}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {profile.username}@{profile.host}:{profile.port}
                          </span>
                        </span>
                      </button>
                      <IconActionButton
                        onClick={() => setRemoving(profile)}
                        aria-label={t('common.delete')}
                        tooltip={t('common.delete')}
                        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2Icon
                          data-icon="inline-start"
                          className="text-destructive"
                        />
                      </IconActionButton>
                    </ManagementCard>
                  );
                })}
              </ResponsiveCardGrid>
            )}
          </div>
        </section>

        <Drawer
          open={Boolean(selectedProfile)}
          onOpenChange={(open) => {
            if (!open) setSelectedId(undefined);
          }}
        >
          {selectedProfile && (
            <DrawerContent>
              <CredentialDetails
                profile={selectedProfile}
                onCached={() => markCredentialCached(selectedProfile.id)}
              />
            </DrawerContent>
          )}
        </Drawer>

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
    </TooltipProvider>
  );
};

interface CredentialDetailsProps {
  profile: ConnectionProfile;
  onCached: () => void;
}

const CredentialDetails: React.FC<CredentialDetailsProps> = ({
  profile,
  onCached,
}) => {
  const { t } = useI18n();
  const [revealedPassword, setRevealedPassword] = useState<string>();
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string>();

  useEffect(() => {
    setRevealedPassword(undefined);
    setRevealError(undefined);
  }, [profile.id]);

  const togglePasswordVisibility = async (): Promise<void> => {
    if (revealedPassword !== undefined) {
      setRevealedPassword(undefined);
      return;
    }

    setRevealing(true);
    setRevealError(undefined);
    try {
      const password = await invokeRetrievePassword(profile.id);
      if (password === null) {
        setRevealError(t('workbench.credentials.passwordUnavailable'));
        return;
      }
      setRevealedPassword(password);
      onCached();
    } catch (error) {
      setRevealError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{profile.name}</DrawerTitle>
        <p className="truncate text-xs text-muted-foreground">
          {profile.username}@{profile.host}:{profile.port}
        </p>
      </DrawerHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        <div className="flex items-center gap-3 rounded-lg bg-app-primary/[0.04] p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-app-primary/15 text-app-primary">
            <LockKeyholeIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-app-text">
              {t('workbench.credentials.passwordCredential')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('workbench.credentials.systemKeychain')}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <DetailRow icon={<ServerIcon />} label={t('common.host')}>
            {profile.host}:{profile.port}
          </DetailRow>
          <DetailRow icon={<UserIcon />} label={t('common.username')}>
            {profile.username}
          </DetailRow>
          <DetailRow
            icon={<DatabaseIcon />}
            label={t('workbench.credentials.storage')}
          >
            {t('workbench.credentials.systemKeychain')}
          </DetailRow>
        </div>

        <Separator />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-app-text">
            {t('common.password')}
          </span>
          <div className="flex min-h-9 items-center gap-2 rounded-lg border border-app-border bg-muted pl-3 pr-1">
            <code className="min-w-0 flex-1 select-text break-all text-sm text-app-text">
              {revealedPassword ?? '••••••••••••'}
            </code>
            <IconActionButton
              disabled={revealing}
              onClick={togglePasswordVisibility}
              aria-label={
                revealedPassword !== undefined
                  ? t('workbench.credentials.hidePassword')
                  : t('workbench.credentials.showPassword')
              }
              tooltip={
                revealedPassword !== undefined
                  ? t('workbench.credentials.hidePassword')
                  : t('workbench.credentials.showPassword')
              }
            >
              {revealedPassword !== undefined ? (
                <EyeOffIcon data-icon="inline-start" />
              ) : (
                <EyeIcon data-icon="inline-start" />
              )}
            </IconActionButton>
          </div>
          {revealError && (
            <p className="text-[11px] leading-4 text-destructive">
              {revealError}
            </p>
          )}
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('workbench.credentials.secretDescription')}
          </p>
        </div>
      </div>
    </>
  );
};

interface DetailRowProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}

const DetailRow: React.FC<DetailRowProps> = ({ icon, label, children }) => (
  <div className="flex items-start gap-2.5">
    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-app-primary/[0.07] text-app-primary [&_svg]:size-3.5">
      {icon}
    </span>
    <div className="flex min-w-0 flex-col">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="break-all text-xs font-medium text-app-text">{children}</span>
    </div>
  </div>
);
