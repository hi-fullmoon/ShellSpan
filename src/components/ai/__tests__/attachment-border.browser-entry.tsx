import { createRoot } from 'react-dom/client';
import { AiDocumentAttachments } from '../workspace/ai-document-attachments';
import { AiDraftAttachmentRail } from '../workspace/ai-image-draft-rail';
import { initI18n } from '@/locales';
import readme from '../../../../README.md?raw';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('zh-CN');
createRoot(document.getElementById('root')!).render(
  <main className="p-3">
    <AiDraftAttachmentRail unified count={1}>
      <AiDocumentAttachments composer documents={[
        { id: 'README.md', name: 'README.md', size: new TextEncoder().encode(readme).length, text: readme },
      ]} />
    </AiDraftAttachmentRail>
  </main>,
);
