import { useEffect, useId, useRef, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { invokeRespondToSshInteractiveAuth, isTauriRuntime, listenToSshInteractiveAuthClosed,
  listenToSshInteractiveAuthPrompt, type SshInteractiveAuthPrompt } from '@/lib/ipc/tauri';

function InteractiveAuthDialog({ challenge, dismiss }: { challenge: SshInteractiveAuthPrompt; dismiss: () => void }) {
  const { t } = useI18n();
  const { error } = useToast();
  const id = useId();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [sending, setSending] = useState(false);
  const formId = id + '-form';

  const respond = (accept: boolean): void => {
    if (sending) return;
    const answers = accept ? challenge.prompts.map((_, index) => inputs.current[index]?.value ?? '') : null;
    for (const input of inputs.current) if (input) input.value = '';
    setSending(true);
    void invokeRespondToSshInteractiveAuth(challenge.operationId, challenge.promptId, answers).then(dismiss)
      .catch(() => {
        error(t('connection.interactive.responseFailed'));
        setSending(false);
      }).finally(() => { answers?.fill(''); });
  };

  return <Dialog open onOpenChange={(open) => { if (!open) respond(false); }}>
    <CompactDialogContent className="max-w-md" showCloseButton={!sending}>
      <CompactDialogHeader title={t('connection.interactive.title')}
        description={t('connection.interactive.host', { host: challenge.host, username: challenge.username })} />
      <CompactDialogBody>
        <form id={formId} autoComplete="off" className="flex flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          respond(true);
        }}>
          {challenge.instructions && (
            <p className="rounded-md border border-app-border/60 bg-muted/50 px-2.5 py-2 whitespace-pre-wrap break-all text-xs text-muted-foreground">
              {challenge.instructions}
            </p>
          )}
          <FieldGroup className="gap-3">
            {challenge.prompts.map(({ text, echo }, index) => <Field key={index}>
              <FieldLabel htmlFor={id + '-' + index} className="whitespace-pre-wrap break-all">
                {text || t('connection.interactive.answer', { number: index + 1 })}
              </FieldLabel>
              <Input id={id + '-' + index} ref={(element) => { inputs.current[index] = element; }}
                autoFocus={index === 0} type={echo ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                maxLength={4096} disabled={sending} />
            </Field>)}
          </FieldGroup>
        </form>
      </CompactDialogBody>
      <CompactDialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={() => respond(false)} disabled={sending}>{t('common.cancel')}</Button>
        <Button type="submit" form={formId} size="sm" disabled={sending}>
          {sending && <Spinner data-icon="inline-start" aria-hidden="true" />}
          {t('connection.interactive.submit')}
        </Button>
      </CompactDialogFooter>
    </CompactDialogContent>
  </Dialog>;
}

export function SshInteractiveAuthDialogHost() {
  const [challenges, setChallenges] = useState<SshInteractiveAuthPrompt[]>([]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const listeners: UnlistenFn[] = [];
    const retain = (listener: UnlistenFn) => { if (disposed) listener(); else listeners.push(listener); };
    void listenToSshInteractiveAuthPrompt(({ payload }) => {
      if (!disposed) setChallenges((current) => [...current.filter((item) => item.promptId !== payload.promptId), payload]);
    }).then(retain).catch(() => {});
    void listenToSshInteractiveAuthClosed(({ payload }) => {
      if (!disposed) setChallenges((current) => current.filter((item) => item.promptId !== payload));
    }).then(retain).catch(() => {});
    return () => { disposed = true; listeners.forEach((listener) => listener()); };
  }, []);
  const challenge = challenges[0];
  return challenge && <InteractiveAuthDialog key={challenge.promptId} challenge={challenge} dismiss={() =>
    setChallenges((current) => current.filter((item) => item.promptId !== challenge.promptId))} />;
}
