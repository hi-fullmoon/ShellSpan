import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CopyPlusIcon,
  EyeIcon,
  PenLineIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
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
import './styles/styles.css';

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
  const activeSkillName = editor
    ? (editor.kind === 'create' ? editor.name.trim() : editor.item.name)
    : '';
  const instructionLineCount = editor && editor.kind !== 'viewBuiltin'
    ? editor.instructions.split('\n').length
    : 0;

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
        <DialogContent
          data-slot="ai-skills-dialog"
          className="@container flex h-[min(46rem,calc(100vh-2rem))] w-[min(58rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-border/60 bg-card p-0 [&_[data-slot=dialog-close]]:size-8 sm:rounded-2xl"
        >
          {editor ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <DialogHeader className="flex h-12 shrink-0 flex-row items-center justify-between gap-3 border-b-[0.5px] border-border/50 px-3 py-0 pr-12 text-left">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setEditor(null);
                      setSaveError(null);
                    }}
                    disabled={busy}
                  >
                    {t('settings.ai.skills.back')}
                  </Button>
                  <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
                  <DialogTitle className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
                    {editor.kind === 'create' ? (
                      <>
                        <span className="truncate">
                          {editor.overridesBuiltin
                            ? t('settings.ai.skills.customizeBuiltinTitle', { name: editor.name })
                            : t('settings.ai.skills.newSkill')}
                        </span>
                        {!editor.overridesBuiltin && activeSkillName && (
                          <span className="hidden truncate font-mono text-xs font-normal text-muted-foreground @min-[34rem]:inline">
                            /{activeSkillName}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="truncate font-mono">/{editor.item.name}</span>
                        <Badge variant={editor.kind === 'edit' ? 'secondary' : 'outline'} className="shrink-0 text-xs font-normal">
                          {editor.kind === 'edit'
                            ? t('ai.workspace.skills.origin.user')
                            : t('ai.workspace.skills.origin.builtin')}
                        </Badge>
                        {editor.kind === 'edit' && editor.item.overridesBuiltin && (
                          <Badge variant="outline" className="hidden shrink-0 text-xs font-normal @min-[34rem]:inline-flex">
                            {t('settings.ai.skills.overridesBuiltin')}
                          </Badge>
                        )}
                      </>
                    )}
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    {catalog?.userSkillsDir
                      ? t('settings.ai.skills.dialogDescriptionWithPath', { path: catalog.userSkillsDir })
                      : t('settings.ai.skills.description')}
                  </DialogDescription>
                </div>

                {editor.kind === 'viewBuiltin' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    className="shrink-0"
                    onClick={() => openCustomizeBuiltin(editor.item)}
                  >
                    {t('settings.ai.skills.customizeBuiltin')}
                  </Button>
                )}
              </DialogHeader>

              {editor.kind === 'viewBuiltin' ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="shrink-0 border-b-[0.5px] border-border/50 bg-muted/20 px-6 py-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {localizedDescription(editor.item)}
                    </p>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="ai-workspace-root ai-assistant-markdown mx-auto w-full max-w-3xl px-6 py-5 text-sm">
                      <MarkdownContent
                        copyLabel={t('common.copy')}
                        copiedLabel={t('common.copied')}
                        showCodeBlockActions={false}
                      >
                        {editor.item.instructions}
                      </MarkdownContent>
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <>
                  <div
                    data-slot="skill-editor-layout"
                    className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto @min-[44rem]:grid-cols-[18.5rem_minmax(0,1fr)] @min-[44rem]:overflow-hidden"
                  >
                    <aside
                      data-slot="skill-editor-meta"
                      className="flex min-h-0 flex-col border-b-[0.5px] border-border/50 @min-[44rem]:border-r-[0.5px] @min-[44rem]:border-b-0"
                    >
                      <ScrollArea className="min-h-0 flex-1">
                        <div className="flex flex-col gap-5 px-5 py-5">
                          <FieldGroup className="gap-4">
                            <Field data-invalid={(editorValidationError === 'invalidName' && (editor.kind === 'create' ? editor.name.length > 0 : true)) || undefined}>
                              <FieldLabel htmlFor="managed-skill-name" className="text-xs font-medium text-foreground">
                                {t('ai.workspace.skillProposal.field.name')}
                              </FieldLabel>
                              <InputGroup className="h-8 rounded-lg bg-transparent">
                                <InputGroupAddon align="inline-start" className="pr-0 font-mono text-xs text-muted-foreground">
                                  /
                                </InputGroupAddon>
                                <InputGroupInput
                                  id="managed-skill-name"
                                  className="pl-0.5 font-mono text-sm"
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
                              </InputGroup>
                              {editorValidationError === 'invalidName'
                                && (editor.kind === 'create' ? editor.name.length > 0 : true) && (
                                  <FieldError>
                                    {t('ai.workspace.skillProposal.error.invalidName')}
                                  </FieldError>
                                )}
                            </Field>

                            <Field>
                              <div className="flex items-center justify-between gap-2">
                                <FieldLabel htmlFor="managed-skill-description" className="text-xs font-medium text-foreground">
                                  {t('ai.workspace.skillProposal.field.description')}
                                </FieldLabel>
                                <span className="text-[11px] text-muted-foreground tabular-nums">
                                  {editor.description.trim().length}/500
                                </span>
                              </div>
                              <Textarea
                                id="managed-skill-description"
                                rows={4}
                                className="resize-none rounded-lg bg-transparent text-xs leading-relaxed"
                                disabled={saving}
                                value={editor.description}
                                onChange={(event) => {
                                  setEditor({ ...editor, description: event.target.value });
                                  setSaveError(null);
                                }}
                              />
                            </Field>
                          </FieldGroup>

                          <Separator className="border-t-[0.5px] border-border/50" />

                          <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-3">
                              <Label
                                htmlFor="managed-skill-manual-only"
                                className="cursor-pointer text-xs leading-snug font-normal text-foreground"
                              >
                                {t('ai.workspace.skillProposal.field.manualOnly')}
                              </Label>
                              <Switch
                                id="managed-skill-manual-only"
                                size="sm"
                                checked={editor.disableModelInvocation}
                                disabled={saving}
                                onCheckedChange={(checked) => setEditor({
                                  ...editor,
                                  disableModelInvocation: checked,
                                })}
                              />
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <Label
                                htmlFor="managed-skill-user-invocable"
                                className="cursor-pointer text-xs leading-snug font-normal text-foreground"
                              >
                                {t('ai.workspace.skillProposal.field.userInvocable')}
                              </Label>
                              <Switch
                                id="managed-skill-user-invocable"
                                size="sm"
                                checked={editor.userInvocable}
                                disabled={saving}
                                onCheckedChange={(checked) => setEditor({
                                  ...editor,
                                  userInvocable: checked,
                                })}
                              />
                            </div>
                          </div>

                          {((editor.kind === 'create' && editor.overridesBuiltin)
                            || (editor.kind === 'edit' && editor.item.overridesBuiltin)) && (
                            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                              {t('ai.workspace.skillProposal.notice.overwritesBuiltin')}
                            </p>
                          )}

                          {catalog?.userSkillsDir && (
                            <p className="rounded-lg bg-muted/35 px-2.5 py-2 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                              {catalog.userSkillsDir}/{activeSkillName || '<name>'}/SKILL.md
                            </p>
                          )}
                        </div>
                      </ScrollArea>
                    </aside>

                    <div
                      data-slot="skill-editor-canvas"
                      className="group/canvas flex min-h-72 min-w-0 flex-1 flex-col @min-[44rem]:min-h-0"
                    >
                      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b-[0.5px] border-border/50 px-5 transition-colors group-focus-within/canvas:border-foreground/20">
                        <div className="flex min-w-0 items-center gap-2">
                          <Label htmlFor="managed-skill-body" className="truncate text-xs font-medium text-foreground">
                            {t('ai.workspace.skillProposal.field.instructions')}
                          </Label>
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {instructionLineCount}L
                          </span>
                        </div>
                        <ToggleGroup
                          value={[editorTab]}
                          onValueChange={(next) => {
                            const picked = next[0];
                            if (picked === 'edit' || picked === 'preview') setEditorTab(picked);
                          }}
                          spacing={0.5}
                          variant="surface"
                          className="h-7 shrink-0 rounded-lg border border-border/60 bg-background p-0.5"
                        >
                          <ToggleGroupItem value="edit" className="h-6 rounded-md px-2.5 text-xs">
                            {t('ai.workspace.skillProposal.tab.edit')}
                          </ToggleGroupItem>
                          <ToggleGroupItem value="preview" className="h-6 rounded-md px-2.5 text-xs">
                            {t('ai.workspace.skillProposal.tab.preview')}
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>

                      {saveError && (
                        <div className="shrink-0 px-5 pt-3">
                          <Alert variant="destructive" size="sm" role="alert">
                            <TriangleAlertIcon aria-hidden="true" />
                            <AlertDescription>{saveError}</AlertDescription>
                          </Alert>
                        </div>
                      )}

                      {editorTab === 'edit' ? (
                        <div className="flex min-h-0 flex-1 flex-col">
                          <Textarea
                            id="managed-skill-body"
                            disabled={saving}
                            className="h-full min-h-60 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-5 py-4 font-mono text-[13px] leading-6 shadow-none focus-visible:ring-0 focus-visible:outline-none!"
                            value={editor.instructions}
                            onChange={(event) => {
                              setEditor({ ...editor, instructions: event.target.value });
                              setSaveError(null);
                            }}
                          />
                        </div>
                      ) : (
                        <ScrollArea className="min-h-0 flex-1">
                          <div className="ai-workspace-root ai-assistant-markdown px-6 py-5 text-sm">
                            <MarkdownContent
                              copyLabel={t('common.copy')}
                              copiedLabel={t('common.copied')}
                              showCodeBlockActions={false}
                            >
                              {editor.instructions}
                            </MarkdownContent>
                          </div>
                        </ScrollArea>
                      )}
                    </div>
                  </div>

                  <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 px-5 pb-4 pt-3 sm:justify-between">
                    <div className="flex items-center">
                      {editor.kind === 'edit' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructiveSoft"
                          disabled={busy}
                          onClick={() => setDeleteTarget(editor.item)}
                        >
                          {t('settings.ai.skills.moveToTrash')}
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="soft"
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
                        className="rounded-lg"
                        disabled={saving || editorValidationError !== null}
                        onClick={() => void handleSave()}
                      >
                        {saving
                          ? t('ai.workspace.skillProposal.saving')
                          : t('common.save')}
                      </Button>
                    </div>
                  </DialogFooter>
                </>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <DialogHeader className="shrink-0 gap-1 border-b-[0.5px] border-border/50 px-5 py-3.5 pr-12 text-left">
                <DialogTitle className="text-sm font-semibold text-foreground">{t('settings.ai.skills.title')}</DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {catalog?.userSkillsDir
                    ? t('settings.ai.skills.dialogDescriptionWithPath', { path: catalog.userSkillsDir })
                    : t('settings.ai.skills.description')}
                </DialogDescription>
              </DialogHeader>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-border/50 px-5 py-2.5">
                <div className="relative min-w-40 flex-1">
                  <SearchIcon
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    className="h-8 rounded-lg border-transparent bg-muted/50 pl-8 focus-visible:border-border/60 focus-visible:bg-card"
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
                    variant="ghost"
                    size="sm"
                    aria-label={t('settings.ai.skills.filter')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" alignItemWithTrigger={false}>
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
                  className="rounded-lg"
                  onClick={openCreate}
                  disabled={busy}
                >
                  {t('settings.ai.skills.newSkill')}
                </Button>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  onClick={() => void handleOpenFolder()}
                  disabled={busy}
                >
                  {t('settings.ai.skills.openDir')}
                </Button>
                <Button
                  type="button"
                  variant="soft"
                  size="icon-sm"
                  className="rounded-lg"
                  onClick={() => void refresh()}
                  disabled={loading || busy}
                  aria-label={t('common.refresh')}
                >
                  {loading ? <Spinner aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}
                </Button>
              </div>

              {loadError && (
                <div className="shrink-0 px-5 pt-3">
                  <Alert variant="destructive" size="sm" role="alert">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>{loadError}</AlertDescription>
                  </Alert>
                </div>
              )}

              {catalog && catalog.diagnostics.length > 0 && (
                <div className="shrink-0 px-5 pt-3">
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
                    <div className="flex flex-col px-2 py-2">
                      {visibleSkills.map((item, index) => (
                        <React.Fragment key={`${item.origin}:${item.name}`}>
                          {index > 0 && <Separator className="mx-3 border-t-[0.5px] border-border/50 data-horizontal:w-auto" />}
                          <div
                            data-slot="managed-skill-row"
                            className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono text-sm font-medium text-foreground">/{item.name}</span>
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
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
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
                                      <PenLineIcon aria-hidden="true" />
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
                                      <Trash2Icon aria-hidden="true" />
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
                                      <EyeIcon aria-hidden="true" />
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
                                      <CopyPlusIcon aria-hidden="true" />
                                    </TooltipTrigger>
                                    <TooltipContent>{t('settings.ai.skills.customizeBuiltin')}</TooltipContent>
                                  </Tooltip>
                                </>
                              )}
                            </div>
                          </div>
                        </React.Fragment>
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
