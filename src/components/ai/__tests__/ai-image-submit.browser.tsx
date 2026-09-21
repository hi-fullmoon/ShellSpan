import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { AiImageDraftRail } from '../workspace/ai-image-draft-rail';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import '../styles/styles.css';

export async function mount(host: HTMLElement, data: string) {
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
  const images = [{ name: 'screenshot.png', mediaType: 'image/png', data }];
  function Workspace() {
    const [busy, setBusy] = useState(false);
    return <AiWorkspaceRoot scope="workbench" mode="ask" view={null} hasImages imageBusy={busy}
      onSubmitGesture={() => setBusy(true)}
      imageControls={<AiImageDraftRail images={images} busy={busy} locked={busy} error={false}
        onRemove={() => {}} onCancel={busy ? () => setBusy(false) : undefined} />} />;
  }
  createRoot(host).render(<Workspace />);
}
