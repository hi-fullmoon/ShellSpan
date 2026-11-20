import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CompactDialogBody, CompactDialogContent, CompactDialogFooter, CompactDialogHeader } from '@/components/ui/compact-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { fillSnippetTemplate, parseSnippetTemplate, type CommandSnippet } from '@/lib/terminal/snippet-template';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { terminalRegistry } from './registry/terminal-registry';

export function TerminalSnippetDialog({ snippet, sessionId, close }: {
  snippet: CommandSnippet;
  sessionId: string;
  close: () => void;
}) {
  const { t } = useI18n();
  const { error } = useToast();
  const id = useId();
  const formId = id + '-form';
  const parameters = parseSnippetTemplate(snippet.commandTemplate);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    (parameters ?? []).filter((parameter) => parameter.defaultValue !== undefined)
      .map(({ name, defaultValue }) => [name, defaultValue ?? '']),
  ));
  const [sending, setSending] = useState(false);
  const command = fillSnippetTemplate(snippet.commandTemplate, values);
  const send = async (execute: boolean) => {
    if (!command || sending) return;
    const session = useTerminalStore.getState().sessions.find((item) => item.sessionId === sessionId);
    const controller = terminalRegistry.get(sessionId);
    if (!controller || session?.status !== 'connected' || session.readOnly || agentTerminalLeaseState.get(sessionId)
      || controller.terminal.buffer.active.type !== 'normal'
      || (execute && (controller.hasPendingUserInput() || controller.hasUnverifiedUserSubmission()
        || (session.integrationState === 'ready' && !session.promptReady)))) {
      error(t('terminal.snippets.inputUnavailable'));
      return;
    }
    setSending(true);
    try {
      if (!await controller.writeUserInput(command + (execute ? '\r' : ''))) {
        error(t('terminal.snippets.inputUnavailable'));
        return;
      }
      useTerminalStore.getState().setActiveSession(sessionId);
      useAppStore.getState().setActiveSection('terminal');
      close();
      requestAnimationFrame(() => controller.focus());
    } catch {
      error(t('terminal.notice.writeFailedLabel'));
    } finally {
      setSending(false);
    }
  };

  return <Dialog open onOpenChange={(open) => { if (!open && !sending) close(); }}>
    <CompactDialogContent className="max-w-lg" showCloseButton={!sending}>
      <CompactDialogHeader title={snippet.name} description={snippet.description || undefined} />
      <CompactDialogBody>
        <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => {
          event.preventDefault();
          void send(false);
        }}>
          {parameters && parameters.length > 0 && (
            <FieldGroup className="gap-2.5">
              {parameters.map(({ name, defaultValue }, index) => <Field key={name}>
                <FieldLabel htmlFor={id + '-' + index}>{name}</FieldLabel>
                <Input id={id + '-' + index} value={Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''} autoFocus={index === 0}
                  required={defaultValue === undefined} maxLength={4096}
                  onChange={(event) => setValues((previous) => ({ ...previous, [name]: event.target.value }))} />
              </Field>)}
            </FieldGroup>
          )}
          <Field>
            <FieldLabel>{t('terminal.snippets.preview')}</FieldLabel>
            <pre className="rounded-md border border-app-border/60 bg-muted/60 px-2.5 py-2 whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {command ?? snippet.commandTemplate}
            </pre>
          </Field>
        </form>
      </CompactDialogBody>
      <CompactDialogFooter>
        <Button type="button" variant="outline" size="sm" disabled={sending} onClick={close}>{t('common.cancel')}</Button>
        <Button type="button" variant="outline" size="sm" disabled={!command || sending} onClick={() => void send(true)}>{t('terminal.snippets.execute')}</Button>
        <Button type="submit" form={formId} size="sm" disabled={!command || sending}>{t('terminal.snippets.insert')}</Button>
      </CompactDialogFooter>
    </CompactDialogContent>
  </Dialog>;
}
