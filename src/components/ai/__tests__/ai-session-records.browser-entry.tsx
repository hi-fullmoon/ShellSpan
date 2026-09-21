import { createRoot } from 'react-dom/client';
import { AiSessionRecordsList } from '../ai-session-records-list';
import { AiSessionRecordRow } from '../ai-session-records-dialog';
import { AiSessionRecordsDeleteAll } from '../ai-session-records-delete-all';
import { initI18n, t, type LocaleKey } from '@/locales';
import type { Locale } from '@/types';
import type { AgentSessionListItem } from '@/types/agent-session';
import '@/styles/base.css';

declare global {
  interface Window {
    renderRecords: (records: AgentSessionListItem[], key?: string, locale?: Locale, notice?: LocaleKey) => Promise<void>;
    renderDeleteAll: (records: AgentSessionListItem[], disabled?: boolean) => void;
  }
}

await initI18n('zh-CN');
const root = createRoot(document.getElementById('root')!);
const recordAction = (item: AgentSessionListItem) => {
  document.querySelector('output')!.textContent = item.header.sessionId;
};

window.renderDeleteAll = (records, disabled = false) => root.render(
  <div className="flex flex-wrap items-center gap-2 p-4">
    <AiSessionRecordsDeleteAll
      records={records}
      disabled={disabled}
      t={t}
      onBusyChange={(busy) => { document.body.dataset.busy = String(busy); }}
      onDeleted={(id) => { document.querySelector('output')!.textContent = id; }}
      onSettled={async () => window.renderDeleteAll(records, disabled)}
    />
    <output />
  </div>,
);
window.renderRecords = async (records, key = 'all', locale = 'zh-CN', notice) => {
  await initI18n(locale);
  root.render(
  <div className="flex h-[600px] max-w-5xl flex-col bg-card">
    <AiSessionRecordsList
      key={key}
      records={records}
      notices={notice ? [<p key={notice} role="status">{t(notice)}</p>] : []}
      renderRecord={(item) => (
        <AiSessionRecordRow item={item} locale={locale} t={t} disabled={false} onView={recordAction} onDelete={recordAction} />
      )}
    />
    <output className="shrink-0" />
  </div>,
  );
};
