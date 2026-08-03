import React, { useEffect, useMemo, useState } from 'react';
import { KeyRound, Lock, RefreshCwIcon, SearchIcon, SearchXIcon, Trash2Icon, PencilIcon, CopyIcon, FileKey, UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useKeychainStore, type KeychainKeySummary } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/drawer';
import { IconActionButton } from './icon-action-button';
import { ManagementCard, ManagementCardIcon } from './management-card';
import { CARD_GRID_BREAKPOINTS, FormRow, keyTypeBadgeClass } from './shared';
import type { KeychainKey, KeychainKeyKind } from '@/types';

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

function keyToForm(key: KeychainKey): KeyFormState {
  return {
    kind: key.kind,
    label: key.label,
    privateKey: key.privateKey ?? '',
    publicKey: key.publicKey ?? '',
  };
}

export const KeychainPanel: React.FC = () => {
  const { t } = useI18n();
  const { success: showSuccess, error: showError } = useToast();
  const { keys, initialized, hydrate, addKey, updateKey, removeKey } = useKeychainStore();
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<KeychainKey | undefined>();
  const [form, setForm] = useState<KeyFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<KeychainKeySummary | undefined>();

  useEffect(() => {
    if (!initialized) {
      void hydrate();
    }
  }, [initialized, hydrate]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredKeys = useMemo(() => {
    return keys.filter((key) => {
      if (!normalizedQuery) return true;
      return [key.label, key.keyType, key.kind].join(' ').toLowerCase().includes(normalizedQuery);
    });
  }, [keys, normalizedQuery]);

  const openCreate = (): void => {
    setEditing(undefined);
    setForm(EMPTY_FORM);
    setErrors({});
    setDrawerOpen(true);
  };

  const openEdit = (key: KeychainKey): void => {
    setEditing(key);
    setForm(keyToForm(key));
    setErrors({});
    setDrawerOpen(true);
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
    if (!form.privateKey.trim()) {
      nextErrors.privateKey = t('keychain.form.privateKeyRequired');
    }
    setErrors(nextErrors);
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
          privateKey: form.privateKey.trim() || undefined,
        });
      } else {
        await addKey({
          ...base,
          kind: form.kind,
          privateKey: form.privateKey.trim() || undefined,
        });
      }
      setDrawerOpen(false);
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
      useProfileStore.getState().clearKeychainKeyIds(affectedProfileIds);
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
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-col gap-2 border-b border-app-border/50 px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-app-text">{t('workbench.keychain.title')}</div>
            <div className="text-[11px] text-muted-foreground">
              {t('workbench.keychain.count', {
                count: filteredKeys.length,
                total: keys.length,
              })}
            </div>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-64">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('workbench.keychain.searchPlaceholder')}
                aria-label={t('workbench.keychain.searchPlaceholder')}
                className="h-8 pl-7"
              />
            </div>
            <IconActionButton
              className="size-7 text-app-text hover:bg-app-text/10"
              aria-label={t('common.refresh')}
              tooltip={t('common.refresh')}
              onClick={hydrate}
            >
              <RefreshCwIcon data-icon="inline-start" className={cn(!initialized && 'animate-spin')} />
            </IconActionButton>
            <Button size="sm" onClick={openCreate}>
              {t('common.create')}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
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
            <ResponsiveCardGrid
              columns={1}
              breakpoints={CARD_GRID_BREAKPOINTS}
              gap="0.375rem"
            >
              {filteredKeys.map((key) => {
                const isProfilePassword = key.kind === 'password';
                return (
                  <ManagementCard key={key.id}>
                    <div className="flex items-center gap-2.5">
                      <ManagementCardIcon>{key.kind === 'password' ? <Lock /> : <FileKey />}</ManagementCardIcon>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[13px] font-medium leading-tight text-app-text">{key.label}</span>
                        <div className="flex flex-wrap items-center gap-1">
                          <span
                            className={cn(
                              'w-fit rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none tracking-wide',
                              keyTypeBadgeClass(key.keyType),
                            )}
                          >
                            {key.keyType.toUpperCase()}
                          </span>
                        </div>
                      </div>
                      {!isProfilePassword && (
                        <IconActionButton
                          onClick={() => {
                            // Retrieve full key for editing.
                            void useKeychainStore
                              .getState()
                              .getKey(key.id)
                              .then((k) => {
                                if (k) {
                                  openEdit(k);
                                } else {
                                  showError(t('workbench.keychain.loadFailed'));
                                }
                              });
                          }}
                          aria-label={t('common.edit')}
                          tooltip={t('common.edit')}
                          className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <PencilIcon data-icon="inline-start" className="text-app-primary" />
                        </IconActionButton>
                      )}
                      <IconActionButton
                        onClick={() => setDeleting(key)}
                        aria-label={t('common.delete')}
                        tooltip={t('common.delete')}
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2Icon data-icon="inline-start" className="text-destructive" />
                      </IconActionButton>
                    </div>
                  </ManagementCard>
                );
              })}
            </ResponsiveCardGrid>
          )}
        </div>
      </div>

      <Drawer
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open) setDrawerOpen(false);
        }}
      >
        <DrawerContent className="w-100 gap-0 p-0">
          <DrawerHeader className="border-b border-app-border px-5 py-4">
            <DrawerTitle>{editing ? t('workbench.keychain.edit') : t('workbench.keychain.new')}</DrawerTitle>
            <p className="text-xs text-muted-foreground">{editing ? t('workbench.keychain.editSubtitle') : t('workbench.keychain.newSubtitle')}</p>
          </DrawerHeader>
          <div className="flex flex-col gap-5 px-5 py-4">
            <FormRow label={t('common.label')} error={errors.label}>
              <Input value={form.label} onChange={(e) => updateField('label', e.target.value)} placeholder={t('keychain.form.labelPlaceholder')} />
            </FormRow>

            <FormRow label={t('common.privateKey')} error={errors.privateKey}>
              <Textarea
                value={form.privateKey}
                onChange={(e) => updateField('privateKey', e.target.value)}
                placeholder={t('keychain.form.privateKeyPlaceholder')}
                rows={6}
              />
            </FormRow>
            <FormRow label={t('common.publicKey')}>
              <Textarea
                value={form.publicKey}
                onChange={(e) => updateField('publicKey', e.target.value)}
                placeholder={t('keychain.form.publicKeyOptionalPlaceholder')}
                rows={4}
              />
            </FormRow>
            <FileDropZone
              onFileContent={(content) => {
                const detected = detectKeyContentType(content);
                if (detected === 'publicKey') {
                  setForm((prev) => ({ ...prev, publicKey: content }));
                } else {
                  setForm((prev) => ({ ...prev, privateKey: content }));
                }
              }}
            />
          </div>
          <DrawerFooter className="border-t-0 px-5 pb-4 pt-1">
            <Button onClick={() => void handleSave()} disabled={isSubmitting} className="w-full">
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
        title={t('workbench.keychain.deleteTitle')}
        description={deleting ? t('workbench.keychain.deleteConfirm', { name: deleting.label }) : ''}
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
      onClick={() => inputRef.current?.click()}
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
      <input ref={inputRef} type="file" accept=".pem,.key,.pub,.txt,text/*" className="sr-only" onChange={handleInputChange} />
      <UploadCloud className="size-5" />
      <span className="text-xs font-medium">{t('keychain.form.dropFile')}</span>
      <span className="text-[10px] text-muted-foreground">{t('keychain.form.dropFileHint')}</span>
    </div>
  );
};
