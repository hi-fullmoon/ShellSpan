import { useEffect, useRef, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import {
  Field,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldLabel,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/hooks/useI18n';
import { AiContentTitle } from './ai-content-title';
import { AiSubmissionButtonLabel, submissionFeedbackMs } from './ai-submission-button-label';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { writeClipboardText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { questionIssue, questionIssueMessageKey, questionSubmissionIssue, type QuestionSubmissionIssue } from '@/lib/ai/question-submission';
import {
  questionKey,
  pendingUserAction,
  type AgentQuestionView,
  type AnswerQuestionInput,
  type QuestionAnswer,
  type UserActionResponse,
} from '@/types/agent-question';
import {
  AI_CONTENT_CODE_CLASS,
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_ROW_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
} from './ai-style-classes';

export interface AiQuestionPanelProps {
  readonly question: AgentQuestionView;
  readonly onAnswer?: (input: AnswerQuestionInput) => Promise<void>;
  readonly onRefresh?: (input: AnswerQuestionInput) => Promise<void>;
  readonly onOpenSettings?: () => void;
}

const recommendedSuffix = /\s+\(Recommended\)$/i;
type SubmitAction = 'answer' | 'decline' | 'retry' | UserActionResponse;

function isAnswerInvalid(answer: QuestionAnswer): boolean {
  return (!answer.selected.length && !answer.custom?.trim()) ||
    (answer.custom !== undefined && !answer.custom.trim()) ||
    new TextEncoder().encode(answer.custom ?? '').length > 8192;
}

function RecoveryButtonLabel({ label, busyLabel, busy }: {
  readonly label: string;
  readonly busyLabel: string;
  readonly busy: boolean;
}): React.ReactNode {
  return <span className="grid">
    <span className={cn('col-start-1 row-start-1', busy && 'invisible')} aria-hidden={busy || undefined}>{label}</span>
    <span className={cn('col-start-1 row-start-1', !busy && 'invisible')} aria-hidden={!busy || undefined}>{busyLabel}</span>
  </span>;
}

function SubmitButtonLabel({ label, busy }: { readonly label: string; readonly busy: boolean }): React.ReactNode {
  const { t } = useI18n();
  return <AiSubmissionButtonLabel label={label} busy={busy} busyLabel={t('ai.workspace.question.submitting')} />;
}

export function AiQuestionSeat({ question, onAnswer, ...props }: Omit<AiQuestionPanelProps, 'question'> & {
  readonly question?: AgentQuestionView | null;
}): React.ReactNode {
  const [submittingQuestion, setSubmittingQuestion] = useState<AgentQuestionView | null>(null);
  const displayed = (onAnswer ? submittingQuestion : null) ?? question;
  if (!displayed) return null;

  const panelKey = questionKey(displayed.identity) + (pendingUserAction(displayed) ? ':action' : '');
  return <AiQuestionPanel {...props} key={panelKey} question={displayed}
    onAnswer={onAnswer && (async (input) => {
      setSubmittingQuestion(displayed);
      // Committed events can replace the card before the answer promise settles.
      // Keep the clicked button visible briefly while sending the answer immediately.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        clearTimeout(timer);
        setSubmittingQuestion((current) => current === displayed ? null : current);
      };
      const feedback = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          release();
          resolve();
        }, submissionFeedbackMs);
      });
      try {
        await Promise.all([onAnswer(input), feedback]);
      } catch (error) {
        release();
        throw error;
      }
    })}
  />;
}

