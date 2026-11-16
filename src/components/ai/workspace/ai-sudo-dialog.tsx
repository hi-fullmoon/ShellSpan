import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/hooks/useI18n';
import {
  isTauriRuntime,
  listenToAgentSudoPrompt,
  respondToAgentSudoPrompt,
  type AgentSudoPromptEvent,
} from '@/lib/ipc/tauri';
import { AI_CONTENT_CODE_CLASS } from './ai-style-classes';

type SudoRequest = Extract<AgentSudoPromptEvent, { state: 'requested' }>;

export function AiSudoDialogHost() {
  const [requests, setRequests] = useState<SudoRequest[]>([]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const listener = listenToAgentSudoPrompt(({ payload }) => {
      if (!active) return;
      setRequests((current) => payload.state === 'closed'
        ? current.filter((prompt) => prompt.promptId !== payload.promptId)
        : [...current, payload]);
    });
    void listener.catch(() => {});
    return () => {
      active = false;
      void listener.then((unlisten) => unlisten(), () => {});
    };
  }, []);
  const request = requests[0];
  return request ? <AiSudoDialog key={request.promptId} request={request} onRespond={respondToAgentSudoPrompt} /> : null;
}

export function AiSudoDialog({ request, onRespond }: {
  request: SudoRequest;
  onRespond: (promptId: string, password: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const host = request.host.includes(':') ? `[${request.host}]` : request.host;

  const respond = async (password: string | null) => {
    if (submitting.current) return;
    submitting.current = true;
    if (input.current) input.current.value = '';
    setPending(true);
    try {
      await onRespond(request.promptId, password);
    } catch {
      submitting.current = false;
      setPending(false);
      toast.error(t('ai.workspace.sudo.submitFailed'));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (input.current?.value) void respond(input.current.value);
  };

  return (
    <Dialog open disablePointerDismissal onOpenChange={(open) => { if (!open) void respond(null); }}>
      <CompactDialogContent className="max-w-sm" showCloseButton={false} initialFocus={input}>
        <CompactDialogHeader title={t('ai.workspace.sudo.title')} description={t('ai.workspace.sudo.description', {
          account: `${request.username}@${host}:${request.port}`,
        })} />
        <CompactDialogBody>
          <pre className={AI_CONTENT_CODE_CLASS}><code>{`sudo -- ${request.command}`}</code></pre>
          <form id={formId} onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={inputId}>{t('ai.workspace.sudo.password')}</FieldLabel>
                <Input id={inputId} ref={input} type="password" autoComplete="off" required maxLength={4096} disabled={pending} />
              </Field>
            </FieldGroup>
          </form>
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => void respond(null)}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} size="sm" disabled={pending}>{t('ai.workspace.sudo.authenticate')}</Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
}
