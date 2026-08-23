import { generateId } from '@/lib/utils';

const OPERATION_ID_KEYS = ['operationId', 'requestId'] as const;

export function createOperationId(kind: string): string {
  const safeKind = kind.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safeKind || 'operation'}-${generateId()}`;
}

export function findOperationId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 2) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of OPERATION_ID_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
      return candidate;
    }
  }
  for (const nestedKey of ['request', 'config']) {
    const nested = findOperationId(record[nestedKey], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}
