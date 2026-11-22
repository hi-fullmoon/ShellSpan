import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckIcon,
  ChevronLeftIcon,
  CopyPlusIcon,
  EyeIcon,
  FolderOpenIcon,
  PenLineIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CompactDialogHeader } from '@/components/ui/compact-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { builtinSkills } from '@/lib/ai/builtin-skills';
import {
  invokeDeleteUserSkill,
  invokeListManagedSkills,
  invokeOpenUserSkillsDir,
  invokeSaveUserSkill,
} from '@/lib/ipc/tauri';
import type { ManagedSkillCatalog, ManagedSkillItem } from '@/types/agent-skill';
import { MarkdownContent } from './assistant-message-content';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type OriginFilter = 'all' | 'user' | 'builtin';

type EditorState =
  | {
    readonly kind: 'create';
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly userInvocable: boolean;
    readonly disableModelInvocation: boolean;
    readonly overridesBuiltin: boolean;
  }
  | {
    readonly kind: 'edit';
    readonly item: ManagedSkillItem;
    readonly description: string;
    readonly instructions: string;
    readonly userInvocable: boolean;
    readonly disableModelInvocation: boolean;
  }
  | {
    readonly kind: 'viewBuiltin';
    readonly item: ManagedSkillItem;
  };

function notifySkillsUpdated(): void {
  window.dispatchEvent(new CustomEvent('shellspan:skills-updated'));
}

