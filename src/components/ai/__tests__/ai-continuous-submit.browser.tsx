import { createRef, useImperativeHandle, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@/locales';
import { createAiComposerState, reduceAiComposer, type AiComposerEvent } from '@/lib/ai/composer-machine';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import '../styles/styles.css';

export async function mount(host: HTMLElement) {
  await initI18n('zh-CN');
  const controls = createRef<{ confirm(): void }>();
  function Composer() {
    const [state, dispatch] = useReducer((previous: ReturnType<typeof createAiComposerState>, event: AiComposerEvent) =>
      reduceAiComposer(previous, event).state, undefined,
    () => createAiComposerState({ sessionId: 'browser-conversation', runtimeStatus: 'running' }));
    host.dataset.messages = JSON.stringify(state.pendingSubmissions.map(item => item.content));
    useImperativeHandle(controls, () => ({ confirm() {
      const first = state.pendingSubmissions[0];
      if (first) dispatch({ type: 'submit.timedOut', clientOperationId: first.clientOperationId,
        error: { kind: 'offline', message: 'Receipt pending', retryable: true } });
    } }));
    return <AiComposerSeat phase="active" status="running" composerState={state}
      onDraftChange={value => dispatch({ type: 'draft.changed', value })}
      onSubmitGesture={(gesture, accelerated) => dispatch({ type: 'submit.requested', gesture, accelerated,
        clientOperationId: crypto.randomUUID(), now: Date.now(), hasProvider: true, canCreateSession: true })}
    />;
  }
  const root = createRoot(host);
  root.render(<Composer />);
  return { confirm: () => controls.current?.confirm(), unmount: () => root.unmount() };
}
