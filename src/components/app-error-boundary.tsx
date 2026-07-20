import React from 'react';
import { CircleAlertIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

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
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <CircleAlertIcon className="size-5" />
          </span>
          <CardTitle>{t('app.errorBoundary.title')}</CardTitle>
          <CardDescription>
            {t('app.errorBoundary.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground">
              {t('app.errorBoundary.details')}
            </summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-[11px] leading-4">
              {error.message}
            </pre>
          </details>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="outline" onClick={onRetry}>
            <RotateCcwIcon data-icon="inline-start" />
            {t('common.retry')}
          </Button>
          <Button onClick={onReload}>
            <RefreshCwIcon data-icon="inline-start" />
            {t('app.errorBoundary.reload')}
          </Button>
        </CardFooter>
      </Card>
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
