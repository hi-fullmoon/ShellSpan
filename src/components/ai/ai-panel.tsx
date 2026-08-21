import React, { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  BotIcon,
  ClipboardIcon,
  Code2Icon,
  EraserIcon,
  PanelRightCloseIcon,
  SendIcon,
  SparklesIcon,
  SquareTerminalIcon,
  StopCircleIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Bubble, Marker, Message, MessageScroller } from './chat-primitives';
import { useI18n } from '@/hooks/useI18n';
import { invokeCancelAiRequest, invokeStartAiRequest, isTauriRuntime } from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import {
  getRecentTerminalOutput,
  redactTerminalSecrets,
} from '@/lib/terminal-output-buffer';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useAiStore } from '@/stores/aiStore';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AiContext, AiMessageInput, AiStreamEvent, AiTaskKind } from '@/types/ai';

const AI_STREAM_EVENT = 'ai-stream';

export function extractSingleLineCommand(content: string): string | undefined {
  const match = /```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i.exec(content);
  if (!match) return undefined;
  const command = match[1].trim();
  if (!command || /[\r\n]/.test(command)) return undefined;
  return command;
}

function currentTerminalContext(): { context?: AiContext; selection: boolean } {
  const app = useAppStore.getState();
  if (app.activeSection !== 'terminal') return { selection: false };
  const terminalState = useTerminalStore.getState();
  const session = terminalState.sessions.find((item) => item.sessionId === terminalState.activeSessionId);
  if (!session) return { selection: false };
  const selection = terminalRegistry.get(session.sessionId)?.terminal.getSelection().trim();
  const contextLines = useAiSettingsStore.getState().contextLines;
  const content = selection
    ? redactTerminalSecrets(selection)
    : getRecentTerminalOutput(session.sessionId, contextLines);
  if (!content) return { selection: false };
  return {
    selection: Boolean(selection),
    context: {
      label: `${session.username ? `${session.username}@` : ''}${session.host || session.title}`,
      content,
    },
  };
}

export const AiPanel: React.FC = () => {
  const { t } = useI18n();
  const open = useAiStore((state) => state.open);
  const setOpen = useAiStore((state) => state.setOpen);
  const messages = useAiStore((state) => state.messages);
  const phase = useAiStore((state) => state.phase);
  const activeRequestId = useAiStore((state) => state.activeRequestId);
  const error = useAiStore((state) => state.error);
  const clear = useAiStore((state) => state.clear);
  const providerKind = useAiSettingsStore((state) => state.providerKind);
  const model = useAiSettingsStore((state) =>
    state.providerKind === 'ollama' ? state.ollamaModel : state.openAiModel,
  );
  const activeSection = useAppStore((state) => state.activeSection);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId);
  const [draft, setDraft] = useState('');
  const [task, setTask] = useState<AiTaskKind>('chat');
  const [contextEnabled, setContextEnabled] = useState(true);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AiStreamEvent>(AI_STREAM_EVENT, (event) => {
      const state = useAiStore.getState();
      const payload = event.payload;
      if (payload.type === 'textDelta') state.appendDelta(payload.requestId, payload.text);
      else if (payload.type === 'completed') state.completeRequest(payload.requestId);
      else if (payload.type === 'cancelled') state.cancelRequest(payload.requestId);
      else if (payload.type === 'error') state.failRequest(payload.requestId, payload.message);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const contextSnapshot = currentTerminalContext();

  const send = useCallback(async (requestTask: AiTaskKind, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || useAiStore.getState().phase === 'streaming') return;
    const requestId = generateId();
    const previousMessages: AiMessageInput[] = useAiStore
      .getState()
      .messages
      .filter((message) => message.content.trim())
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));
    const snapshot = contextEnabled ? currentTerminalContext() : { selection: false };
    useAiStore.getState().beginRequest(requestId, requestTask, trimmed);
    setDraft('');
    try {
      await invokeStartAiRequest({
        requestId,
        provider: useAiSettingsStore.getState().getProviderConfig(),
        task: requestTask,
        messages: [...previousMessages, { role: 'user', content: trimmed }],
        context: snapshot.context,
      });
    } catch (reason) {
      useAiStore.getState().failRequest(
        requestId,
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }, [contextEnabled]);

  const handleExplain = (): void => {
    const snapshot = currentTerminalContext();
    const prompt = snapshot.selection
      ? t('ai.prompt.explainSelection')
      : t('ai.prompt.explainRecentOutput');
    void send('explainTerminal', prompt);
  };

  const handleCancel = (): void => {
    if (!activeRequestId) return;
    void invokeCancelAiRequest(activeRequestId);
  };

  const handleInsertCommand = (command: string): void => {
    const state = useTerminalStore.getState();
    if (!state.activeSessionId) return;
    const session = state.sessions.find((item) => item.sessionId === state.activeSessionId);
    if (session?.status !== 'connected') return;
    terminalRegistry.get(state.activeSessionId)?.terminal.paste(command.replace(/[\r\n]+$/g, ''));
  };

  const openSettings = (): void => {
    const app = useAppStore.getState();
    app.setActiveSection('workbench');
    app.setActiveWorkbenchTab('settings');
  };

  if (!open) return null;

  const followKey = `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}`;
  const canExplain = activeSection === 'terminal' && Boolean(contextSnapshot.context);

  return (
    <TooltipProvider>
      <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-app-border bg-background" aria-label={t('ai.title')}>
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{t('ai.title')}</div>
              <div className="truncate text-[11px] text-muted-foreground">{model || t('ai.modelMissing')}</div>
            </div>
            <Badge variant={providerKind === 'ollama' ? 'secondary' : 'outline'}>
              {providerKind === 'ollama' ? t('ai.local') : t('ai.cloud')}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={clear} disabled={phase === 'streaming'} aria-label={t('ai.clear')} />}>
                <EraserIcon />
              </TooltipTrigger>
              <TooltipContent>{t('ai.clear')}</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label={t('ai.close')}>
              <PanelRightCloseIcon />
            </Button>
          </div>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Button variant="outline" size="xs" onClick={handleExplain} disabled={!canExplain || phase === 'streaming'}>
            <SquareTerminalIcon data-icon="inline-start" />
            {t('ai.explainTerminal')}
          </Button>
          {contextSnapshot.context && (
            <Button
              variant={contextEnabled ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setContextEnabled((value) => !value)}
              aria-pressed={contextEnabled}
            >
              {contextSnapshot.selection ? t('ai.context.selection') : t('ai.context.recentOutput')}
            </Button>
          )}
        </div>

        <MessageScroller className="flex-1" followKey={followKey}>
          {messages.length === 0 && (
            <Marker>
              <BotIcon className="mx-auto mb-2 size-6" />
              {t('ai.empty')}
            </Marker>
          )}
          {messages.map((message) => {
            const command = message.role === 'assistant' ? extractSingleLineCommand(message.content) : undefined;
            return (
              <Message key={message.id} role={message.role}>
                <Bubble role={message.role}>
                  {message.content || (phase === 'streaming' ? <Spinner /> : '')}
                  {command && (
                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                      <Button variant="outline" size="xs" onClick={() => void navigator.clipboard.writeText(command)}>
                        <ClipboardIcon data-icon="inline-start" />
                        {t('common.copy')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => handleInsertCommand(command)}
                        disabled={!activeSession || activeSession.status !== 'connected'}
                      >
                        <Code2Icon data-icon="inline-start" />
                        {t('ai.insertCommand')}
                      </Button>
                    </div>
                  )}
                </Bubble>
              </Message>
            );
          })}
        </MessageScroller>

        {error && (
          <Alert variant="destructive" className="mx-3 mb-2 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="shrink-0 border-t border-border p-3">
          <ToggleGroup
            value={[task]}
            onValueChange={(values) => {
              const value = values[0] as AiTaskKind | undefined;
              if (value) setTask(value);
            }}
            variant="outline"
            size="xs"
            spacing={0}
            className="mb-2"
            aria-label={t('ai.mode')}
          >
            <ToggleGroupItem value="chat">{t('ai.mode.chat')}</ToggleGroupItem>
            <ToggleGroupItem value="generateCommand">{t('ai.mode.command')}</ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(task, draft);
                }
              }}
              placeholder={task === 'generateCommand' ? t('ai.commandPlaceholder') : t('ai.placeholder')}
              className="min-h-20 resize-none"
              disabled={phase === 'streaming'}
            />
            {phase === 'streaming' ? (
              <Button variant="outline" size="icon" onClick={handleCancel} aria-label={t('ai.stop')}>
                <StopCircleIcon />
              </Button>
            ) : (
              <Button size="icon" onClick={() => void send(task, draft)} disabled={!draft.trim()} aria-label={t('ai.send')}>
                <SendIcon />
              </Button>
            )}
          </div>
          {!model.trim() && (
            <Button variant="link" size="xs" className="mt-1 px-0" onClick={openSettings}>
              {t('ai.configure')}
            </Button>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
};
