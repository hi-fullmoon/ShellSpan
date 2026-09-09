import { useEffect, useState } from 'react';
import {
  CheckIcon,
  MessageCircleQuestionIcon,
  SendIcon,
} from 'lucide-react';
import {
  Card,
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
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
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
  const answers: readonly QuestionAnswer[] =
    draft?.answers ??
    question.questions.map((q) => ({ id: q.id, selected: [] }));
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
    >
      <CardHeader className="ai-question-panel-header">
        <CardTitle className="ai-question-panel-title">
          <MessageCircleQuestionIcon aria-hidden="true" />
          {t('ai.workspace.question.title')}
        </CardTitle>
        <CardDescription>
          {t('ai.workspace.question.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="ai-question-panel-content">
        <FieldGroup className="ai-question-list">
          {question.questions.map((q, index) => {
            const answer = answers.find((a) => a.id === q.id)!;
            const inputId = `${question.identity.questionRequestId}-${index}`;
            const tooLong =
              new TextEncoder().encode(answer.custom ?? '').length > 8192;
            return (
              <FieldSet
                key={q.id}
                className="ai-question-item"
                disabled={pending}
              >
                <FieldLegend>{q.header ?? q.question}</FieldLegend>
                {q.header && <FieldDescription>{q.question}</FieldDescription>}
                {q.options && (
                  <Field>
                    <ToggleGroup
                      className="ai-question-options"
                      aria-label={q.question}
                      multiple={q.multi_select}
                      value={[...answer.selected]}
                      onValueChange={(selected) =>
                        update({
                          id: q.id,
                          selected,
                          ...(q.multi_select && answer.custom
                            ? { custom: answer.custom }
                            : {}),
                        })
                      }
                      orientation="vertical"
                      variant="outline"
                    >
                      {q.options.map((option) => (
                        <ToggleGroupItem
                          key={option.label}
                          className="ai-question-option"
                          value={option.label}
                          disabled={pending}
                          aria-label={option.label}
                          aria-description={option.description}
                        >
                          <span className="ai-question-option-copy">
                            <span className="ai-question-option-heading">
                              <span>
                                {option.label.replace(recommendedSuffix, '')}
                              </span>
                              {recommendedSuffix.test(option.label) && (
                                <Badge variant="secondary" size="sm">
                                  {t('ai.workspace.question.recommended')}
                                </Badge>
                              )}
                            </span>
                            {option.description && (
                              <span className="ai-question-option-description">
                                {option.description}
                              </span>
                            )}
                          </span>
                          {answer.selected.includes(option.label) && (
                            <CheckIcon aria-hidden="true" />
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
                  <FieldLabel htmlFor={inputId}>
                    {t(
                      q.options
                        ? 'ai.workspace.question.custom'
                        : 'ai.workspace.question.answer',
                    )}
                  </FieldLabel>
                  <Textarea
                    className="ai-question-textarea"
                    id={inputId}
                    value={answer.custom ?? ''}
                    disabled={pending}
                    aria-invalid={tooLong || undefined}
                    maxLength={8192}
                    placeholder={t(
                      q.options
                        ? 'ai.workspace.question.customPlaceholder'
                        : 'ai.workspace.question.answerPlaceholder',
                    )}
                    onChange={(event) =>
                      update({
                        id: q.id,
                        selected: q.multi_select ? answer.selected : [],
                        ...(event.target.value
                          ? { custom: event.target.value }
                          : {}),
                      })
                    }
                  />
                  {tooLong && (
                    <FieldError>
                      {t('ai.workspace.question.tooLong')}
                    </FieldError>
                  )}
                </Field>
              </FieldSet>
            );
          })}
        </FieldGroup>
      </CardContent>
      <CardFooter className="ai-question-panel-footer">
        <div className="ai-question-footer-message">
          {error && <FieldError role="alert">{error}</FieldError>}
        </div>
        <Button
          type="button"
          disabled={pending || invalid || !onAnswer}
          onClick={() => void submit()}
        >
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <SendIcon data-icon="inline-start" />
          )}
          {t(
            pending
              ? 'ai.workspace.question.submitting'
              : 'ai.workspace.question.submit',
          )}
        </Button>
      </CardFooter>
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
  useEffect(() => {
    if (question.status !== 'pending')
      useAgentQuestionStore.getState().clear(key);
  }, [key, question.status]);
  return (
    <Card data-slot="ai-question-history">
      <CardHeader>
        <CardTitle>{t(`ai.workspace.question.${question.status}`)}</CardTitle>
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
  );
}
