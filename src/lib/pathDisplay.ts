const SOFT_WRAP = '\u200b';

export function addPathWrapOpportunities(path: string) {
  return path.replace(/[\\/]/g, (separator) => `${separator}${SOFT_WRAP}`);
}
