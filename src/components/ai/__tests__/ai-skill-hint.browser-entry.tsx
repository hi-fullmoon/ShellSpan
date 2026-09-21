import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { builtinSkillPreview } from '@/lib/ai/builtin-skills';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '../styles/styles.css';

const locale = location.search.includes('en-US') ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);
createRoot(document.getElementById('root')!).render(
  <main className="ai-panel-shell p-3" style={{ paddingTop: 400 }}>
    <AiComposerSeat phase="active" status="idle" onListSkills={async () => builtinSkillPreview} />
  </main>,
);
