import { redactTerminalSecrets } from '@/lib/terminal/terminal-output-buffer';
import type { ErrorCategory } from '@/lib/error';

export interface DiagnosticBundleInput {
  version: string;
  platform: string;
  locale: string;
  featureState: {
    terminalSessions: number;
    sftpTabs: number;
    activeTransfers: number;
    aiConfigured: boolean;
  };
  selectedLog?: {
    name: string;
    source: 'frontend' | 'backend';
    content: string;
  };
  recentFailures?: Array<{
    operationId: string;
    kind: string;
    category: ErrorCategory;
  }>;
}

export interface DiagnosticBundle {
  schemaVersion: 1;
  generatedAt: string;
  application: {
    name: 'ShellSpan';
    version: string;
    platform: string;
    locale: string;
  };
  featureState: DiagnosticBundleInput['featureState'];
  recentFailures?: DiagnosticBundleInput['recentFailures'];
  selectedLog?: DiagnosticBundleInput['selectedLog'];
}

export function buildDiagnosticBundle(
  input: DiagnosticBundleInput,
  generatedAt = new Date().toISOString(),
): string {
  const bundle: DiagnosticBundle = {
    schemaVersion: 1,
    generatedAt,
    application: {
      name: 'ShellSpan',
      version: input.version,
      platform: input.platform,
      locale: input.locale,
    },
    featureState: { ...input.featureState },
    recentFailures: input.recentFailures?.map((failure) => ({ ...failure })),
    selectedLog: input.selectedLog
      ? {
          ...input.selectedLog,
          content: redactTerminalSecrets(input.selectedLog.content),
        }
      : undefined,
  };
  return JSON.stringify(bundle, null, 2);
}
