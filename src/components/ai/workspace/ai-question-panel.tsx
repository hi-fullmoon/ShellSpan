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
      className="ai-question-panel"
      data-slot="ai-question-panel"
      data-question-id={question.identity.questionRequestId}
      data-collapsed={collapsed || undefined}
    >
      <CardHeader className="ai-question-panel-header">
        <CardDescription>
          {currentQuestion.header ?? t('ai.workspace.question.title')}
        </CardDescription>
        <CardTitle className="ai-question-panel-title">
          {currentQuestion.question}
        </CardTitle>
        <CardAction className="ai-question-panel-actions">
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
          <CardContent className="ai-question-panel-content">
            <FieldGroup className="ai-question-list">
              <FieldSet
                key={currentQuestion.id}
                className="ai-question-item"
                disabled={pending}
              >
                <FieldLegend className="sr-only">
                  {currentQuestion.header ?? currentQuestion.question}
                </FieldLegend>
                {currentQuestion.options && (
                  <Field>
                    <ToggleGroup
                      className="ai-question-options"
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
                          className="ai-question-option"
                          value={option.label}
                          disabled={pending}
                          aria-label={option.label}
                          aria-description={option.description}
                        >
                          <Badge
                            className="ai-question-option-index"
                            variant="secondary"
                          >
                            {optionIndex + 1}
                          </Badge>
                          <span className="ai-question-option-copy">
                            <span className="ai-question-option-heading">
                              {option.label.replace(recommendedSuffix, '')}
                            </span>
                            {recommendedSuffix.test(option.label) && (
                              <Badge variant="secondary" size="sm">
                                {t('ai.workspace.question.recommended')}
                              </Badge>
                            )}
                            {option.description && (
                              <span className="ai-question-option-description">
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
                  className="ai-question-custom-field"
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
                  <InputGroup className="ai-question-custom-input">
                    <InputGroupTextarea
                      className="ai-question-textarea"
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
                    <InputGroupAddon align="inline-start">
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
          <CardFooter className="ai-question-panel-footer">
            <div className="ai-question-pagination">
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
              <span aria-live="polite">
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
            <div className="ai-question-footer-message">
              {error && <FieldError role="alert">{error}</FieldError>}
            </div>
            <div className="ai-question-footer-actions">
              <Button
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
        className="ai-question-history"
        data-expanded={open || undefined}
        data-question-status={question.status}
      >
        <CollapsibleTrigger
          render={(
            <Button
              type="button"
              variant="plain"
              size="sm"
              className="ai-disclosure-row ai-question-history-trigger"
              aria-label={`${t('ai.workspace.question.historyTitle')} ${summary}`}
              aria-expanded={open}
            />
          )}
        >
          <span className="ai-disclosure-leading" aria-hidden="true">
            <MessageCircleQuestionIcon />
            <ChevronDownIcon className="ai-disclosure-chevron" />
          </span>
          <span className="ai-disclosure-title">
            {t('ai.workspace.question.historyTitle')}
          </span>
          <span className="ai-disclosure-separator" aria-hidden="true" />
          <span className="ai-disclosure-summary">{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card
            data-slot="ai-question-history"
            className="ai-question-history-card"
            variant="outline"
          >
            <CardHeader className="sr-only">
              <CardTitle>{status}</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                {question.questions.map((q) => {
                  const answer = question.answers.find((a) => a.id === q.id);
                  return (
                    <FieldSet key={q.id}>
                      <FieldLegend>{q.question}</FieldLegend>
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
