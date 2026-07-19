import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, initGlobalErrorLogging } from '@/lib/logger';

describe('createLogger (non-Tauri fallback)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes each level to the matching console method with the module prefix', () => {
    const logger = createLogger('test');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(console.debug).toHaveBeenCalledWith('[test] d');
    expect(console.info).toHaveBeenCalledWith('[test] i');
    expect(console.warn).toHaveBeenCalledWith('[test] w');
    expect(console.error).toHaveBeenCalledWith('[test] e');
  });

  it('appends serialized details to the record', () => {
    const logger = createLogger('test');

    logger.info('listed', { path: '/tmp' }, 3);

    expect(console.info).toHaveBeenCalledWith('[test] listed {"path":"/tmp"} 3');
  });

  it('serializes Error details with message and stack', () => {
    const logger = createLogger('test');

    logger.error('failed', new Error('boom'));

    const record = vi.mocked(console.error).mock.calls[0]?.[0] as string;
    expect(record).toContain('[test] failed');
    expect(record).toContain('Error: boom');
  });

  it('does not throw on unserializable details', () => {
    const logger = createLogger('test');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logger.warn('circular', circular)).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('initGlobalErrorLogging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs unhandledrejection events without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    initGlobalErrorLogging();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('reject-boom') });

    expect(() => window.dispatchEvent(event)).not.toThrow();
    const record = vi.mocked(console.error).mock.calls[0]?.[0] as string;
    expect(record).toContain('[global]');
    expect(record).toContain('reject-boom');
  });
});
