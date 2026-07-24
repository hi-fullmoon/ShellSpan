import React from 'react';
import { CircleAlertIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';

const logger = createLogger('error-boundary');

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  error?: Error;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

interface AppErrorFallbackProps {
  error: Error;
  onRetry: () => void;
  onReload: () => void;
}

const AppErrorFallback: React.FC<AppErrorFallbackProps> = ({
  error,
  onRetry,
  onReload,
}) => {
  const { t } = useI18n();

  return (
    <main
      role="alert"
      className="flex h-full min-h-screen w-full items-center justify-center bg-app-bg p-4"
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-[var(--shadow-dialog)]">
        <div className="px-4 py-2.5 pr-11">
          <div className="mb-2 inline-flex size-10 items-center justify-center rounded-md bg-app-error/10 text-app-error">
            <CircleAlertIcon className="size-5" />
          </div>
          <h2 className="font-heading text-sm font-medium leading-5 text-app-text">
            {t('app.errorBoundary.title')}
          </h2>
          <p className="text-sm leading-5 text-app-text-soft">
            {t('app.errorBoundary.description')}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-3 px-4 py-3">
          <details className="text-xs text-app-text-soft">
            <summary className="cursor-pointer select-none font-medium text-app-text">
              {t('app.errorBoundary.details')}
            </summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-app-surface-muted p-3 font-mono text-[11px] leading-4">
              {error.message}
            </pre>
          </details>
        </div>
        <div className="flex flex-row justify-end gap-2 bg-app-surface px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcwIcon data-icon="inline-start" />
            {t('common.retry')}
          </Button>
          <Button size="sm" onClick={onReload}>
            <RefreshCwIcon data-icon="inline-start" />
            {t('app.errorBoundary.reload')}
          </Button>
        </div>
      </div>
    </main>
  );
};

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error('React render failed', error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: undefined });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <AppErrorFallback
          error={this.state.error}
          onRetry={this.handleRetry}
          onReload={this.handleReload}
        />
      );
    }

    return this.props.children;
  }
}
