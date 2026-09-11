import { useEffect, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
  XIcon,
} from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import {
  questionKey,
  type AgentQuestionView,
  type AnswerQuestionInput,
  type QuestionAnswer,
} from '@/types/agent-question';
import {
  AI_DISCLOSURE_LEADING_CLASS,
  AI_DISCLOSURE_ROW_CLASS,
  AI_DISCLOSURE_SEPARATOR_CLASS,
  AI_DISCLOSURE_SUMMARY_CLASS,
  AI_DISCLOSURE_TITLE_CLASS,
} from './ai-style-classes';

export interface AiQuestionPanelProps {
  readonly question: AgentQuestionView;
  readonly onAnswer?: (input: AnswerQuestionInput) => Promise<void>;
}

const recommendedSuffix = /\s+\(Recommended\)$/i;

export function AiQuestionPanel({
  question,
  onAnswer,
}: AiQuestionPanelProps): React.ReactNode {
  const { t } = useI18n();
  const key = questionKey(question.identity);
  const draft = useAgentQuestionStore((state) => state.drafts[key]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const answers: readonly QuestionAnswer[] =
    draft?.answers ??
    question.questions.map((q) => ({ id: q.id, selected: [] }));
  const currentQuestion = question.questions[currentIndex];
  const currentAnswer = answers.find((answer) => answer.id === currentQuestion.id)!;
  const inputId = `${question.identity.questionRequestId}-${currentIndex}`;
  const tooLong =
    new TextEncoder().encode(currentAnswer.custom ?? '').length > 8192;
  const invalid = answers.some(
    (a) =>
      (!a.selected.length && !a.custom?.trim()) ||
      (a.custom !== undefined && !a.custom.trim()) ||
      new TextEncoder().encode(a.custom ?? '').length > 8192,
  );
  const update = (answer: QuestionAnswer): void => {
    useAgentQuestionStore
      .getState()
      .setDraft(key, {
        answers: answers.map((a) => (a.id === answer.id ? answer : a)),
      });
    setError(null);
  };
  const submit = async (): Promise<void> => {
    if (pending || invalid || !onAnswer) return;
    const input = draft?.submission ?? {
      identity: question.identity,
      clientOperationId: crypto.randomUUID(),
      answers,
    };
    useAgentQuestionStore
      .getState()
      .setDraft(key, { answers, submission: input });
    setPending(true);
    setError(null);
    try {
      await onAnswer(input);
      useAgentQuestionStore.getState().clear(key);
    } catch {
      setPending(false);
      setError(t('ai.workspace.question.submitFailed'));
    }
  };
  return (
    <Card
      className="ai-question-panel max-h-[min(600px,72vh)] gap-0 py-0 max-[421px]:max-h-[72vh]"
      data-slot="ai-question-panel"
      data-question-id={question.identity.questionRequestId}
      data-collapsed={collapsed || undefined}
    >
      <CardHeader className="ai-question-panel-header min-h-[70px] shrink-0 gap-[3px] px-[18px] pt-[11px] pb-2 max-[421px]:min-h-[66px] max-[421px]:px-3 max-[421px]:pt-2.5 max-[421px]:pb-[7px]">
        <CardDescription>
          {currentQuestion.header ?? t('ai.workspace.question.title')}
        </CardDescription>
        <CardTitle className="ai-question-panel-title">
          {currentQuestion.question}
        </CardTitle>
        <CardAction className="ai-question-panel-actions flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
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
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('common.close')}
            onClick={() => setCollapsed(true)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>
      {!collapsed && (
        <>
          <CardContent className="ai-question-panel-content min-h-0 overflow-x-hidden overflow-y-auto px-4 pt-px pb-1.5 max-[421px]:px-2.5 max-[421px]:pt-0">
            <FieldGroup className="ai-question-list gap-0">
              <FieldSet
                key={currentQuestion.id}
                className="ai-question-item gap-[5px] p-0"
                disabled={pending}
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
                      onValueChange={(selected) =>
                        update({
                          id: currentQuestion.id,
                          selected,
                          ...(currentQuestion.multi_select && currentAnswer.custom
                            ? { custom: currentAnswer.custom }
                            : {}),
                        })
                      }
                      orientation="vertical"
                      variant="outline"
                    >
                      {currentQuestion.options.map((option, optionIndex) => (
                        <ToggleGroupItem
                          key={option.label}
                          className="ai-question-option relative h-auto min-h-8 w-full max-w-full shrink justify-start gap-[7px] px-[5px] py-[3px] text-left whitespace-normal"
                          value={option.label}
                          disabled={pending}
                          aria-label={option.label}
                          aria-description={option.description}
                        >
                          <Badge
                            className="ai-question-option-index size-6 min-w-6 shrink-0 p-0"
                            variant="secondary"
                          >
                            {optionIndex + 1}
                          </Badge>
                          <span className="ai-question-option-copy flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 max-[421px]:flex-wrap">
                            <span className="ai-question-option-heading shrink-0">
                              {option.label.replace(recommendedSuffix, '')}
                            </span>
                            {recommendedSuffix.test(option.label) && (
                              <Badge variant="secondary" size="sm">
                                {t('ai.workspace.question.recommended')}
                              </Badge>
                            )}
                            {option.description && (
                              <span className="ai-question-option-description min-w-0 max-[421px]:basis-full">
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
                  data-disabled={pending || undefined}
                >
                  <FieldLabel className="sr-only" htmlFor={inputId}>
                    {t(
                      currentQuestion.options
                        ? 'ai.workspace.question.custom'
                        : 'ai.workspace.question.answer',
                    )}
                  </FieldLabel>
                  <InputGroup className="ai-question-custom-input min-h-8">
                    <InputGroupTextarea
                      className="ai-question-textarea mr-0 min-h-8 max-h-[76px] w-auto flex-1 py-1.5 pr-[7px] pl-0"
                      id={inputId}
                      rows={1}
                      value={currentAnswer.custom ?? ''}
                      disabled={pending}
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
            </FieldGroup>
          </CardContent>
          <CardFooter className="ai-question-panel-footer min-h-12 shrink-0 justify-between gap-2.5 px-3.5 pt-1.5 pb-[7px] max-[421px]:flex-wrap max-[421px]:px-2.5">
            <div className="ai-question-pagination flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
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
                size="icon-xs"
                aria-label={t('ai.workspace.question.next')}
                disabled={pending || currentIndex === question.questions.length - 1}
                onClick={() => setCurrentIndex((index) => index + 1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </Button>
            </div>
            <div className="ai-question-footer-message min-w-0 flex-1 max-[421px]:order-3 max-[421px]:basis-full">
              {error && <FieldError role="alert">{error}</FieldError>}
            </div>
            <div className="ai-question-footer-actions flex shrink-0 items-center gap-1.5">
              <Button
                className="min-w-[68px] max-[421px]:min-w-auto"
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  if (currentIndex < question.questions.length - 1) {
                    setCurrentIndex((index) => index + 1);
                  } else {
                    setCollapsed(true);
                  }
                }}
              >
                {t('ai.workspace.question.skip')}
              </Button>
              <Button
                className="min-w-[68px] max-[421px]:min-w-auto"
                type="button"
                size="sm"
                disabled={pending || invalid || !onAnswer}
                onClick={() => void submit()}
              >
                {pending && <Spinner data-icon="inline-start" />}
                {t(
                  pending
                    ? 'ai.workspace.question.submitting'
                    : 'ai.workspace.question.submit',
                )}
              </Button>
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
    question.answers.some((answer) => answer.id === item.id),
  ).length;
  const summary = `${answered}/${question.questions.length} ${status}`;
  useEffect(() => {
    if (question.status !== 'pending')
      useAgentQuestionStore.getState().clear(key);
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
            className="ai-question-history-card mt-0.5 ml-[22px] gap-0 py-1.5"
            variant="outline"
          >
            <CardHeader className="sr-only">
              <CardTitle>{status}</CardTitle>
            </CardHeader>
            <CardContent className="px-2.5">
              <FieldGroup className="gap-2">
                {question.questions.map((q) => {
                  const answer = question.answers.find((a) => a.id === q.id);
                  return (
                    <FieldSet className="gap-1" key={q.id}>
                      <FieldLegend className="mb-0">{q.question}</FieldLegend>
                      {answer && (
                        <FieldDescription>
                          {[...answer.selected, answer.custom]
                            .filter(Boolean)
                            .join(' · ')}
                        </FieldDescription>
                      )}
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
