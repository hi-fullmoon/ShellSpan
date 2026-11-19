import { invokePrepareAgentImages, invokePreviewLocalFile } from '@/lib/ipc/tauri';
import type { AgentImageUpload } from '@/types/agent-image';
import { IMAGE_LIMITS } from './vision-contract';

const IMAGE_MIME_BY_EXTENSION = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'], ['gif', 'image/gif'],
]);

function localImageMime(path: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION.get(/\.([a-z]+)$/i.exec(path)?.[1].toLowerCase() ?? '');
}

export function isLocalImagePath(path: string): boolean {
  return localImageMime(path) !== undefined;
}

export async function readLocalImageFile(path: string): Promise<File> {
  const type = localImageMime(path);
  if (!type) throw new Error('IMAGE_MIME_MISMATCH');
  const preview = await invokePreviewLocalFile(path);
  if (preview.truncated || preview.contentEncoding !== 'base64') throw new Error('IMAGE_INVALID');
  const bytes = Uint8Array.from(atob(preview.content), character => character.charCodeAt(0));
  return new File([bytes], preview.name, { type });
}

export async function prepareImageFiles(
  files: readonly File[],
  isCurrent: () => boolean,
): Promise<AgentImageUpload[] | null> {
  if (files.some(file => file.size > IMAGE_LIMITS.maxSourceBytes)
    || files.reduce((sum, file) => sum + file.size, 0) > IMAGE_LIMITS.maxBatchBytes) {
    throw new Error('IMAGE_SOURCE_LIMIT');
  }
  const uploads: AgentImageUpload[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isCurrent()) return null;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    uploads.push({ mediaType: file.type, name: file.name, data: btoa(binary) });
  }
  return invokePrepareAgentImages(uploads);
}
