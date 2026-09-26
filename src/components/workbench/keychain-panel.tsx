import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CopyIcon, EyeIcon, EyeOffIcon, FileKey, KeyRound, Lock, PencilIcon, PlusIcon, RefreshCwIcon, SearchXIcon, Trash2Icon, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKeychainStore, type KeychainKeySummary } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { FieldGroup } from '@/components/ui/field';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { FormRow, MANAGEMENT_CARD_MIN_WIDTH } from './shared';
import type { ConnectionProfile, KeychainKeyKind } from '@/types';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchSearchInput } from './workbench-page';

interface KeyFormState {
  kind: KeychainKeyKind;
  label: string;
  privateKey: string;
  publicKey: string;
}

const EMPTY_FORM: KeyFormState = {
  kind: 'keyFile',
  label: '',
  privateKey: '',
  publicKey: '',
};

export function credentialProfiles(key: KeychainKeySummary, profiles: ConnectionProfile[]): ConnectionProfile[] {
  return profiles.filter((profile) => key.service === 'com.shellspan.profile-password'
    ? profile.id === key.id
    : profile.keychainKeyId === key.id || profile.jumpHost?.keychainKeyId === key.id);
}

export function credentialAlgorithm(type: string): string {
  if (type === 'ed25519' || type === 'ssh-ed25519') return 'Ed25519';
  if (type === 'rsa' || type === 'ssh-rsa') return 'RSA';
  if (type === 'dsa' || type === 'ssh-dss') return 'DSA';
  if (type === 'ecdsa' || type.startsWith('ecdsa-sha2-')) return 'ECDSA';
  return '';
}