export function AiSkillsDialog({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { error: showError, success: showSuccess } = useToast();

  const [catalog, setCatalog] = useState<ManagedSkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<OriginFilter>('all');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorTab, setEditorTab] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedSkillItem | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const requestRef = useRef(0);

  const filterItems = useMemo(
    () => [
      { value: 'all' as const, label: t('settings.ai.skills.filter.all') },
      { value: 'user' as const, label: t('settings.ai.skills.filter.user') },
      { value: 'builtin' as const, label: t('settings.ai.skills.filter.builtin') },
    ],
    [t],
  );

  const refresh = useCallback(async () => {
    const req = ++requestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await invokeListManagedSkills();
      if (req === requestRef.current) setCatalog(next);
    } catch (error) {
      if (req === requestRef.current) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (req === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const localizedDescription = useCallback(
    (skill: ManagedSkillItem): string => {
      if (locale === 'zh-CN' && skill.origin === 'builtin') {
        return builtinSkills.find((entry) => entry.name === skill.name)?.descriptionZh ?? skill.description;
      }
      return skill.description;
    },
    [locale],
  );

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return (catalog?.skills ?? []).filter((item) => {
      if (filter !== 'all' && item.origin !== filter) return false;
      if (!needle) return true;
      return `${item.name} ${item.description} ${localizedDescription(item)}`
        .toLocaleLowerCase(locale)
        .includes(needle);
    });
  }, [catalog?.skills, filter, locale, localizedDescription, query]);

  const openCreate = () => {
    setSaveError(null);
    setEditorTab('edit');
    setEditor({
      kind: 'create',
      name: '',
      description: '',
      instructions: '# ',
      userInvocable: true,
      disableModelInvocation: false,
      overridesBuiltin: false,
    });
  };

  const openEdit = (item: ManagedSkillItem) => {
    setSaveError(null);
    setEditorTab('edit');
    setEditor({
      kind: 'edit',
      item,
      description: item.description,
      instructions: item.instructions,
      userInvocable: item.userInvocable,
      disableModelInvocation: item.disableModelInvocation,
    });
  };

  const openCustomizeBuiltin = (item: ManagedSkillItem) => {
    setSaveError(null);
    setEditorTab('edit');
    setEditor({
      kind: 'create',
      name: item.name,
      description: item.description,
      instructions: item.instructions,
      userInvocable: item.userInvocable,
      disableModelInvocation: item.disableModelInvocation,
      overridesBuiltin: true,
    });
  };

  const handleOpenFolder = async (): Promise<void> => {
    try {
      await invokeOpenUserSkillsDir();
    } catch {
      showError(t('settings.ai.skills.openDirFailed'));
    }
  };

  const editorValidationError = useMemo(() => {
    if (!editor || editor.kind === 'viewBuiltin') return null;
    const trimmedName = (editor.kind === 'create' ? editor.name : editor.item.name).trim();
    if (!trimmedName || trimmedName.length > 64 || !SKILL_NAME_PATTERN.test(trimmedName)) {
      return 'invalidName';
    }
    const trimmedDesc = editor.description.trim();
    if (!trimmedDesc || trimmedDesc.length > 500) return 'invalidDescription';
    if (!editor.instructions.trim()) return 'emptyInstructions';
    return null;
  }, [editor]);

  const handleSave = async (): Promise<void> => {
    if (!editor || editor.kind === 'viewBuiltin' || saving || editorValidationError) return;
    const targetName = (editor.kind === 'create' ? editor.name : editor.item.name).trim();
    setSaving(true);
    setSaveError(null);
    try {
      await invokeSaveUserSkill({
        name: targetName,
        description: editor.description,
        instructions: editor.instructions,
        userInvocable: editor.userInvocable,
        disableModelInvocation: editor.disableModelInvocation,
        expectedBaseHash: editor.kind === 'edit' ? editor.item.fileHash : null,
      });
      notifySkillsUpdated();
      showSuccess(t('settings.ai.skills.saved', { name: targetName }));
      setEditor(null);
      void refresh();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    const target = deleteTarget;
    if (!target || deletingName) return;
    setDeleteTarget(null);
    setDeletingName(target.name);
    try {
      await invokeDeleteUserSkill({
        name: target.name,
        expectedFileHash: target.fileHash,
      });
      notifySkillsUpdated();
      if (editor?.kind === 'edit' && editor.item.name === target.name) {
        setEditor(null);
      }
      showSuccess(
        target.overridesBuiltin
          ? t('settings.ai.skills.deletedRestoredBuiltin', { name: target.name })
          : t('settings.ai.skills.deleted', { name: target.name }),
      );
      void refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : t('settings.ai.skills.deleteFailed'));
      void refresh();
    } finally {
      setDeletingName(null);
    }
  };

  const busy = saving || deletingName !== null;

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
        <DialogContent
          data-slot="ai-skills-dialog"
          className="flex h-[min(46rem,calc(100vh-2rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-app-border bg-app-surface p-0 [&_[data-slot=dialog-close]]:size-8"
        >
          <CompactDialogHeader
            title={t('settings.ai.skills.title')}
            description={catalog?.userSkillsDir
              ? t('settings.ai.skills.dialogDescriptionWithPath', { path: catalog.userSkillsDir })
              : t('settings.ai.skills.description')}
          />

          {editor ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-w-0 shrink-0 items-center justify-between gap-2 px-4 py-2">
                <div className="flex min-w-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditor(null);
                      setSaveError(null);
                    }}
                    disabled={busy}
                  >
                    <ChevronLeftIcon className="size-4" aria-hidden="true" />
                    <span>{t('settings.ai.skills.back')}</span>
                  </Button>
                  <span className="truncate text-sm font-medium">
                    {editor.kind === 'create'
                      ? editor.overridesBuiltin
                        ? t('settings.ai.skills.customizeBuiltinTitle', { name: editor.name })
                        : t('settings.ai.skills.newSkill')
                      : `/${editor.item.name}`}
                  </span>
                </div>
                {editor.kind === 'viewBuiltin' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openCustomizeBuiltin(editor.item)}
                  >
                    <CopyPlusIcon className="size-3.5" aria-hidden="true" />
                    <span>{t('settings.ai.skills.customizeBuiltin')}</span>
                  </Button>
                ) : editor.kind === 'edit' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructiveOutline"
                    disabled={busy}
                    onClick={() => setDeleteTarget(editor.item)}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                    <span>{t('settings.ai.skills.moveToTrash')}</span>
                  </Button>
                ) : null}
              </div>

              <div className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  {editor.kind === 'viewBuiltin' ? (
                    <div className="flex flex-col gap-3 px-4 pb-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">{t('ai.workspace.skills.origin.builtin')}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {localizedDescription(editor.item)}
                        </span>
                      </div>
                      <div className="rounded-md border bg-muted/20 p-3 text-sm">
                        <MarkdownContent
                          copyLabel={t('common.copy')}
                          copiedLabel={t('common.copied')}
                          showCodeBlockActions={false}
                        >
                          {editor.item.instructions}
                        </MarkdownContent>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 px-4 pb-3">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="managed-skill-name">
                          {t('ai.workspace.skillProposal.field.name')}
                        </Label>
                        <Input
                          id="managed-skill-name"
                          className="h-8 font-mono text-sm"
                          value={editor.kind === 'create' ? editor.name : editor.item.name}
                          disabled={editor.kind === 'edit' || editor.overridesBuiltin || saving}
                          onChange={(event) => {
                            if (editor.kind !== 'create') return;
                            setEditor({ ...editor, name: event.target.value });
                            setSaveError(null);
                          }}
                          aria-invalid={editorValidationError === 'invalidName' || undefined}
                          placeholder="deploy-orders-api"
                        />
                        {editorValidationError === 'invalidName'
                          && (editor.kind === 'create' ? editor.name.length > 0 : true) && (
                            <p className="text-xs text-destructive">
                              {t('ai.workspace.skillProposal.error.invalidName')}
                            </p>
                          )}
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="managed-skill-description">
                            {t('ai.workspace.skillProposal.field.description')}
                          </Label>
                          <span className="text-xs text-muted-foreground">
                            {editor.description.trim().length}/500
                          </span>
                        </div>
                        <Textarea
                          id="managed-skill-description"
                          rows={2}
                          disabled={saving}
                          value={editor.description}
                          onChange={(event) => {
                            setEditor({ ...editor, description: event.target.value });
                            setSaveError(null);
                          }}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={editor.disableModelInvocation}
                            disabled={saving}
                            onCheckedChange={(checked) => setEditor({
                              ...editor,
                              disableModelInvocation: Boolean(checked),
                            })}
                          />
                          <span>{t('ai.workspace.skillProposal.field.manualOnly')}</span>
                        </label>
                        <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={editor.userInvocable}
                            disabled={saving}
                            onCheckedChange={(checked) => setEditor({
                              ...editor,
                              userInvocable: Boolean(checked),
                            })}
                          />
                          <span>{t('ai.workspace.skillProposal.field.userInvocable')}</span>
                        </label>
                      </div>

                      {saveError && (
                        <Alert variant="destructive" size="sm" role="alert">
                          <TriangleAlertIcon aria-hidden="true" />
                          <AlertDescription>{saveError}</AlertDescription>
                        </Alert>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="managed-skill-body">
                          {t('ai.workspace.skillProposal.field.instructions')}
                        </Label>
                        <ToggleGroup
                          value={[editorTab]}
                          onValueChange={(next) => {
                            const picked = next[0];
                            if (picked === 'edit' || picked === 'preview') setEditorTab(picked);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          <ToggleGroupItem value="edit">
                            {t('ai.workspace.skillProposal.tab.edit')}
                          </ToggleGroupItem>
                          <ToggleGroupItem value="preview">
                            {t('ai.workspace.skillProposal.tab.preview')}
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>

                      {editorTab === 'edit' ? (
                        <Textarea
                          id="managed-skill-body"
                          rows={14}
                          disabled={saving}
                          className="font-mono text-xs"
                          value={editor.instructions}
                          onChange={(event) => {
                            setEditor({ ...editor, instructions: event.target.value });
                            setSaveError(null);
                          }}
                        />
                      ) : (
                        <div className="rounded-md border bg-muted/20 p-3 text-sm">
                          <MarkdownContent
                            copyLabel={t('common.copy')}
                            copiedLabel={t('common.copied')}
                            showCodeBlockActions={false}
                          >
                            {editor.instructions}
                          </MarkdownContent>
                        </div>
                      )}
                    </div>
                  )}
                </ScrollArea>
              </div>

              {editor.kind !== 'viewBuiltin' && (
                <DialogFooter className="shrink-0 px-4 py-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setEditor(null);
                      setSaveError(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving || editorValidationError !== null}
                    onClick={() => void handleSave()}
                  >
                    <CheckIcon className="size-3.5" aria-hidden="true" />
                    <span>
                      {saving
                        ? t('ai.workspace.skillProposal.saving')
                        : t('common.save')}
                    </span>
                  </Button>
                </DialogFooter>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
                <div className="relative min-w-40 flex-1">
                  <SearchIcon
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    className="h-8 bg-transparent pl-8"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('settings.ai.skills.search')}
                    aria-label={t('settings.ai.skills.search')}
                  />
                </div>
                <Select
                  items={filterItems}
                  value={filter}
                  onValueChange={(value) => {
                    if (value === 'all' || value === 'user' || value === 'builtin') setFilter(value);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t('settings.ai.skills.filter')}
                    className="w-32"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {filterItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  onClick={openCreate}
                  disabled={busy}
                >
                  <PlusIcon className="size-3.5" aria-hidden="true" />
                  <span>{t('settings.ai.skills.newSkill')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleOpenFolder()}
                  disabled={busy}
                >
                  <FolderOpenIcon className="size-3.5" aria-hidden="true" />
                  <span>{t('settings.ai.skills.openDir')}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => void refresh()}
                  disabled={loading || busy}
                  aria-label={t('common.refresh')}
                >
                  {loading ? <Spinner aria-hidden="true" /> : <RefreshCwIcon className="size-4" aria-hidden="true" />}
                </Button>
              </div>

              {loadError && (
                <div className="shrink-0 px-4 pb-2">
                  <Alert variant="destructive" size="sm" role="alert">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>{loadError}</AlertDescription>
                  </Alert>
                </div>
              )}

              {catalog && catalog.diagnostics.length > 0 && (
                <div className="shrink-0 px-4 pb-2">
                  <Alert variant="warning" size="sm">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>
                      {t('settings.ai.skills.diagnosticsNotice', { count: catalog.diagnostics.length })}
                    </AlertDescription>
                  </Alert>
                </div>
              )}

              <div className="min-h-0 flex-1">
                {loading && !catalog ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Spinner aria-hidden="true" />
                      <span>{t('common.loading')}</span>
                    </span>
                  </div>
                ) : visibleSkills.length === 0 ? (
                  <EmptyState
                    title={t('settings.ai.skills.empty')}
                    description={t('settings.ai.skills.emptyDescription')}
                    className="px-4 py-10"
                  />
                ) : (
                  <ScrollArea className="h-full">
                    <div className="flex flex-col gap-2 px-4 pb-3">
                      {visibleSkills.map((item) => (
                        <div
                          key={`${item.origin}:${item.name}`}
                          className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-sm font-medium">/{item.name}</span>
                              <Badge
                                variant={item.origin === 'user' ? 'secondary' : 'outline'}
                                className="text-xs"
                              >
                                {item.origin === 'user'
                                  ? t('ai.workspace.skills.origin.user')
                                  : t('ai.workspace.skills.origin.builtin')}
                              </Badge>
                              {item.overridesBuiltin && (
                                <Badge variant="outline" className="text-xs">
                                  {t('settings.ai.skills.overridesBuiltin')}
                                </Badge>
                              )}
                              {item.disableModelInvocation && (
                                <Badge variant="outline" className="text-xs">
                                  {t('ai.workspace.skills.userOnly')}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {localizedDescription(item)}
                            </p>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {item.origin === 'user' ? (
                              <>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busy}
                                        onClick={() => openEdit(item)}
                                        aria-label={t('settings.ai.skills.editNamed', { name: item.name })}
                                      />
                                    }
                                  >
                                    <PenLineIcon className="size-4" aria-hidden="true" />
                                  </TooltipTrigger>
                                  <TooltipContent>{t('common.edit')}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        className="text-destructive hover:text-destructive"
                                        size="icon-sm"
                                        disabled={busy}
                                        onClick={() => setDeleteTarget(item)}
                                        aria-label={t('settings.ai.skills.deleteNamed', { name: item.name })}
                                      />
                                    }
                                  >
                                    <Trash2Icon className="size-4" aria-hidden="true" />
                                  </TooltipTrigger>
                                  <TooltipContent>{t('settings.ai.skills.moveToTrash')}</TooltipContent>
                                </Tooltip>
                              </>
                            ) : (
                              <>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busy}
                                        onClick={() => setEditor({ kind: 'viewBuiltin', item })}
                                        aria-label={t('settings.ai.skills.viewNamed', { name: item.name })}
                                      />
                                    }
                                  >
                                    <EyeIcon className="size-4" aria-hidden="true" />
                                  </TooltipTrigger>
                                  <TooltipContent>{t('settings.ai.skills.view')}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        disabled={busy}
                                        onClick={() => openCustomizeBuiltin(item)}
                                        aria-label={t('settings.ai.skills.customizeNamed', { name: item.name })}
                                      />
                                    }
                                  >
                                    <CopyPlusIcon className="size-4" aria-hidden="true" />
                                  </TooltipTrigger>
                                  <TooltipContent>{t('settings.ai.skills.customizeBuiltin')}</TooltipContent>
                                </Tooltip>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        textOnlyActions
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('settings.ai.skills.deleteTitle', { name: deleteTarget?.name ?? '' })}
        description={
          deleteTarget?.overridesBuiltin
            ? t('settings.ai.skills.deleteDescriptionRestoreBuiltin')
            : t('settings.ai.skills.deleteDescription')
        }
        confirmLabel={t('settings.ai.skills.moveToTrash')}
        confirmVariant="destructive"
        media={<Trash2Icon />}
        mediaVariant="destructive"
        onConfirm={() => void handleConfirmDelete()}
        buttonSize="sm"
      />
    </>
  );
}
