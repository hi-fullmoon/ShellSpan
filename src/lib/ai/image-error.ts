import type { LocaleKey } from '@/locales';

export function imageErrorKey(error: string): LocaleKey {
  if (error.includes('IMAGE_MODEL_UNSUPPORTED')) return 'ai.workspace.images.error.model';
  if (/IMAGE_(SOURCE|BATCH|COUNT|PIXEL|BASE64|REFERENCE).*LIMIT|IMAGE_SOURCE_LIMIT/.test(error)) return 'ai.workspace.images.error.limit';
  if (error.includes('IMAGE_COLOR_PROFILE')) return 'ai.workspace.images.error.color';
  if (error.includes('IMAGE_ANIMATION')) return 'ai.workspace.images.error.animation';
  if (/IMAGE_(REQUEST|TOKEN)_BUDGET/.test(error)) return 'ai.workspace.images.error.budget';
  if (error.includes('IMAGE_ALREADY_COMMITTED')) return 'ai.workspace.images.error.committed';
  if (error.includes('IMAGE_CANCELLED')) return 'ai.workspace.images.error.cancelled';
  if (/IMAGE_(BLOB|REFERENCE_NOT_IN_SESSION)/.test(error)) return 'ai.workspace.images.error.blob';
  if (/IMAGE_(INVALID|MIME|CONTAINER|NAME)/.test(error)) return 'ai.workspace.images.error.invalid';
  return 'ai.workspace.images.error.retry';
}
