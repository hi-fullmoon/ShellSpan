import {
  ArchiveIcon,
  AudioLinesIcon,
  BinaryIcon,
  BracesIcon,
  FileCode2Icon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FilmIcon,
  Table2Icon,
  TypeIcon,
  type LucideIcon,
} from 'lucide-react';

export type SftpPreviewKind =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'font'
  | 'archive'
  | 'binary'
  | 'unavailable';

export interface SftpPreviewDescriptor {
  kind: SftpPreviewKind;
  mimeType: string;
  extension: string;
  icon: LucideIcon;
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  pdf: 'application/pdf',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip',
  tar: 'application/x-tar', bz2: 'application/x-bzip2', xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar']);
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf']);
const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'dart', 'go', 'graphql', 'h', 'hpp', 'html',
  'java', 'js', 'jsx', 'kt', 'kts', 'lua', 'php', 'py', 'rb', 'rs', 'scss',
  'sh', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml',
]);
const DATA_EXTENSIONS = new Set(['csv', 'json', 'jsonl', 'ndjson', 'toml', 'tsv']);
const TEXT_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  ...DATA_EXTENSIONS,
  'conf', 'config', 'env', 'gitignore', 'ini', 'log', 'md', 'properties',
  'readme', 'rst', 'text', 'txt',
]);

export function getFileExtension(name: string): string {
  const normalized = name.trim().toLowerCase();
  const lastSegment = normalized.split('/').pop() ?? normalized;
  if (!lastSegment.includes('.')) return lastSegment === 'readme' ? 'readme' : '';
  return lastSegment.slice(lastSegment.lastIndexOf('.') + 1);
}

export function getSftpPreviewDescriptor(
  name: string,
  contentEncoding: 'utf8' | 'base64' | 'none',
): SftpPreviewDescriptor {
  const extension = getFileExtension(name);
  if (contentEncoding === 'none') {
    return { kind: 'unavailable', mimeType: 'application/octet-stream', extension, icon: FileIcon };
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { kind: 'image', mimeType: MIME_TYPES[extension], extension, icon: FileImageIcon };
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    return { kind: 'audio', mimeType: MIME_TYPES[extension], extension, icon: AudioLinesIcon };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: 'video', mimeType: MIME_TYPES[extension], extension, icon: FilmIcon };
  }
  if (extension === 'pdf') {
    return { kind: 'pdf', mimeType: MIME_TYPES.pdf, extension, icon: FileTextIcon };
  }
  if (FONT_EXTENSIONS.has(extension)) {
    return { kind: 'font', mimeType: MIME_TYPES[extension], extension, icon: TypeIcon };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { kind: 'archive', mimeType: MIME_TYPES[extension], extension, icon: ArchiveIcon };
  }
  if (contentEncoding === 'utf8') {
    const icon = DATA_EXTENSIONS.has(extension)
      ? (extension === 'json' || extension === 'jsonl' ? BracesIcon : Table2Icon)
      : (CODE_EXTENSIONS.has(extension) ? FileCode2Icon : FileTextIcon);
    return { kind: 'text', mimeType: 'text/plain;charset=utf-8', extension, icon };
  }
  return {
    kind: 'binary',
    mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
    extension,
    icon: BinaryIcon,
  };
}

export function createPreviewDataUrl(content: string, mimeType: string): string {
  return `data:${mimeType};base64,${content}`;
}

export function formatHexPreview(content: string, byteLimit = 4096): string {
  if (!content) return '';
  const encodedLimit = Math.ceil(byteLimit / 3) * 4;
  const decoded = atob(content.slice(0, encodedLimit));
  const length = Math.min(decoded.length, byteLimit);
  const rows: string[] = [];
  for (let offset = 0; offset < length; offset += 16) {
    const bytes = Array.from(
      { length: Math.min(16, length - offset) },
      (_, index) => decoded.charCodeAt(offset + index),
    );
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = bytes
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
      .join('');
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii.padEnd(16)}|`);
  }
  return rows.join('\n');
}
