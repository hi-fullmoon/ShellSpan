export type Platform = 'macos' | 'windows' | 'linux' | 'other';

export function getPlatform(): Platform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac') || platform.includes('darwin')) return 'macos';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return 'other';
}
