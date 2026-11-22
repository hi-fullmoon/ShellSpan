import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookPlusIcon,
  CheckIcon,
  FileDiffIcon,
  InfoIcon,
  PenLineIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { MarkdownContent } from '../assistant-message-content';
import { AiContentTitle } from './ai-content-title';
import { AiSubmissionButtonLabel } from './ai-submission-button-label';
import {
  skillProposalKey,
  type AgentSkillProposalView,
  type InspectSkillTargetInput,
  type ResolveSkillProposalInput,
  type SkillProposalScope,
  type SkillTargetInspection,
} from '@/types/agent-skill';
import { cn } from '@/lib/utils';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AiSkillProposalPanelProps {
  readonly proposalView: AgentSkillProposalView;
  readonly onResolve?: (input: ResolveSkillProposalInput) => Promise<void>;
  readonly onInspectTarget?: (input: InspectSkillTargetInput) => Promise<SkillTargetInspection>;
}

interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove';
  readonly text: string;
}

function buildRenderedPreview(
  name: string,
  description: string,
  instructions: string,
  userInvocable: boolean,
  disableModelInvocation: boolean,
): string {
  const normalizedDescription = description.trim().replace(/\s+/g, ' ');
  const body = instructions.replace(/^[\r\n]+/, '');
  return `---\nname: ${name}\ndescription: ${JSON.stringify(normalizedDescription)}\nuser-invocable: ${userInvocable}\ndisable-model-invocation: ${disableModelInvocation}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

function computeLineDiff(beforeText: string, afterText: string): readonly DiffLine[] {
  const a = beforeText.replace(/\r\n/g, '\n').split('\n');
  const b = afterText.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }
  const m = a.length;
  const n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'remove', text: a[i] });
      i++;
    } else {
      lines.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) lines.push({ kind: 'remove', text: a[i++] });
  while (j < n) lines.push({ kind: 'add', text: b[j++] });
  return lines;
}

function validateLocalDraft(name: string, description: string, instructions: string): readonly string[] {
  const errors: string[] = [];
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 64 || !SKILL_NAME_PATTERN.test(trimmedName)) {
    errors.push('invalidName');
  }
  const trimmedDescription = description.trim();
  if (!trimmedDescription) errors.push('emptyDescription');
  else if (trimmedDescription.length > 500) errors.push('descriptionTooLong');
  if (!instructions.trim()) errors.push('emptyInstructions');
  return errors;
}

export function AiSkillProposalSeat({
  proposal,
  onResolve,
  onInspectTarget,
}: {
  readonly proposal?: AgentSkillProposalView | null;
  readonly onResolve?: (input: ResolveSkillProposalInput) => Promise<void>;
  readonly onInspectTarget?: (input: InspectSkillTargetInput) => Promise<SkillTargetInspection>;
}): React.ReactNode {
  if (!proposal) return null;
  return (
    <AiSkillProposalPanel
      key={skillProposalKey(proposal.identity)}
      proposalView={proposal}
      onResolve={onResolve}
      onInspectTarget={onInspectTarget}
    />
  );
}

export function AiSkillProposalPanel({
  proposalView,
  onResolve,
  onInspectTarget,
}: AiSkillProposalPanelProps): React.ReactNode {
  const { t } = useI18n();
  const toast = useToast();
  const { identity, proposal } = proposalView;

  const [scope, setScope] = useState<SkillProposalScope>(proposal.scope);
  const [name, setName] = useState(proposal.name);
  const [description, setDescription] = useState(proposal.description);
  const [instructions, setInstructions] = useState(proposal.instructions);
  const [userInvocable, setUserInvocable] = useState(proposal.userInvocable);
  const [disableModelInvocation, setDisableModelInvocation] = useState(proposal.disableModelInvocation);

  const [inspection, setInspection] = useState<SkillTargetInspection>({
    scope: proposal.scope,
    workspaceAllowed: proposal.workspaceAllowed,
    exists: Boolean(proposal.existingFileHash),
    existingContent: proposal.existingContent ?? null,
    existingFileHash: proposal.existingFileHash ?? null,
    overwritesBuiltin: proposal.overwritesBuiltin,
    shadowedByWorkspace: proposal.shadowedByWorkspace,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<'edit' | 'diff' | 'preview'>(
    proposal.existingContent ? 'diff' : 'edit',
  );
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionNote, setRevisionNote] = useState('');
  const [busyAction, setBusyAction] = useState<'save' | 'requestRevision' | 'cancel' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inspectSeqRef = useRef(0);

  const scopeItems = useMemo(
    () => [
      { value: 'user' as const, label: t('ai.workspace.skillProposal.scope.user') },
      { value: 'workspace' as const, label: t('ai.workspace.skillProposal.scope.workspace') },
    ],
    [t],
  );

  // Re-inspect target file whenever scope or valid name diverges from initial proposal.
  useEffect(() => {
    const trimmed = name.trim();
    if (!onInspectTarget || !SKILL_NAME_PATTERN.test(trimmed)) return;
    if (scope === proposal.scope && trimmed === proposal.name) {
      setInspection({
        scope: proposal.scope,
        workspaceAllowed: proposal.workspaceAllowed,
        exists: Boolean(proposal.existingFileHash),
        existingContent: proposal.existingContent ?? null,
        existingFileHash: proposal.existingFileHash ?? null,
        overwritesBuiltin: proposal.overwritesBuiltin,
        shadowedByWorkspace: proposal.shadowedByWorkspace,
      });
      return;
    }
    const seq = ++inspectSeqRef.current;
    const timer = window.setTimeout(() => {
      void onInspectTarget({ sessionId: identity.sessionId, scope, name: trimmed })
        .then((result) => {
          if (inspectSeqRef.current === seq) setInspection(result);
        })
        .catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    identity.sessionId,
    name,
    onInspectTarget,
    proposal.existingContent,
    proposal.existingFileHash,
    proposal.name,
    proposal.overwritesBuiltin,
    proposal.scope,
    proposal.shadowedByWorkspace,
    proposal.workspaceAllowed,
    scope,
  ]);

  const isUneditedInitial =
    scope === proposal.scope
    && name === proposal.name
    && description === proposal.description
    && instructions === proposal.instructions
    && userInvocable === proposal.userInvocable
    && disableModelInvocation === proposal.disableModelInvocation;

  const localErrors = useMemo(
    () => validateLocalDraft(name, description, instructions),
    [description, instructions, name],
  );
  const serverBlockingIssues = isUneditedInitial ? proposal.validationIssues : [];
  const hasBlockingIssues = localErrors.length > 0 || serverBlockingIssues.length > 0;
  const isUpdate = proposal.mode === 'update' || inspection.exists;

  const renderedAfter = useMemo(
    () => buildRenderedPreview(name.trim() || proposal.name, description, instructions, userInvocable, disableModelInvocation),
    [description, disableModelInvocation, instructions, name, proposal.name, userInvocable],
  );
  const diffLines = useMemo(
    () => (inspection.existingContent ? computeLineDiff(inspection.existingContent, renderedAfter) : []),
    [inspection.existingContent, renderedAfter],
  );

  const previewExcerpt = useMemo(() => {
    const lines = instructions.trim().split('\n').slice(0, 4).join('\n');
    return lines.length > 260 ? `${lines.slice(0, 260)}…` : lines;
  }, [instructions]);

  const handleSave = async (): Promise<void> => {
    if (!onResolve || busyAction || hasBlockingIssues) return;
    setBusyAction('save');
    setSubmitError(null);
    try {
      await onResolve({
        identity,
        clientOperationId: `skill-proposal-save-${crypto.randomUUID()}`,
        action: 'save',
        scope,
        name: name.trim(),
        description,
        instructions,
        userInvocable,
        disableModelInvocation,
        expectedBaseHash: inspection.existingFileHash ?? null,
      });
      setDialogOpen(false);
      toast.success(t('ai.workspace.skillProposal.savedToast', { name: name.trim() }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRequestRevision = async (): Promise<void> => {
    const trimmed = revisionNote.trim();
    if (!onResolve || busyAction || !trimmed) return;
    setBusyAction('requestRevision');
    setSubmitError(null);
    try {
      await onResolve({
        identity,
        clientOperationId: `skill-proposal-revise-${crypto.randomUUID()}`,
        action: 'requestRevision',
        note: trimmed,
      });
      setRevisionOpen(false);
      setDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async (): Promise<void> => {
    if (!onResolve || busyAction) return;
    setBusyAction('cancel');
    setSubmitError(null);
    try {
      await onResolve({
        identity,
        clientOperationId: `skill-proposal-cancel-${crypto.randomUUID()}`,
        action: 'cancel',
      });
      setDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const scopeBadgeLabel = scope === 'workspace'
    ? t('ai.workspace.skillProposal.scopeBadge.workspace')
    : t('ai.workspace.skillProposal.scopeBadge.user');

  return (
    <>
      <Card
        size="sm"
        radius="compact"
        variant="outline"
        data-slot="ai-skill-proposal-card"
        className="w-full min-w-0"
      >
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-center gap-1">
            <BookPlusIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <AiContentTitle>
              {isUpdate
                ? t('ai.workspace.skillProposal.titleUpdate')
                : t('ai.workspace.skillProposal.titleCreate')}
            </AiContentTitle>
            <Badge variant="secondary" className="font-mono text-xs">
              /{name.trim() || proposal.name}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {scopeBadgeLabel}
            </Badge>
          </CardTitle>
          {proposal.summary && (
            <CardDescription>{proposal.summary}</CardDescription>
          )}
          <CardAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditorTab(inspection.existingContent ? 'diff' : 'edit');
                setDialogOpen(true);
              }}
              disabled={busyAction !== null}
            >
              {inspection.existingContent ? (
                <FileDiffIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <PenLineIcon className="size-3.5" aria-hidden="true" />
              )}
              <span>
                {inspection.existingContent
                  ? t('ai.workspace.skillProposal.reviewDiff')
                  : t('ai.workspace.skillProposal.reviewEdit')}
              </span>
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">{description}</div>

          {previewExcerpt && (
            <pre className="max-h-28 overflow-hidden rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-foreground/90">
              {previewExcerpt}
            </pre>
          )}

          {proposal.scopeDowngradeReason && (
            <Alert variant="info" size="sm">
              <InfoIcon aria-hidden="true" />
              <AlertDescription>{t('ai.workspace.skillProposal.notice.scopeDowngraded')}</AlertDescription>
            </Alert>
          )}

          {inspection.overwritesBuiltin && (
            <Alert variant="warning" size="sm">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{t('ai.workspace.skillProposal.notice.overwritesBuiltin')}</AlertDescription>
            </Alert>
          )}

          {inspection.shadowedByWorkspace && (
            <Alert variant="warning" size="sm">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{t('ai.workspace.skillProposal.notice.shadowedByWorkspace')}</AlertDescription>
            </Alert>
          )}

          {serverBlockingIssues.map((issue, idx) => (
            <Alert key={`${issue.code}-${idx}`} variant="destructive" size="sm">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{issue.message}</AlertDescription>
            </Alert>
          ))}

          {submitError && (
            <Alert variant="destructive" size="sm" role="alert">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          {revisionOpen && (
            <div className="flex flex-col gap-2 pt-1">
              <Textarea
                value={revisionNote}
                onChange={(event) => setRevisionNote(event.target.value)}
                placeholder={t('ai.workspace.skillProposal.revisionPlaceholder')}
                rows={2}
                disabled={busyAction !== null}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRevisionOpen(false)}
                  disabled={busyAction !== null}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleRequestRevision()}
                  disabled={busyAction !== null || !revisionNote.trim()}
                >
                  <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                  <AiSubmissionButtonLabel
                    label={t('ai.workspace.skillProposal.sendRevision')}
                    busy={busyAction === 'requestRevision'}
                    busyLabel={t('ai.workspace.question.submitting')}
                  />
                </Button>
              </div>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleCancel()}
            disabled={!onResolve || busyAction !== null}
          >
            {t('common.cancel')}
          </Button>
          {!revisionOpen && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRevisionOpen(true)}
              disabled={!onResolve || busyAction !== null}
            >
              <RotateCcwIcon className="size-3.5" aria-hidden="true" />
              <span>{t('ai.workspace.skillProposal.requestRevision')}</span>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!onResolve || busyAction !== null || hasBlockingIssues}
          >
            <CheckIcon className="size-3.5" aria-hidden="true" />
            <AiSubmissionButtonLabel
              label={
                isUpdate
                  ? t('ai.workspace.skillProposal.saveUpdate')
                  : t('ai.workspace.skillProposal.saveCreate')
              }
              busy={busyAction === 'save'}
              busyLabel={t('ai.workspace.skillProposal.saving')}
            />
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="flex h-[min(86vh,760px)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
          data-slot="ai-skill-proposal-dialog"
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3">
            <DialogTitle>
              {isUpdate
                ? t('ai.workspace.skillProposal.dialogTitleUpdate')
                : t('ai.workspace.skillProposal.dialogTitleCreate')}
            </DialogTitle>
            <DialogDescription>
              {scope === 'workspace'
                ? t('ai.workspace.skillProposal.dialogDescWorkspace')
                : t('ai.workspace.skillProposal.dialogDescUser')}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3 px-4 py-1">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`skill-proposal-scope-${identity.proposalId}`}>
                      {t('ai.workspace.skillProposal.field.scope')}
                    </Label>
                    <Select
                      items={scopeItems}
                      value={scope}
                      onValueChange={(value) => {
                        if (value === 'user' || value === 'workspace') {
                          setScope(value);
                          setSubmitError(null);
                        }
                      }}
                    >
                      <SelectTrigger
                        id={`skill-proposal-scope-${identity.proposalId}`}
                        size="sm"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">
                          {t('ai.workspace.skillProposal.scope.user')}
                        </SelectItem>
                        <SelectItem value="workspace" disabled={!proposal.workspaceAllowed}>
                          {t('ai.workspace.skillProposal.scope.workspace')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`skill-proposal-name-${identity.proposalId}`}>
                      {t('ai.workspace.skillProposal.field.name')}
                    </Label>
                    <Input
                      id={`skill-proposal-name-${identity.proposalId}`}
                      className="h-8 font-mono text-sm"
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setSubmitError(null);
                      }}
                      aria-invalid={localErrors.includes('invalidName') || undefined}
                      placeholder="deploy-orders-api"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={`skill-proposal-desc-${identity.proposalId}`}>
                      {t('ai.workspace.skillProposal.field.description')}
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {description.trim().length}/500
                    </span>
                  </div>
                  <Textarea
                    id={`skill-proposal-desc-${identity.proposalId}`}
                    rows={2}
                    value={description}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setSubmitError(null);
                    }}
                    aria-invalid={
                      localErrors.includes('emptyDescription')
                      || localErrors.includes('descriptionTooLong')
                        ? true
                        : undefined
                    }
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={disableModelInvocation}
                      onCheckedChange={(checked) => setDisableModelInvocation(Boolean(checked))}
                    />
                    <span>{t('ai.workspace.skillProposal.field.manualOnly')}</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={userInvocable}
                      onCheckedChange={(checked) => setUserInvocable(Boolean(checked))}
                    />
                    <span>{t('ai.workspace.skillProposal.field.userInvocable')}</span>
                  </label>
                </div>

                {localErrors.includes('invalidName') && (
                  <Alert variant="destructive" size="sm">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>{t('ai.workspace.skillProposal.error.invalidName')}</AlertDescription>
                  </Alert>
                )}

                {serverBlockingIssues.map((issue, idx) => (
                  <Alert key={`dialog-${issue.code}-${idx}`} variant="destructive" size="sm">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>{issue.message}</AlertDescription>
                  </Alert>
                ))}

                {submitError && (
                  <Alert variant="destructive" size="sm" role="alert">
                    <TriangleAlertIcon aria-hidden="true" />
                    <AlertDescription>{submitError}</AlertDescription>
                  </Alert>
                )}

                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`skill-proposal-body-${identity.proposalId}`}>
                    {t('ai.workspace.skillProposal.field.instructions')}
                  </Label>
                  <ToggleGroup
                    value={[editorTab]}
                    onValueChange={(next) => {
                      const picked = next[0];
                      if (picked === 'edit' || picked === 'diff' || picked === 'preview') {
                        setEditorTab(picked);
                      }
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <ToggleGroupItem value="edit">
                      {t('ai.workspace.skillProposal.tab.edit')}
                    </ToggleGroupItem>
                    {inspection.existingContent && (
                      <ToggleGroupItem value="diff">
                        {t('ai.workspace.skillProposal.tab.diff')}
                      </ToggleGroupItem>
                    )}
                    <ToggleGroupItem value="preview">
                      {t('ai.workspace.skillProposal.tab.preview')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>

                {editorTab === 'edit' && (
                  <Textarea
                    id={`skill-proposal-body-${identity.proposalId}`}
                    rows={14}
                    className="font-mono text-xs"
                    value={instructions}
                    onChange={(event) => {
                      setInstructions(event.target.value);
                      setSubmitError(null);
                    }}
                    aria-invalid={localErrors.includes('emptyInstructions') || undefined}
                  />
                )}

                {editorTab === 'diff' && inspection.existingContent && (
                  <div
                    data-slot="ai-skill-proposal-diff"
                    className="rounded-md border bg-muted/30 p-2 font-mono text-xs"
                  >
                    {diffLines.map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          'px-1.5 whitespace-pre-wrap',
                          line.kind === 'add' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                          line.kind === 'remove' && 'bg-destructive/15 text-destructive',
                        )}
                      >
                        <span className="inline-block w-4 select-none opacity-60">
                          {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                        </span>
                        {line.text || ' '}
                      </div>
                    ))}
                  </div>
                )}

                {editorTab === 'preview' && (
                  <div className="rounded-md border bg-muted/20 p-3 text-sm">
                    <MarkdownContent
                      copyLabel={t('common.copy')}
                      copiedLabel={t('common.copied')}
                      showCodeBlockActions={false}
                    >
                      {instructions}
                    </MarkdownContent>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          <DialogFooter className="shrink-0 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDialogOpen(false)}
              disabled={busyAction !== null}
            >
              {t('common.close')}
            </Button>
            <Button
              type="button"
              onClick={() => void handleSave()}
              disabled={!onResolve || busyAction !== null || hasBlockingIssues}
            >
              <CheckIcon className="size-4" aria-hidden="true" />
              <AiSubmissionButtonLabel
                label={
                  isUpdate
                    ? t('ai.workspace.skillProposal.saveUpdate')
                    : t('ai.workspace.skillProposal.saveCreate')
                }
                busy={busyAction === 'save'}
                busyLabel={t('ai.workspace.skillProposal.saving')}
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