export function AiQuestionPanel({
  question,
  onAnswer,
  onRefresh,
  onOpenSettings,
}: AiQuestionPanelProps): React.ReactNode {
  const { t } = useI18n();
  const userAction = pendingUserAction(question);
  const copyCommandLabel = t('ai.workspace.tool.copyCommand');
  const key = questionKey(question.identity) + (userAction ? ':action' : '');
  const draft = useAgentQuestionStore((state) => state.drafts[key]);
  const [operation, setOperation] = useState<(
    { readonly kind: 'submit'; readonly action: SubmitAction; readonly answers: readonly QuestionAnswer[] }
    | { readonly kind: 'refresh' }
  ) & { readonly issue: QuestionSubmissionIssue | null } | null>(null);
  const busy = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const focusNextQuestion = useRef(false);
  const pending = operation !== null;
  const submitting = operation?.kind === 'submit' ? operation.action : null;
  const showRecovery = submitting === 'retry' || (draft?.submission && !submitting);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!focusNextQuestion.current) return;
    focusNextQuestion.current = false;
    // Base UI registers its replacement items after their first commit.
    const frame = requestAnimationFrame(() => {
      const body = content.current;
      if (!body || document.activeElement !== document.body) return;
      body.scrollTop = 0;
      body.querySelector<HTMLElement>('[data-slot="toggle-group-item"]:not(:disabled), textarea:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentIndex]);
  // A rejected acknowledgement does not prove the answer was rejected.
  // Keep the exact operation retryable until committed state removes the form.
  const editingLocked = pending || !!draft?.submission;
  // Retain the displayed issue, including a restored submission's fallback, during recovery.
  const submissionIssue = operation ? operation.issue
    : draft?.submission ? draft.issue ?? questionIssue('unconfirmed') : null;
  useEffect(() => {
    if (submissionIssue && content.current) content.current.scrollTop = content.current.scrollHeight;
  }, [submissionIssue?.reason, submissionIssue?.detail]);
  const answers: readonly QuestionAnswer[] =
    (operation?.kind === 'submit' ? operation.answers : draft?.answers) ??
    question.questions.map((q) => ({ id: q.id, selected: [] }));
  const currentQuestion = question.questions[currentIndex];
  const currentAnswer = answers.find((answer) => answer.id === currentQuestion.id) ?? { id: currentQuestion.id, selected: [] };
  const inputId = `${question.identity.questionRequestId}-${currentIndex}`;
  const tooLong =
    new TextEncoder().encode(currentAnswer.custom ?? '').length > 8192;
  const invalid = answers.some(isAnswerInvalid);
  const update = (answer: QuestionAnswer): void => {
    if (pending || useAgentQuestionStore.getState().drafts[key]?.submission) return;
    useAgentQuestionStore
      .getState()
      .setDraft(key, {
        answers: answers.map((a) => (a.id === answer.id ? answer : a)),
      });
  };
  const updateSelection = (selected: string[]): void => {
    if (pending || useAgentQuestionStore.getState().drafts[key]?.submission) return;
    update({
      id: currentQuestion.id,
      selected,
      ...(currentQuestion.multi_select && currentAnswer.custom
        ? { custom: currentAnswer.custom }
        : {}),
    });
    if (
      !currentQuestion.multi_select &&
      selected.length > 0 &&
      currentIndex < question.questions.length - 1
    ) {
      focusNextQuestion.current = true;
      setCurrentIndex((index) => index + 1);
    }
  };
  const submit = async (trigger: SubmitAction, nextAnswers = answers): Promise<void> => {
    const action = trigger === 'answer' || trigger === 'decline' || trigger === 'retry' ? undefined : trigger;
    const retained = useAgentQuestionStore.getState().drafts[key];
    if (busy.current || (!action && nextAnswers.some(isAnswerInvalid)) || !onAnswer
      || (retained?.issue && !retained.issue.retry)) return;
    const input = retained?.submission ?? {
      identity: question.identity,
      clientOperationId: crypto.randomUUID(),
      answers: nextAnswers,
      ...(action ? { action } : {}),
    };
    useAgentQuestionStore
      .getState()
      .setDraft(key, { answers: input.answers, submission: input, issue: retained?.issue });
    busy.current = true;
    setOperation({ kind: 'submit', action: trigger, answers: input.answers, issue: submissionIssue });
    try {
      await onAnswer(input);
      useAgentQuestionStore.getState().clear(key);
    } catch (error) {
      useAgentQuestionStore.getState().setDraft(key, {
        answers: input.answers, submission: input, issue: questionSubmissionIssue(error),
      });
    } finally {
      busy.current = false;
      setOperation(null);
    }
  };
  const refresh = async (): Promise<void> => {
    const input = useAgentQuestionStore.getState().drafts[key]?.submission;
    if (busy.current || !input || !onRefresh) return;
    busy.current = true;
    setOperation({ kind: 'refresh', issue: submissionIssue });
    try {
      await onRefresh(input);
      useAgentQuestionStore.getState().clear(key);
    } catch (error) {
      useAgentQuestionStore.getState().setDraft(key, {
        answers: input.answers, submission: input, issue: questionSubmissionIssue(error, 'confirm'),
      });
    } finally {
      busy.current = false;
      setOperation(null);
    }
  };
  const edit = (): void => {
    const retained = useAgentQuestionStore.getState().drafts[key];
    if (busy.current || !retained?.issue?.editable) return;
    useAgentQuestionStore.getState().setDraft(key, { answers: retained.answers });
  };
  const decline = (): void => {
    if (pending || !onAnswer || useAgentQuestionStore.getState().drafts[key]?.submission) return;
    const nextAnswers = answers.map((answer) => answer.id === currentQuestion.id
      ? { id: answer.id, selected: [], custom: t('ai.workspace.question.declinedAnswer') }
      : answer);
    const nextIndex = nextAnswers.findIndex(isAnswerInvalid);
    if (nextIndex < 0) {
      void submit('decline', nextAnswers);
    } else {
      useAgentQuestionStore.getState().setDraft(key, { answers: nextAnswers });
      setCurrentIndex(nextIndex);
    }
  };
  return (
    <Card
      className={cn('ai-question-panel min-h-0 max-h-[min(440px,40dvh)] shrink-0 gap-0 py-0',
        submissionIssue && 'max-h-[min(600px,70dvh)]')}
      data-slot="ai-question-panel"
      data-question-id={question.identity.questionRequestId}
      data-collapsed={collapsed || undefined}
    >
      <CardHeader className="ai-question-panel-header min-h-[70px] shrink-0 gap-[3px] px-[18px] pt-[11px] pb-2 @max-[421px]/ai-workspace:min-h-[66px] @max-[421px]/ai-workspace:px-3 @max-[421px]/ai-workspace:pt-2.5 @max-[421px]/ai-workspace:pb-[7px]">
        <CardDescription>
          <AiContentTitle>{userAction ? t('ai.workspace.question.actionTitle') : currentQuestion.header ?? t('ai.workspace.question.title')}</AiContentTitle>
        </CardDescription>
        <CardTitle className="ai-question-panel-title">
          <AiContentTitle key={currentQuestion.id}>{userAction ? t('ai.workspace.question.actionWaiting') : currentQuestion.question}</AiContentTitle>
        </CardTitle>
        <CardAction className="ai-question-panel-actions flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t(
              collapsed
                ? 'ai.workspace.question.expand'
                : 'ai.workspace.question.collapse',
            )}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>
      {!collapsed && (
        <>
          <CardContent ref={content} className="ai-question-panel-content max-h-65 min-h-0 overflow-x-hidden overflow-y-auto px-4 pt-px pb-1.5 @max-[421px]/ai-workspace:px-2.5 @max-[421px]/ai-workspace:pt-0">
            {userAction ? <FieldGroup className="gap-2" aria-live="polite">
              <FieldDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">{userAction.instructions}</FieldDescription>
              <Field>
                <FieldDescription>{t('ai.workspace.question.actionVerification')}</FieldDescription>
                <div className="ai-code-block flex min-w-0 items-baseline" data-ai-copy-region>
                  <pre className={cn(AI_CONTENT_CODE_CLASS, 'flex-1 pr-12 whitespace-pre-wrap [overflow-wrap:anywhere]')}>
                    <code>{userAction.verification_command}</code>
                  </pre>
                  {/* A zero-size box shares the first text baseline without taking space from the command. */}
                  <span className="relative size-0 shrink-0" data-ai-copy-anchor>
                    <Tooltip>
                      <TooltipTrigger render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="ai-tool-copy-button absolute -top-[0.5ex] right-1 -translate-y-1/2 [font:var(--ai-font-markdown-code-block)]"
                          aria-label={copyCommandLabel}
                          onClick={() => {
                            void writeClipboardText(userAction.verification_command).then(
                              () => toast.success(t('common.copied')),
                              () => toast.error(t('ai.workspace.question.actionCopyFailed')),
                            );
                          }}
                        />
                      }>
                        <CopyIcon aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>{copyCommandLabel}</TooltipContent>
                    </Tooltip>
                  </span>
                </div>
              </Field>
            </FieldGroup> : <FieldGroup className="ai-question-list gap-0">
              <FieldSet
                key={currentQuestion.id}
                className="ai-question-item gap-[5px] p-0"
                disabled={editingLocked}
              >
                <FieldLegend className="sr-only">
                  {currentQuestion.header ?? currentQuestion.question}
                </FieldLegend>
                {currentQuestion.options && (
                  <Field>
                    <ToggleGroup
                      className="ai-question-options w-full gap-0.5"
                      aria-label={currentQuestion.question}
                      multiple={currentQuestion.multi_select}
                      value={[...currentAnswer.selected]}
                      onValueChange={updateSelection}
                      orientation="vertical"
                      variant="outline"
                    >
                      {currentQuestion.options.map((option, optionIndex) => (
                        <ToggleGroupItem
                          key={option.label}
                          className="ai-question-option relative h-auto min-h-8 w-full max-w-full shrink items-start justify-start gap-[7px] px-[5px] py-[3px] text-left whitespace-normal"
                          value={option.label}
                          disabled={editingLocked}
                          aria-label={option.label}
                          aria-description={option.description}
                        >
                          <Badge
                            className="ai-question-option-index size-6 min-w-6 shrink-0 p-0"
                            variant="secondary"
                          >
                            {optionIndex + 1}
                          </Badge>
                          <span className="ai-question-option-copy flex min-w-0 flex-1 flex-col items-start gap-0.5">
                            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span className="ai-question-option-heading">
                                {option.label.replace(recommendedSuffix, '')}
                              </span>
                              {recommendedSuffix.test(option.label) && (
                                <Badge variant="secondary" size="sm">
                                  {t('ai.workspace.question.recommended')}
                                </Badge>
                              )}
                            </span>
                            {option.description && (
                              <span className="ai-question-option-description min-w-0 w-full">
                                {option.description}
                              </span>
                            )}
                          </span>
                          {currentAnswer.selected.includes(option.label) && (
                            <CheckIcon
                              className="ai-question-option-check"
                              aria-hidden="true"
                            />
                          )}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Field>
                )}
                <Field
                  className="ai-question-custom-field mt-0 gap-[3px]"
                  data-invalid={tooLong || undefined}
                  data-disabled={editingLocked || undefined}
                >
                  <FieldLabel className="sr-only" htmlFor={inputId}>
                    {t(
                      currentQuestion.options
                        ? 'ai.workspace.question.custom'
                        : 'ai.workspace.question.answer',
                    )}
                  </FieldLabel>
                  <InputGroup className="ai-question-custom-input min-h-8 min-w-[min(240px,100%)]">
                    <InputGroupTextarea
                      className="ai-question-textarea mr-0 min-h-8 min-w-0 w-full flex-1 py-1.5 pr-[7px] pl-0 [field-sizing:content]"
                      id={inputId}
                      rows={1}
                      value={currentAnswer.custom ?? ''}
                      disabled={editingLocked}
                      aria-invalid={tooLong || undefined}
                      maxLength={8192}
                      placeholder={t('ai.workspace.question.answerPlaceholder')}
                      onChange={(event) =>
                        update({
                          id: currentQuestion.id,
                          selected: currentQuestion.multi_select
                            ? currentAnswer.selected
                            : [],
                          ...(event.target.value
                            ? { custom: event.target.value }
                            : {}),
                        })
                      }
                    />
                    <InputGroupAddon className="mt-1.5 mr-[7px] mb-1.5 ml-[5px] size-6 min-w-5 shrink-0 self-start p-0" align="inline-start">
                      <PenLineIcon aria-hidden="true" />
                    </InputGroupAddon>
                  </InputGroup>
                  {tooLong && (
                    <FieldError>
                      {t('ai.workspace.question.tooLong')}
                    </FieldError>
                  )}
                </Field>
              </FieldSet>
            </FieldGroup>}
            {submissionIssue && <FieldError className="mt-2 flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]" role="alert" data-question-error={submissionIssue.reason}>
              <p className="m-0">{t(questionIssueMessageKey(submissionIssue))}</p>
              {submissionIssue.detail && <pre className={cn(AI_CONTENT_CODE_CLASS, 'ai-code-block max-h-65 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]')} tabIndex={0} aria-label={t('ai.workspace.question.failureReason')}>
                {submissionIssue.detail}
              </pre>}
            </FieldError>}
          </CardContent>
          <CardFooter className="ai-question-panel-footer min-h-12 shrink-0 justify-between gap-2.5 px-3.5 pt-1.5 pb-[7px] @max-[421px]/ai-workspace:flex-wrap @max-[421px]/ai-workspace:px-2.5">
            {!userAction && <div className="ai-question-pagination flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('ai.workspace.question.previous')}
                disabled={pending || currentIndex === 0}
                onClick={() => setCurrentIndex((index) => index - 1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </Button>
              <span className="min-w-[38px] text-center" aria-live="polite">
                {currentIndex + 1}/{question.questions.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('ai.workspace.question.next')}
                disabled={pending || currentIndex === question.questions.length - 1}
                onClick={() => setCurrentIndex((index) => index + 1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </Button>
            </div>}
            <div className="ai-question-footer-message min-w-0 flex-1" />
            <div className={cn('ai-question-footer-actions flex shrink-0 items-center gap-1.5', userAction && 'min-w-0 max-w-full flex-wrap justify-end')}>
              {showRecovery ? <>
                {onRefresh && <Button type="button" variant={submissionIssue && !submissionIssue.retry && !submissionIssue.editable ? 'default' : 'outline'} size="sm" disabled={pending} onClick={() => void refresh()}>
                  <RecoveryButtonLabel label={t('ai.workspace.question.refresh')} busyLabel={t('ai.workspace.question.refreshing')} busy={operation?.kind === 'refresh'} />
                </Button>}
                {submissionIssue?.reason === 'model' && onOpenSettings && <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onOpenSettings}>
                  {t('ai.workspace.question.openSettings')}
                </Button>}
                {submissionIssue?.editable ? <Button type="button" size="sm" disabled={pending} onClick={edit}>
                  {t('ai.workspace.question.edit')}
                </Button> : (!submissionIssue || submissionIssue.retry) && <Button type="button" size="sm" disabled={pending || !onAnswer} onClick={() => void submit('retry')}>
                  <SubmitButtonLabel label={t('ai.workspace.question.retry')} busy={submitting === 'retry'} />
                </Button>}
              </> : userAction ? <>
                <Button type="button" variant="outline" size="sm" disabled={pending || !onAnswer}
                  onClick={() => void submit('cancelled', question.answers)}>
                  <SubmitButtonLabel label={t('ai.workspace.question.actionCancel')} busy={submitting === 'cancelled'} />
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={pending || !onAnswer}
                  onClick={() => void submit('change_plan', question.answers)}>
                  <SubmitButtonLabel label={t('ai.workspace.question.actionChangePlan')} busy={submitting === 'change_plan'} />
                </Button>
                <Button type="button" size="sm" disabled={pending || !onAnswer}
                  onClick={() => void submit('completed', question.answers)}>
                  <SubmitButtonLabel label={t('ai.workspace.question.actionComplete')} busy={submitting === 'completed'} />
                </Button>
              </> : <>
              <Button
                className="min-w-[68px] @max-[421px]/ai-workspace:min-w-auto"
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || !onAnswer || !!draft?.submission}
                onClick={decline}
              >
                <SubmitButtonLabel label={t('ai.workspace.question.decline')} busy={submitting === 'decline'} />
              </Button>
              <Button
                className="min-w-[68px] @max-[421px]/ai-workspace:min-w-auto"
                type="button"
                size="sm"
                disabled={pending || invalid || !onAnswer}
                onClick={() => void submit('answer')}
              >
                <SubmitButtonLabel label={t('ai.workspace.question.submit')} busy={submitting === 'answer'} />
              </Button>
              </>}
            </div>
          </CardFooter>
        </>
      )}
    </Card>
  );
}

export function AiQuestionHistory({
  question,
}: {
  readonly question: AgentQuestionView;
}): React.ReactNode {
  const { t } = useI18n();
  const key = questionKey(question.identity);
  const [open, setOpen] = useState(false);
  const status = t(`ai.workspace.question.${question.status}`);
  const answered = question.questions.filter((item) =>
    (item.user_action && question.actionResponse !== undefined)
    || question.answers.some((answer) => answer.id === item.id),
  ).length;
  const summary = `${answered}/${question.questions.length} ${status}`;
  useEffect(() => {
    if (question.status !== 'pending') {
      useAgentQuestionStore.getState().clear(key);
      useAgentQuestionStore.getState().clear(`${key}:action`);
    }
  }, [key, question.status]);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="ai-question-history min-w-0 max-w-full"
        data-expanded={open || undefined}
        data-question-status={question.status}
      >
        <CollapsibleTrigger
          render={(
            <Button
              type="button"
              variant="plain"
              size="sm"
              className={`${AI_DISCLOSURE_ROW_CLASS} ai-question-history-trigger`}
              aria-label={`${t('ai.workspace.question.historyTitle')} ${summary}`}
              aria-expanded={open}
            />
          )}
        >
          <span className={AI_DISCLOSURE_LEADING_CLASS} aria-hidden="true">
            <MessageCircleQuestionIcon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className={AI_DISCLOSURE_TITLE_CLASS}>
            {t('ai.workspace.question.historyTitle')}
          </span>
          <span className={AI_DISCLOSURE_SEPARATOR_CLASS} aria-hidden="true" />
          <span className={AI_DISCLOSURE_SUMMARY_CLASS}>{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card
            data-slot="ai-question-history"
            className="ai-question-history-card mt-0.5 ml-[22px] h-fit shrink-0 gap-0 py-1.5"
            variant="outline"
          >
            <CardHeader className="sr-only">
              <CardTitle>{status}</CardTitle>
            </CardHeader>
            <CardContent className="max-h-65 flex-none overflow-auto px-2.5" tabIndex={0}>
              <FieldGroup className="ai-question-history-list grid auto-rows-max content-start gap-1">
                {question.questions.map((q) => {
                  const answer = question.answers.find((a) => a.id === q.id);
                  return (
                    <FieldSet className="ai-question-history-item flex-none gap-0" key={q.id}>
                      <FieldLegend className="ai-question-history-question mb-0">
                        <AiContentTitle>{q.question}</AiContentTitle>
                      </FieldLegend>
                      {answer && (
                        <FieldDescription className="ai-question-history-answer">
                          {[...answer.selected, answer.custom]
                            .filter(Boolean)
                            .join(' · ')}
                        </FieldDescription>
                      )}
                      {question.actionResponse && <FieldDescription>{t(`ai.workspace.question.actionResult.${question.actionResponse}`)}</FieldDescription>}
                    </FieldSet>
                  );
                })}
              </FieldGroup>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
