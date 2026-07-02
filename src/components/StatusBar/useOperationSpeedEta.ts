import { useRef } from 'react';
import type { OperationItem } from '../../stores/operationStore';
import { t } from '../../lib/i18n';

const UNIT_MULTIPLIERS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

const SIZE_REGEX = /([\d.]+)\s*(B|KB|MB|GB|TB)/i;
const SAMPLE_WINDOW_MS = 10_000;
const MIN_SAMPLES = 2;

interface Sample {
  completedBytes: number;
  timestamp: number;
}

export interface SpeedEtaMetrics {
  speedText?: string;
  etaText?: string;
}

function parseSize(text: string): number | undefined {
  const match = text.match(SIZE_REGEX);
  if (!match) {
    return undefined;
  }

  const value = parseFloat(match[1]);
  if (Number.isNaN(value) || value < 0) {
    return undefined;
  }

  const unit = match[2].toUpperCase();
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (!multiplier) {
    return undefined;
  }

  return value * multiplier;
}

function parseByteRange(text: string): { completed: number; total: number } | undefined {
  const parts = text.split('/');
  if (parts.length !== 2) {
    return undefined;
  }

  const completed = parseSize(parts[0]);
  const total = parseSize(parts[1]);
  if (completed === undefined || total === undefined || total <= 0) {
    return undefined;
  }

  return { completed, total };
}

function formatSize(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatEta(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }

  if (seconds < 1) {
    return t('operationStatus.eta.lessThanSecond');
  }

  if (seconds < 60) {
    return t('operationStatus.eta.seconds', { count: Math.round(seconds) });
  }

  if (seconds < 3600) {
    return t('operationStatus.eta.minutes', { count: Math.round(seconds / 60) });
  }

  return t('operationStatus.eta.hours', { count: Math.round(seconds / 3600) });
}

function computeMetrics(samples: Sample[], totalBytes: number): SpeedEtaMetrics {
  if (samples.length < 2) {
    return {};
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const bytesDelta = last.completedBytes - first.completedBytes;
  const timeDelta = (last.timestamp - first.timestamp) / 1000;

  if (timeDelta <= 0 || bytesDelta <= 0) {
    return {};
  }

  const speed = bytesDelta / timeDelta;
  const remainingBytes = Math.max(0, totalBytes - last.completedBytes);
  const etaSeconds = remainingBytes / speed;

  return {
    speedText: t('operationStatus.speed.perSecond', { size: formatSize(speed) }),
    etaText: formatEta(etaSeconds),
  };
}

export function useOperationSpeedEta(operation: OperationItem): SpeedEtaMetrics {
  const samplesRef = useRef<Sample[]>([]);
  const lastOperationRef = useRef<{ progress: number; totalText?: string } | null>(null);
  const range = operation.totalText ? parseByteRange(operation.totalText) : undefined;

  if (!range) {
    samplesRef.current = [];
    lastOperationRef.current = null;
    return {};
  }

  const completedBytes = (operation.progress / 100) * range.total;
  const hasChanged =
    !lastOperationRef.current ||
    lastOperationRef.current.progress !== operation.progress ||
    lastOperationRef.current.totalText !== operation.totalText;

  if (hasChanged) {
    const now = Date.now();
    const nextSamples = [...samplesRef.current, { completedBytes, timestamp: now }];
    const recentSamples = nextSamples.filter(
      (sample) => now - sample.timestamp <= SAMPLE_WINDOW_MS,
    );
    samplesRef.current =
      recentSamples.length >= MIN_SAMPLES ? recentSamples : nextSamples.slice(-MIN_SAMPLES);
    lastOperationRef.current = { progress: operation.progress, totalText: operation.totalText };
  }

  return computeMetrics(samplesRef.current, range.total);
}

export { parseByteRange, formatSize as formatSpeedSize, formatEta };
