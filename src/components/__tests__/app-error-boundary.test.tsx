import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../app-error-boundary';

const loggerError = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    ready: true,
    locale: 'en-US',
    setLocale: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerError,
  }),
}));

const BrokenComponent: React.FC = () => {
  throw new Error('shortcut.split failed');
};

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    loggerError.mockClear();
  });

  it('renders children while the application is healthy', () => {
    render(
      <AppErrorBoundary>
        <div>healthy application</div>
      </AppErrorBoundary>,
    );

    expect(screen.getByText('healthy application')).toBeInTheDocument();
  });

  it('shows a recovery screen and logs render errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <BrokenComponent />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('app.errorBoundary.title')).toBeInTheDocument();
    expect(screen.getByText('shortcut.split failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'app.errorBoundary.reload' }),
    ).toBeInTheDocument();
    expect(loggerError).toHaveBeenCalledWith(
      'React render failed',
      expect.any(Error),
      expect.any(String),
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
