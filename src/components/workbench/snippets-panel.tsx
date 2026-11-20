import { useEffect, useId, useRef, useState } from 'react';
import { CodeIcon, PencilIcon, PlusIcon, SearchXIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { PanelEmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ResponsiveCardGrid } from '@/components/ui/responsive-card-grid';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { parseSnippetTemplate, type CommandSnippet } from '@/lib/terminal/snippet-template';
import { useSnippetStore } from '@/stores/snippetStore';
import { IconActionButton } from './icon-action-button';
import { MANAGEMENT_CARD_MIN_WIDTH } from './shared';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchSearchInput } from './workbench-page';

function EditSnippet({ snippet, close }: { snippet?: CommandSnippet; close: () => void }) {
  const { t } = useI18n();
  const { error, success } = useToast();
  const id = useId();
  const formId = id + '-form';
  const [name, setName] = useState(snippet?.name ?? '');
  const [group, setGroup] = useState(snippet?.groupName ?? '');
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '');
  const [description, setDescription] = useState(snippet?.description ?? '');
  const [template, setTemplate] = useState(snippet?.commandTemplate ?? '');
  const [saving, setSaving] = useState(false);
  const validTemplate = parseSnippetTemplate(template) !== null;
  const templateInvalid = Boolean(template && !validTemplate);

  const save = async (): Promise<void> => {
    if (saving || !name.trim() || !validTemplate) return;
    setSaving(true);
    try {
      await useSnippetStore.getState().save(snippet?.id, {
        name: name.trim(), groupName: group.trim(), description: description.trim(), commandTemplate: template,
        tags: [...new Set(tags.split(/[,，]/).map((value) => value.trim()).filter(Boolean))],
      });
      success(t('terminal.snippets.saved'));
      close();
    } catch {
      error(t('terminal.snippets.saveFailed'));
      setSaving(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) close(); }}>
    <CompactDialogContent className="max-w-lg" showCloseButton={!saving}>
      <CompactDialogHeader title={t(snippet ? 'terminal.snippets.edit' : 'terminal.snippets.add')} />
      <CompactDialogBody>
        <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <FieldGroup className="gap-3">
            <Field><FieldLabel htmlFor={id + '-name'}>{t('terminal.snippets.name')}</FieldLabel>
              <Input id={id + '-name'} autoFocus maxLength={128} value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={id + '-group'}>{t('terminal.snippets.group')}</FieldLabel>
              <Input id={id + '-group'} maxLength={128} value={group} onChange={(event) => setGroup(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={id + '-tags'}>{t('terminal.snippets.tags')}</FieldLabel>
              <Input id={id + '-tags'} maxLength={512} value={tags} onChange={(event) => setTags(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor={id + '-description'}>{t('terminal.snippets.description')}</FieldLabel>
              <Input id={id + '-description'} maxLength={512} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Field data-invalid={templateInvalid || undefined}>
              <FieldLabel htmlFor={id + '-command'}>{t('terminal.snippets.template')}</FieldLabel>
              <Input id={id + '-command'} className="font-mono text-xs" maxLength={4096}
                placeholder="kubectl logs -f {{pod}} -n {{namespace:default}}"
                aria-invalid={templateInvalid || undefined}
                value={template} onChange={(event) => setTemplate(event.target.value)} />
              {templateInvalid
                ? <FieldError>{t('terminal.snippets.invalid')}</FieldError>
                : <FieldDescription>{t('terminal.snippets.templateHelp', { parameter: '{{name}}', defaulted: '{{name:default}}' })}</FieldDescription>}
            </Field>
          </FieldGroup>
        </form>
      </CompactDialogBody>
      <CompactDialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={close} disabled={saving}>{t('common.cancel')}</Button>
        <Button type="submit" form={formId} size="sm" disabled={saving || !name.trim() || !validTemplate}>{t('common.save')}</Button>
      </CompactDialogFooter>
    </CompactDialogContent>
  </Dialog>;
}

export function SnippetsPanel() {
  const { t } = useI18n();
  const { error, success } = useToast();
  const snippets = useSnippetStore((state) => state.snippets);
  const loading = useSnippetStore((state) => state.loading);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CommandSnippet | 'new'>();
  const [deleting, setDeleting] = useState<CommandSnippet>();
  const trimmedQuery = query.trim();
  const filtered = snippets.filter((snippet) => [snippet.name, snippet.groupName, snippet.description,
    snippet.commandTemplate, ...snippet.tags].join(' ').toLocaleLowerCase().includes(trimmedQuery.toLocaleLowerCase()));

  const loadErrorRef = useRef(() => error(t('terminal.snippets.loadFailed')));
  loadErrorRef.current = () => error(t('terminal.snippets.loadFailed'));

  useEffect(() => {
    let current = true;
    void useSnippetStore.getState().load().catch(() => { if (current) loadErrorRef.current(); });
    return () => { current = false; };
  }, []);

  return <TooltipProvider>
    <WorkbenchPage>
      <WorkbenchPageHeader
        icon={CodeIcon}
        title={t('terminal.snippets.title')}
        description={t(trimmedQuery ? 'terminal.snippets.filteredCount' : 'terminal.snippets.count', {
          count: filtered.length,
          total: snippets.length,
        })}
        actions={<>
          <WorkbenchSearchInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery('')}
            clearLabel={t('common.clear')}
            placeholder={t('terminal.snippets.search')}
            aria-label={t('terminal.snippets.search')}
          />
          <Button size="sm" onClick={() => setEditing('new')}><PlusIcon data-icon="inline-start" />{t('terminal.snippets.add')}</Button>
        </>}
      />
      <ScrollArea className="min-h-0 flex-1">
        <WorkbenchPageContent>
          {loading ? <PanelLoadingState /> : filtered.length === 0
            ? (trimmedQuery
              ? <PanelEmptyState icon={<SearchXIcon className="size-5" />} title={t('terminal.snippets.noMatches')} description={t('common.noSearchResults')} />
              : <PanelEmptyState
                  icon={<CodeIcon className="size-5" />}
                  title={t('terminal.snippets.empty')}
                  description={t('terminal.snippets.emptyDescription')}
                  action={<Button size="sm" onClick={() => setEditing('new')}><PlusIcon data-icon="inline-start" />{t('terminal.snippets.add')}</Button>}
                />)
            : <ResponsiveCardGrid columns={1} minColumnWidth={MANAGEMENT_CARD_MIN_WIDTH} gap="0.75rem">
              {filtered.map((snippet) => <Card key={snippet.id} size="sm" radius="compact" variant="outline" className="min-w-0">
                <CardHeader>
                  <CardTitle className="min-w-0 break-all">{snippet.name}</CardTitle>
                  <CardAction className="flex shrink-0 items-center gap-0.5">
                    <CopyButton text={snippet.commandTemplate} label={t('terminal.snippets.copyTemplate')} errorLabel={t('terminal.snippets.copyFailed')}
                      iconOnly size="icon-sm" className="text-muted-foreground" />
                    <IconActionButton aria-label={t('common.edit')} tooltip={t('common.edit')} onClick={() => setEditing(snippet)}>
                      <PencilIcon className="text-app-primary" />
                    </IconActionButton>
                    <IconActionButton aria-label={t('common.delete')} tooltip={t('common.delete')} onClick={() => setDeleting(snippet)}>
                      <Trash2Icon className="text-destructive" />
                    </IconActionButton>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-2 text-xs">
                  {(snippet.groupName || snippet.tags.length > 0) && (
                    <div className="flex flex-wrap items-center gap-1">
                      {snippet.groupName && <Badge variant="secondary" size="sm" className="max-w-full"><span className="truncate">{snippet.groupName}</span></Badge>}
                      {snippet.tags.map((tag) => <Badge key={tag} variant="outline" size="sm" className="max-w-full"><span className="truncate">{tag}</span></Badge>)}
                    </div>
                  )}
                  <pre className="overflow-x-auto rounded-md border border-app-border/60 bg-muted/60 px-2.5 py-1.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-app-text">
                    {snippet.commandTemplate}
                  </pre>
                  {snippet.description && <p className="break-words text-xs text-muted-foreground">{snippet.description}</p>}
                </CardContent>
              </Card>)}
            </ResponsiveCardGrid>}
        </WorkbenchPageContent>
      </ScrollArea>
      {editing && <EditSnippet snippet={editing === 'new' ? undefined : editing} close={() => setEditing(undefined)} />}
      <ConfirmDeleteDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title={t('terminal.snippets.delete')} description={t('terminal.snippets.deleteDescription', { name: deleting?.name ?? '' })}
        onConfirm={() => {
          if (!deleting) return;
          void useSnippetStore.getState().remove(deleting.id).then(() => success(t('terminal.snippets.deleted')))
            .catch(() => error(t('terminal.snippets.deleteFailed')));
          setDeleting(undefined);
        }} />
    </WorkbenchPage>
  </TooltipProvider>;
}
