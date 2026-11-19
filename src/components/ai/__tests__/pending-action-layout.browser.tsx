import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ProviderModelCatalogEditor } from '../provider-model-catalog-editor';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { initI18n, t } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';
import '@/styles/base.css';

const noop = () => undefined;

export async function mount(locale: Locale) {
  useAppStore.setState({ locale });
  await initI18n(locale);
  const root = createRoot(document.getElementById('root')!);
  const total = 120;
  const catalog = (discovering: boolean) => flushSync(() => root.render(<ProviderModelCatalogEditor
    models={[]} defaultModelId="" inherited={false} canReset disabled={false} discovering={discovering}
    onChange={noop} onDefaultChange={noop} onDiscover={async () => undefined}
    onDeclare={async () => undefined} onReset={noop} />));
  const confirm = (kind: 'deletion' | 'authorization', progress: number | null) => flushSync(() => {
    const authorization = kind === 'authorization';
    root.render(<ConfirmationDialog open onOpenChange={noop}
      title={t(authorization ? 'remoteHealth.authorization.title' : 'settings.ai.records.deleteAllTitle')}
      description={authorization ? t('remoteHealth.authorization.scope') : t('settings.ai.records.deleteAllDescription', { count: total })}
      textOnlyActions={!authorization}
      confirmLabel={t(authorization ? 'remoteHealth.authorization.confirm' : 'settings.ai.records.deleteAll')}
      confirmPendingLabel={authorization ? t('remoteHealth.preparing')
        : t('settings.ai.records.deletingAll', { count: progress ?? 0, total })}
      confirmPendingSizingLabel={authorization ? undefined : t('settings.ai.records.deletingAll', { count: total, total })}
      confirmPending={progress !== null} onConfirm={() => confirm(kind, 0)} />);
  });
  return { catalog, confirm, labels: {
    discover: t('settings.ai.loadModels'), discovering: t('settings.ai.loadingModels'),
    reset: t('settings.ai.resetModels'), deleteAll: t('settings.ai.records.deleteAll'),
    authorize: t('remoteHealth.authorization.confirm'), preparing: t('remoteHealth.preparing'),
    cancel: t('common.cancel'), deletionProgress: [0, 9, 10, total].map(count => t('settings.ai.records.deletingAll', { count, total })),
  } };
}