export const KeychainPanel: React.FC<{ onEditConnection?: (profile: ConnectionProfile) => void }> = ({ onEditConnection }) => {
  const { t } = useI18n();
  const { success: showSuccess, error: showError } = useToast();
  const { keys, initialized, loadError, hydrate, addKey, updateKey, removeKey } = useKeychainStore();
  const profiles = useProfileStore((state) => state.profiles);
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<KeychainKeySummary | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [visiblePrivateKey, setVisiblePrivateKey] = useState<string>();
  const [loadingPrivateKey, setLoadingPrivateKey] = useState(false);
  const secretRequest = useRef(0);
  const [form, setForm] = useState<KeyFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<KeychainKeySummary | undefined>();

  useEffect(() => {
    // Connections persist credentials independently of the cached key list.
    void hydrate();
  }, [hydrate, profiles]);

  useEffect(() => () => { secretRequest.current += 1; }, []);

  useEffect(() => {
    if (!loadError || useKeychainStore.getState().loadError !== loadError) return;
    useKeychainStore.setState({ loadError: undefined });
    showError(t('workbench.keychain.loadFailed'));
  }, [loadError, showError, t]);

  const typeLabel = (key: KeychainKeySummary): string => key.kind === 'password'
    ? t('workbench.keychain.password')
    : [t('workbench.keychain.sshKey'), credentialAlgorithm(key.keyType)].filter(Boolean).join(' · ');

  const associations = (key: KeychainKeySummary): string => {
    const names = credentialProfiles(key, profiles).map((profile) => profile.name).join(', ');
    return names ? t('workbench.keychain.usedBy', { names }) : t('workbench.keychain.unused');
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredKeys = useMemo(() => {
    return keys.filter((key) => {
      if (!normalizedQuery) return true;
      return [key.label, key.keyType, typeLabel(key), ...credentialProfiles(key, profiles).map((profile) => profile.name)].join(' ').toLowerCase().includes(normalizedQuery);
    });
  }, [keys, normalizedQuery, profiles, t]);

  const clearSecret = (): void => {
    secretRequest.current += 1;
    setVisiblePrivateKey(undefined);
    setLoadingPrivateKey(false);
  };

  const closeDrawer = (): void => {
    clearSecret();
    setDrawerOpen(false);
    setForm(EMPTY_FORM);
    setEditing(undefined);
    setReplacing(false);
  };

  const openCreate = (): void => {
    clearSecret();
    setReplacing(false);
    setEditing(undefined);
    setForm(EMPTY_FORM);
    setErrors({});
    setDrawerOpen(true);
  };

  const openEdit = (key: KeychainKeySummary): void => {
    clearSecret();
    setReplacing(false);
    setEditing(key);
    setForm({ kind: key.kind, label: key.label, publicKey: key.publicKey ?? '', privateKey: '' });
    setErrors({});
    setDrawerOpen(true);
  };

  const revealPrivateKey = async (): Promise<void> => {
    if (!editing || loadingPrivateKey) return;
    const request = ++secretRequest.current;
    setLoadingPrivateKey(true);
    const key = await useKeychainStore.getState().getKey(editing.id);
    if (request !== secretRequest.current) return;
    setLoadingPrivateKey(false);
    if (key?.privateKey) setVisiblePrivateKey(key.privateKey);
    else showError(t('workbench.keychain.loadFailed'));
  };

  const updateField = <K extends keyof KeyFormState>(key: K, value: KeyFormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const validate = (): boolean => {
    const nextErrors: Record<string, string> = {};
    if (!form.label.trim()) {
      nextErrors.label = t('keychain.form.labelRequired');
    }
    if ((!editing || replacing) && !form.privateKey.trim()) {
      nextErrors.privateKey = t('keychain.form.privateKeyRequired');
    }
    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0];
    if (firstError) {
      window.requestAnimationFrame(() => {
        document.getElementById(`keychain-${firstError}`)?.focus();
      });
    }
    return Object.keys(nextErrors).length === 0;
  };

  const handleSave = async (): Promise<void> => {
    if (isSubmitting || !validate()) return;

    setIsSubmitting(true);
    try {
      const base = {
        label: form.label.trim(),
        publicKey: form.publicKey.trim() || undefined,
      };

      if (editing) {
        await updateKey(editing.id, {
          ...base,
          kind: form.kind,
          ...(replacing ? { privateKey: form.privateKey.trim(), publicKey: form.publicKey.trim() } : {}),
        });
      } else {
        await addKey({
          ...base,
          kind: form.kind,
          privateKey: form.privateKey.trim() || undefined,
        });
      }
      closeDrawer();
      showSuccess(t('keychain.form.saveSuccess'));
    } catch {
      showError(t('keychain.form.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return;
    try {
      const affectedProfileIds = await removeKey(deleting.id);
      if (deleting.service === 'com.shellspan.profile-password') {
        useProfileStore.getState().clearProfilePassword(deleting.id);
      } else {
        useProfileStore.getState().clearKeychainKeyIds(affectedProfileIds, deleting.id, false);
      }
      setDeleting(undefined);
      showSuccess(t('keychain.form.deleteSuccess'));
    } catch {
      showError(t('keychain.form.deleteFailed'));
    }
  };

  const copyPublicKey = async (publicKey: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(publicKey);
      showSuccess(t('keychain.form.copySuccess'));
    } catch {
      showError(t('keychain.form.copyFailed'));
    }
  };

  return (
    <TooltipProvider>
      <WorkbenchPage>
        <WorkbenchPageHeader
          icon={KeyRound}
          title={t('workbench.keychain.title')}
          description={t('workbench.keychain.count', {
            count: filteredKeys.length,
            total: keys.length,
          })}
          actions={
            <>
              <WorkbenchSearchInput
                containerClassName="min-w-0 flex-1 @min-[64rem]:w-64 @min-[64rem]:flex-none"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.keychain.searchPlaceholder')}
                aria-label={t('workbench.keychain.searchPlaceholder')}
              />
              <Button variant="outline" size="sm" onClick={hydrate}>
                <RefreshCwIcon data-icon="inline-start" />
                {t('common.refresh')}
              </Button>
              <Button size="sm" onClick={openCreate}>
                <PlusIcon data-icon="inline-start" />
                {t('common.create')}
              </Button>
            </>
          }
        />

        <ScrollArea className="min-h-0 flex-1">
          <WorkbenchPageContent>
            <p className="text-xs text-muted-foreground">{t('workbench.keychain.description')}</p>
            {!initialized && keys.length === 0 && <PanelLoadingState />}
            {initialized && keys.length === 0 && (
              <PanelEmptyState
                title={t('workbench.keychain.empty')}
                description={t('workbench.keychain.emptyDescription')}
                icon={<KeyRound className="size-5" />}
              />
            )}
            {initialized && keys.length > 0 && filteredKeys.length === 0 && (
              <PanelEmptyState
                title={t('workbench.keychain.filteredEmpty')}
                description={t('common.noSearchResults')}
                icon={<SearchXIcon className="size-5" />}
              />
            )}
            {filteredKeys.length > 0 && (
              <ResponsiveCardGrid columns={1} minColumnWidth={MANAGEMENT_CARD_MIN_WIDTH} gap="0.75rem">
                {filteredKeys.map((key) => {
                  const isProfilePassword = key.service === 'com.shellspan.profile-password';
                  return (
                    <ManagementCard key={key.id}>
                      <div className="flex items-center gap-1">
                        <ManagementCardIcon>{key.kind === 'password' ? <Lock /> : <FileKey />}</ManagementCardIcon>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-[13px] font-medium leading-tight text-app-text">{key.label}</span>
                          <Badge variant="secondary" size="sm">{typeLabel(key)}</Badge>
                        </div>
                        {(!isProfilePassword || (onEditConnection && credentialProfiles(key, profiles).length > 0)) && (
                          <IconActionButton
                            onClick={() => isProfilePassword ? onEditConnection?.(credentialProfiles(key, profiles)[0]) : openEdit(key)}
                            aria-label={t(isProfilePassword ? 'workbench.keychain.editConnection' : 'common.edit')}
                            tooltip={t(isProfilePassword ? 'workbench.keychain.editConnection' : 'common.edit')}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <PencilIcon data-icon="inline-start" className="text-app-primary" />
                          </IconActionButton>
                        )}
                        <IconActionButton
                          onClick={() => setDeleting(key)}
                          aria-label={t(isProfilePassword ? 'workbench.keychain.forgetPassword' : 'common.delete')}
                          tooltip={t(isProfilePassword ? 'workbench.keychain.forgetPassword' : 'common.delete')}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Trash2Icon data-icon="inline-start" className="text-destructive" />
                        </IconActionButton>
                      </div>
                      <p className="truncate text-xs text-muted-foreground" title={associations(key)}>{associations(key)}</p>
                    </ManagementCard>
                  );
                })}
              </ResponsiveCardGrid>
            )}
          </WorkbenchPageContent>
        </ScrollArea>
      </WorkbenchPage>

      <Drawer
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open && !isSubmitting) closeDrawer();
        }}
      >
        <DrawerContent className="min-h-0 w-100 gap-0 p-0">
          <DrawerHeader className="shrink-0 px-4 py-4">
            <DrawerTitle>{editing ? t('workbench.keychain.edit') : t('workbench.keychain.new')}</DrawerTitle>
            <p className="text-xs text-muted-foreground">{editing ? t('workbench.keychain.editSubtitle') : t('workbench.keychain.newSubtitle')}</p>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
          <FieldGroup className="gap-5 px-4 py-4">
            <FormRow controlId="keychain-label" label={t('common.label')} error={errors.label}>
              <Input
                id="keychain-label"
                aria-invalid={Boolean(errors.label)}
                aria-describedby={errors.label ? 'keychain-label-error' : undefined}
                value={form.label}
                onChange={(e) => updateField('label', e.target.value)}
                placeholder={t('keychain.form.labelPlaceholder')}
              />
            </FormRow>

            {editing && <>
              <p className="break-words text-xs text-muted-foreground">{associations(editing)}</p>
              {!replacing && <FormRow label={t('workbench.keychain.fingerprint')}>
                <p className="break-all text-xs">{editing.fingerprint ?? t('workbench.keychain.publicKeyUnavailable')}</p>
              </FormRow>}
              {!replacing && <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={loadingPrivateKey} onClick={() => visiblePrivateKey ? clearSecret() : void revealPrivateKey()}>
                  {visiblePrivateKey ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
                  {t(visiblePrivateKey ? 'workbench.keychain.hidePrivateKey' : 'workbench.keychain.viewPrivateKey')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => { clearSecret(); setReplacing(true); setForm((prev) => ({ ...prev, privateKey: '', publicKey: '' })); }}>
                  {t('workbench.keychain.replacePrivateKey')}
                </Button>
              </div>}
              {visiblePrivateKey && <FormRow controlId="keychain-visible-privateKey" label={t('common.privateKey')}>
                <Textarea id="keychain-visible-privateKey" value={visiblePrivateKey} readOnly rows={6} />
              </FormRow>}
              {replacing && <p className="text-xs text-muted-foreground">{t('workbench.keychain.replaceHint')}</p>}
            </>}
            {(!editing || replacing) && <FormRow controlId="keychain-privateKey" label={t('common.privateKey')} error={errors.privateKey}>
              <Textarea
                id="keychain-privateKey"
                aria-invalid={Boolean(errors.privateKey)}
                aria-describedby={errors.privateKey ? 'keychain-privateKey-error' : undefined}
                value={form.privateKey}
                onChange={(e) => updateField('privateKey', e.target.value)}
                placeholder={t('keychain.form.privateKeyPlaceholder')}
                rows={6}
              />
            </FormRow>}
            <FormRow controlId="keychain-publicKey" label={t('common.publicKey')}>
              <Textarea
                id="keychain-publicKey"
                value={form.publicKey}
                readOnly={!!editing && !replacing}
                onChange={(e) => updateField('publicKey', e.target.value)}
                placeholder={t(editing && !replacing ? 'workbench.keychain.publicKeyUnavailable' : 'keychain.form.publicKeyOptionalPlaceholder')}
                rows={4}
              />
              {form.publicKey && <Button size="sm" variant="outline" onClick={() => void copyPublicKey(form.publicKey)}>
                <CopyIcon data-icon="inline-start" />{t('workbench.keychain.copyPublicKey')}
              </Button>}
            </FormRow>
            {(!editing || replacing) && <FileDropZone
              onFileContent={(content) => {
                const detected = detectKeyContentType(content);
                if (detected === 'publicKey') {
                  setForm((prev) => ({ ...prev, publicKey: content }));
                } else {
                  setForm((prev) => ({ ...prev, privateKey: content }));
                }
              }}
            />}
          </FieldGroup>
          </ScrollArea>
          <DrawerFooter className="shrink-0 px-4 pb-4 pt-1">
            <Button size="sm" onClick={() => void handleSave()} disabled={isSubmitting} className="w-full">
              {t('common.save')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <ConfirmDeleteDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={t(deleting?.kind === 'password' ? 'workbench.keychain.forgetTitle' : 'workbench.keychain.deleteTitle')}
        confirmLabel={t(deleting?.kind === 'password' ? 'workbench.keychain.forgetPassword' : 'common.delete')}
        description={deleting ? `${t(deleting.kind === 'password' ? 'workbench.keychain.forgetConfirm' : 'workbench.keychain.deleteConfirm', { name: deleting.label })} ${associations(deleting)}` : ''}
        onConfirm={() => void handleDelete()}
      />
    </TooltipProvider>
  );
};

type KeyContentType = 'privateKey' | 'publicKey';

function detectKeyContentType(content: string): KeyContentType {
  const trimmed = content.trim().toLowerCase();
  if (trimmed.includes('-----begin') && trimmed.includes('private key-----')) {
    return 'privateKey';
  }
  if (trimmed.startsWith('ssh-rsa') || trimmed.startsWith('ssh-ed25519') || trimmed.startsWith('ecdsa-sha2-') || trimmed.startsWith('ssh-dss')) {
    return 'publicKey';
  }
  return 'privateKey';
}

interface FileDropZoneProps {
  onFileContent: (content: string) => void;
}

const FileDropZone: React.FC<FileDropZoneProps> = ({ onFileContent }) => {
  const { t } = useI18n();
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const readFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === 'string') {
        onFileContent(content);
      }
    };
    reader.readAsText(file);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      readFile(file);
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) {
      readFile(file);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('keychain.form.dropFile')}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors',
        isDragging
          ? 'border-app-primary bg-app-primary/5 text-app-primary'
          : 'border-app-border bg-app-surface-muted text-muted-foreground hover:border-app-primary/50 hover:text-app-text',
      )}
    >
      <input ref={inputRef} type="file" accept=".pem,.key,.pub,.txt,text/*" className="hidden" onChange={handleInputChange} />
      <UploadCloud className="size-5" />
      <span className="text-xs font-medium">{t('keychain.form.dropFile')}</span>
      <span className="text-[10px] text-muted-foreground">{t('keychain.form.dropFileHint')}</span>
    </div>
  );
};
