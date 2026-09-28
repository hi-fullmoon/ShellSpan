import React, { createRef, useImperativeHandle } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@/locales';
import { useImageDraft } from '../workspace/use-image-draft';
import { useAiSessionController } from '../workspace/use-ai-session-controller';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';

export async function mountImagePreparation(host: HTMLElement, owner: string) {
  await initI18n('en-US');
  const api = createRef<ReturnType<typeof useImageDraft>>();
  function Editor() {
    const draft = useImageDraft(owner, 'Inspect the attached image', () => {});
    useImperativeHandle(api, () => draft);
    return <pre>{JSON.stringify({ ready: Boolean(draft.draft), busy: draft.busy, images: draft.draft?.images.length })}</pre>;
  }
  const root = createRoot(host);
  root.render(<Editor />);
  return { api, unmount: () => root.unmount() };
}

/** The real adapter encounters the absent native IPC transport in this browser.
 * No backend, model responses, or storage APIs are replaced by the test. */
export async function mountDisconnectedController(host: HTMLElement) {
  await initI18n('en-US');
  useAiSettingsStore.setState({ providers: [{ id: 'local-offline', name: 'Local', preset: 'ollama',
    kind: 'ollama', profile: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2', requiresApiKey: false }],
    defaultProviderId: 'local-offline' });
  const api = createRef<ReturnType<typeof useAiSessionController>>();
  function Controller() {
    const controller = useAiSessionController({ scope: 'workbench' });
    useImperativeHandle(api, () => controller);
    return <pre>{JSON.stringify({ failed: controller.composer.failedDrafts.map(item => item.content),
      pending: controller.composer.pendingSubmissions.map(item => item.content) })}</pre>;
  }
  const root = createRoot(host);
  root.render(<Controller />);
  return { api, unmount: () => root.unmount() };
}
