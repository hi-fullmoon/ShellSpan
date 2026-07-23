import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DatabaseIcon,
  EraserIcon,
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  ServerIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import {
  invokeClearCredentialCache,
  invokeListCachedCredentialProfileIds,
  invokeRetrievePassword,
  invokeReadTextFile,
} from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainStore } from '@/stores/keychainStore';
import type { ConnectionProfile, KeychainKey } from '@/types';
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
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DragDropEvent } from '@tauri-apps/api/window';
import type { Event as TauriEvent, UnlistenFn } from '@tauri-apps/api/event';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';

interface PasswordCredential {
  type: 'password';
  id: string;
  profile: ConnectionProfile;
}

interface KeyCredential {
  type: 'key';
  id: string;
  label: string;
  keyId: string;
  keyType: string;
}

type CredentialItem = PasswordCredential | KeyCredential;

function hasStoredPassword(profile: ConnectionProfile): boolean {
  return profile.passwordStored === true || Boolean(profile.password);
}

export const CredentialsPanel: React.FC = () => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const removeStoredPassword = useProfileStore(
    (state) => state.removeStoredPassword,
  );
  const keys = useKeychainStore((state) => state.keys);
  const hydrateKeys = useKeychainStore((state) => state.hydrate);
  const removeKey = useKeychainStore((state) => state.removeKey);
  const [cachedProfileIds, setCachedProfileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selected, setSelected] = useState<CredentialItem | undefined>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<CredentialItem>();
  const [keyDrawerOpen, setKeyDrawerOpen] = useState(false);
  const cacheRequestId = useRef(0);

  useEffect(() => {
    void hydrateKeys();
  }, [hydrateKeys]);

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

  const passwordCredentials = useMemo(
    () => profiles.filter(hasStoredPassword).map((profile) => ({
      type: 'password' as const,
      id: `password:${profile.id}`,
      profile,
    })),
    [profiles],
  );

  const keyCredentials = useMemo(
    () => keys.map((key) => ({ type: 'key' as const, id: `key:${key.id}`, label: key.label, keyId: key.id, keyType: key.keyType })),
    [keys],
  );

  const allCredentials = useMemo(
    () => [...passwordCredentials, ...keyCredentials],
    [passwordCredentials, keyCredentials],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCredentials = allCredentials.filter((item) => {
    if (!normalizedQuery) return true;
    if (item.type === 'password') {
      return [item.profile.name, item.profile.host, item.profile.username, String(item.profile.port)]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
    }
    return item.label.toLowerCase().includes(normalizedQuery);
  });

  const selectedProfile = selected?.type === 'password' ? selected.profile : undefined;

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
      if (removing.type === 'password') {
        await removeStoredPassword(removing.profile.id);
        setCachedProfileIds((current) => {
          const next = new Set(current);
          next.delete(removing.profile.id);
          return next;
        });
      } else {
        await removeKey(removing.keyId);
      }
      if (selected?.id === removing.id) setSelected(undefined);
      setRemoving(undefined);
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    }
  };

  const credentialCounts = useMemo(() => ({
    password: passwordCredentials.length,
    key: keyCredentials.length,
    total: allCredentials.length,
  }), [passwordCredentials, keyCredentials, allCredentials]);

  return (
    <TooltipProvider>
      <div className="flex h-full min-w-0">
        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-sm font-medium text-app-text">
                {t('workbench.credentials.title')}
              </h1>
              <p className="text-[11px] text-muted-foreground">
                {t('workbench.credentials.count', {
                  count: filteredCredentials.length,
                  total: credentialCounts.total,
                })}
              </p>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-64">
                <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('workbench.credentials.searchPlaceholder')}
                  className="h-8 pl-7"
                />
              </div>
              <Button
                size="sm"
                variant="default"
                onClick={() => setKeyDrawerOpen(true)}
              >
                {t('workbench.credentials.newKey')}
              </Button>
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
            {loading && credentialCounts.total === 0 && (
              <PanelLoadingState />
            )}
            {!loading && credentialCounts.total === 0 && (
              <PanelEmptyState
                title={t('workbench.credentials.empty')}
                description={t('workbench.credentials.emptyDescription')}
                icon={<KeyRoundIcon className="size-5" />}
              />
            )}
            {!loading &&
              credentialCounts.total > 0 &&
              filteredCredentials.length === 0 && (
                <PanelEmptyState
                  title={t('workbench.credentials.filteredEmpty')}
                  description={t('common.noSearchResults')}
                  icon={<SearchXIcon className="size-5" />}
                />
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
                {filteredCredentials.map((item) => {
                  const selectedItem = selected?.id === item.id;
                  return (
                    <ManagementCard
                      key={item.id}
                      selected={selectedItem}
                      className="flex-row items-center"
                    >
                      <button
                        type="button"
                        onClick={() => setSelected(item)}
                        aria-pressed={selectedItem}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ManagementCardIcon>
                          {item.type === 'password' ? <KeyRoundIcon /> : <LockKeyholeIcon />}
                        </ManagementCardIcon>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium text-app-text">
                            {item.type === 'password' ? item.profile.name : item.label}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {item.type === 'password'
                              ? `${item.profile.username}@${item.profile.host}:${item.profile.port}`
                              : t('workbench.credentials.keyType', { type: item.keyType.toUpperCase() })}
                          </span>
                        </span>
                      </button>
                      <IconActionButton
                        onClick={() => setRemoving(item)}
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
            if (!open) setSelected(undefined);
          }}
        >
          {selectedProfile && (
            <DrawerContent>
              <PasswordCredentialDetails
                profile={selectedProfile}
                onCached={() => markCredentialCached(selectedProfile.id)}
              />
            </DrawerContent>
          )}
        </Drawer>

        <KeyCredentialDrawer
          open={selected?.type === 'key' || keyDrawerOpen}
          item={selected?.type === 'key' ? selected : undefined}
          onClose={() => {
            setSelected(undefined);
            setKeyDrawerOpen(false);
          }}
        />

        <AlertDialog
          open={!!removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(undefined);
          }}
        >
          <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
            <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
              <AlertDialogTitle className="text-sm leading-5">
                {removing?.type === 'key'
                  ? t('workbench.credentials.removeKeyTitle')
                  : t('workbench.credentials.removeTitle')}
              </AlertDialogTitle>
            </AlertDialogHeader>
            <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
              <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
                {removing
                  ? t(
                      removing.type === 'key'
                        ? 'workbench.credentials.removeKeyConfirm'
                        : 'workbench.credentials.removeConfirm',
                      {
                        name:
                          removing.type === 'password'
                            ? removing.profile.name
                            : removing.label,
                      },
                    )
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

interface PasswordCredentialDetailsProps {
  profile: ConnectionProfile;
  onCached: () => void;
}

const PasswordCredentialDetails: React.FC<PasswordCredentialDetailsProps> = ({
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
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-app-primary/15 bg-app-surface text-app-primary shadow-sm">
            <LockKeyholeIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            <div className="truncate text-sm font-medium text-app-text">
              {t('workbench.credentials.passwordCredential')}
            </div>
            <Badge
              variant="outline"
              className="max-w-full border-app-primary/20 bg-app-primary/[0.06] px-1.5 text-[10px] text-app-primary"
            >
              <DatabaseIcon data-icon="inline-start" />
              <span className="truncate">
                {t('workbench.credentials.systemKeychain')}
              </span>
            </Badge>
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

interface KeyCredentialDrawerProps {
  open: boolean;
  item?: KeyCredential & { keyId: string };
  onClose: () => void;
}

const KeyCredentialDrawer: React.FC<KeyCredentialDrawerProps> = ({
  open,
  item,
  onClose,
}) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const addKey = useKeychainStore((state) => state.addKey);
  const updateKey = useKeychainStore((state) => state.updateKey);
  const getKey = useKeychainStore((state) => state.getKey);
  const [label, setLabel] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [certificate, setCertificate] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setLabel('');
      setPrivateKey('');
      setPublicKey('');
      setCertificate('');
      return;
    }

    if (item) {
      setLoading(true);
      void getKey(item.keyId).then((key) => {
        if (key) {
          setLabel(key.label);
          setPrivateKey(key.privateKey);
          setPublicKey(key.publicKey ?? '');
          setCertificate(key.certificate ?? '');
        }
        setLoading(false);
      });
    } else {
      setLabel('');
      setPrivateKey('');
      setPublicKey('');
      setCertificate('');
    }
  }, [open, item, getKey]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const attach = async () => {
      const window = getCurrentWindow();
      unlisten = await window.onDragDropEvent((event: TauriEvent<DragDropEvent>) => {
        const { payload } = event;
        switch (payload.type) {
          case 'enter':
          case 'over': {
            setDragActive(isOverDropArea(payload.position));
            break;
          }
          case 'leave': {
            setDragActive(false);
            break;
          }
          case 'drop': {
            setDragActive(false);
            if (isOverDropArea(payload.position)) {
              void handleFileDrop(payload.paths);
            }
            break;
          }
        }
      });
    };

    if (open) {
      void attach();
    }

    return () => {
      unlisten?.();
    };
  }, [open]);

  const isOverDropArea = (position: { x: number; y: number }): boolean => {
    const rect = dropRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      position.x >= rect.left &&
      position.x <= rect.right &&
      position.y >= rect.top &&
      position.y <= rect.bottom
    );
  };

  const handleFileDrop = async (paths: string[]): Promise<void> => {
    for (const path of paths) {
      try {
        const content = await invokeReadTextFile(path);
        const lowerPath = path.toLowerCase();
        const detected = detectCredentialType(lowerPath, content);
        switch (detected) {
          case 'public':
            setPublicKey(content);
            break;
          case 'certificate':
            setCertificate(content);
            break;
          default:
            setPrivateKey(content);
            break;
        }
      } catch (err) {
        showError(
          `${t('workbench.credentials.readFileFailed')}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  const validate = (): boolean => {
    if (!label.trim()) {
      showError(t('workbench.credentials.labelRequired'));
      return false;
    }
    if (!privateKey.trim()) {
      showError(t('workbench.credentials.privateKeyRequired'));
      return false;
    }
    return true;
  };

  const handleSave = async (): Promise<void> => {
    if (!validate()) return;
    setSaving(true);
    try {
      const keyData = {
        label: label.trim(),
        privateKey: privateKey.trim(),
        publicKey: publicKey.trim() || undefined,
        certificate: certificate.trim() || undefined,
      };
      if (item) {
        await updateKey(item.keyId, keyData);
      } else {
        await addKey(keyData);
      }
      onClose();
    } catch (err) {
      showError(t('workbench.credentials.saveKeyFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DrawerContent className="w-[400px] gap-0 p-0">
        <DrawerHeader className="border-b border-app-border px-5 py-4">
          <DrawerTitle>
            {item
              ? t('workbench.credentials.editKey')
              : t('workbench.credentials.newKey')}
          </DrawerTitle>
          <p className="text-xs text-muted-foreground">
            {t('workbench.credentials.keyDrawerHint')}
          </p>
        </DrawerHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {loading ? (
            <PanelLoadingState />
          ) : (
            <>
              <FormRow label={t('workbench.credentials.label')}>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('workbench.credentials.labelPlaceholder')}
                />
              </FormRow>

              <FormRow label={t('common.privateKey')}>
                <Textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder={t('workbench.credentials.privateKeyPlaceholder')}
                  className="min-h-[120px] font-mono text-xs"
                />
              </FormRow>

              <FormRow label={t('workbench.credentials.publicKey')}>
                <Textarea
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder={t('workbench.credentials.publicKeyPlaceholder')}
                  className="min-h-[80px] font-mono text-xs"
                />
              </FormRow>

              <FormRow label={t('workbench.credentials.certificate')}>
                <Textarea
                  value={certificate}
                  onChange={(e) => setCertificate(e.target.value)}
                  placeholder={t('workbench.credentials.certificatePlaceholder')}
                  className="min-h-[80px] font-mono text-xs"
                />
              </FormRow>

              <div
                ref={dropRef}
                className={cn(
                  'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 transition-colors',
                  dragActive
                    ? 'border-app-primary bg-app-primary/[0.06]'
                    : 'border-app-border bg-muted/50',
                )}
              >
                <FileUpIcon
                  className={cn(
                    'size-6',
                    dragActive ? 'text-app-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="text-center text-xs text-muted-foreground">
                  {t('workbench.credentials.dropFilesHere')}
                </span>
              </div>
            </>
          )}
        </div>

        <DrawerFooter className="border-t-0 px-5 pb-4 pt-1">
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || loading}>
              {t('common.save')}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

function detectCredentialType(lowerPath: string, content: string): 'private' | 'public' | 'certificate' {
  const lowerContent = content.toLowerCase();
  if (
    lowerPath.endsWith('.pub') ||
    lowerContent.includes('ssh-') ||
    lowerContent.includes('begin public key')
  ) {
    return 'public';
  }
  if (
    lowerContent.includes('begin certificate')
  ) {
    return 'certificate';
  }
  return 'private';
}

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

interface FormRowProps {
  label: string;
  children: React.ReactNode;
}

const FormRow: React.FC<FormRowProps> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <Label className="text-xs text-muted-foreground">{label}</Label>
    {children}
  </div>
);
