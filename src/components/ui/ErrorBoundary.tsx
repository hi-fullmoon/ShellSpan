import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createLogger } from '../../lib/logger';
import { t } from '../../lib/i18n';

const errorLogger = createLogger('error-boundary');

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    errorLogger.error('未捕获的渲染错误', { error: String(error), stack: error.stack, componentStack: info.componentStack });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div className="surface flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="label">{t('app.errorBoundary.kicker')}</p>
        <h2 className="themed-heading text-sm font-semibold">{t('app.errorBoundary.title')}</h2>
        <p className="text-subtle max-w-md text-xs leading-relaxed">{t('app.errorBoundary.description')}</p>
        <pre className="themed-input max-w-lg overflow-auto rounded-md p-2 text-left text-[11px] text-rose-300!">
          {error.message || String(error)}
        </pre>
        <button className="btn-primary" onClick={this.reset} type="button">
          {t('app.errorBoundary.retry')}
        </button>
      </div>
    );
  }
}
