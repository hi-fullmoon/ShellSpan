import { createRef, StrictMode, useImperativeHandle, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@/locales';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import '../styles/styles.css';

export async function mount(host: HTMLElement, mode: 'ask' | 'agent', running: boolean) {
  await initI18n('zh-CN');
  function Workspace() {
    const [state, dispatch] = useReducer(
      (previous: ReturnType<typeof createAiComposerState>, event: Parameters<typeof reduceAiComposer>[1]) => reduceAiComposer(previous, event).state,
      undefined, () => createAiComposerState(running ? { runtimeStatus: 'running' } : undefined),
    );
    return <AiWorkspaceRoot
      scope="workbench" mode={mode} view={null} composerState={state}
      onDraftChange={value => dispatch({ type: 'draft.changed', value })}
      onSubmitGesture={(gesture, accelerated) => {
        host.dataset.submitted = 'true';
        host.dataset.origin = String(host.querySelector('[data-slot="ai-composer-seat"]')?.getBoundingClientRect().top);
        dispatch({ type: 'submit.requested', gesture, accelerated,
          clientOperationId: crypto.randomUUID(), now: Date.now(), hasProvider: true, canCreateSession: true });
      }}
    />;
  }
  createRoot(host).render(<StrictMode><Workspace /></StrictMode>);
}

/** Exercise the view's asynchronous image-submission contract without a backend. */
export async function mountDeferred(host: HTMLElement) {
  await initI18n('zh-CN');
  type Event = 'progress' | 'complete' | 'fail' | 'cancel' | 'navigate';
  const controls = createRef<{ advance(event: Event): void }>();
  function Workspace() {
    const [draft, setDraft] = useState('图片问题');
    const [busy, setBusy] = useState(false);
    const [active, setActive] = useState(false);
    const [failed, setFailed] = useState(false);
    const [context, setContext] = useState<object>({});
    const [progress, setProgress] = useState(0);
    useImperativeHandle(controls, () => ({ advance(event) {
      if (event === 'progress') { setProgress(value => value + 1); return; }
      setBusy(false);
      setFailed(event === 'fail');
      setActive(event === 'complete' || event === 'navigate');
      if (event === 'navigate') setContext({});
    } }));
    return <AiWorkspaceRoot
      scope="workbench" mode="ask" view={null} imageBusy={busy}
      submissionContext={context} title={String(progress)}
      composerState={createAiComposerState({ draft, runtimeStatus: active ? 'running' : 'idle',
        phase: failed ? 'error' : active ? 'running' : 'idle' })}
      onDraftChange={setDraft}
      onSubmitGesture={() => {
        host.dataset.origin = String(host.querySelector('[data-slot="ai-composer-seat"]')?.getBoundingClientRect().top);
        setFailed(false);
        setBusy(true);
      }}
    />;
  }
  const root = createRoot(host);
  root.render(<StrictMode><Workspace /></StrictMode>);
  return { advance: (event: Event) => controls.current?.advance(event), unmount: () => root.unmount() };
}
