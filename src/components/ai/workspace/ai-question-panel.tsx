import { useEffect, useState } from 'react';
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
      className="max-h-[60vh]"
      data-slot="ai-question-panel"
      data-question-id={question.identity.questionRequestId}
    >
      <CardHeader className="shrink-0">
        <CardTitle>{t('ai.workspace.question.title')}</CardTitle>
        <CardDescription>
          {t('ai.workspace.question.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 overflow-y-auto">
        <FieldGroup>
          {question.questions.map((q, index) => {
            const answer = answers.find((a) => a.id === q.id)!;
            const inputId = `${question.identity.questionRequestId}-${index}`;
            const tooLong =
              new TextEncoder().encode(answer.custom ?? '').length > 8192;
            return (
              <FieldSet key={q.id} disabled={pending}>
                <FieldLegend>{q.header ?? q.question}</FieldLegend>
                {q.header && <FieldDescription>{q.question}</FieldDescription>}
                {q.options && (
                  <Field>
                    <ToggleGroup
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
                          value={option.label}
                          disabled={pending}
                          aria-description={option.description}
                        >
                          {option.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {q.options.map(
                      (option) =>
                        option.description && (
                          <FieldDescription key={option.label}>
                            {option.label}: {option.description}
                          </FieldDescription>
                        ),
                    )}
                  </Field>
                )}
                <Field
                  data-invalid={tooLong || undefined}
                  data-disabled={pending || undefined}
                >
                  <FieldLabel htmlFor={inputId}>
                    {t('ai.workspace.question.custom')}
                  </FieldLabel>
                  <Textarea
                    id={inputId}
                    value={answer.custom ?? ''}
                    disabled={pending}
                    aria-invalid={tooLong || undefined}
                    maxLength={8192}
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
      <CardFooter className="flex shrink-0 flex-col items-start gap-2">
        {error && <FieldError role="alert">{error}</FieldError>}
        <Button
          type="button"
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
