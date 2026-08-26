import { describe, expect, it, vi } from 'vitest';
import {
  createPreviewDataUrl,
  formatHexPreview,
  getFileExtension,
  getSftpPreviewDescriptor,
} from '@/lib/sftp-preview';

describe('SFTP preview helpers', () => {
  it.each([
    ['photo.PNG', 'base64', 'image', 'image/png'],
    ['recording.flac', 'base64', 'audio', 'audio/flac'],
    ['demo.webm', 'base64', 'video', 'video/webm'],
    ['manual.pdf', 'base64', 'pdf', 'application/pdf'],
    ['interface.woff2', 'base64', 'font', 'font/woff2'],
    ['guide.md', 'utf8', 'markdown', 'text/markdown;charset=utf-8'],
    ['servers.csv', 'utf8', 'data', 'text/plain;charset=utf-8'],
    ['legacy.doc', 'utf8', 'document', 'application/msword'],
    ['report.docx', 'base64', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['metrics.xlsx', 'base64', 'spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['review.pptx', 'base64', 'presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['source.tsx', 'utf8', 'text', 'text/plain;charset=utf-8'],
    ['backup.tar.gz', 'base64', 'archive', 'application/gzip'],
    ['program.bin', 'base64', 'binary', 'application/octet-stream'],
  ] as const)('classifies %s', (name, contentEncoding, kind, mimeType) => {
    const descriptor = getSftpPreviewDescriptor(name, contentEncoding);
    expect(descriptor.kind).toBe(kind);
    expect(descriptor.mimeType).toBe(mimeType);
  });

  it('prioritizes media extensions over UTF-8 detection for SVG', () => {
    expect(getSftpPreviewDescriptor('diagram.svg', 'utf8').kind).toBe('image');
  });

  it('uses the payload encoding instead of a text-like extension', () => {
    expect(getSftpPreviewDescriptor('legacy.txt', 'base64').kind).toBe('binary');
    expect(getSftpPreviewDescriptor('extensionless', 'utf8').kind).toBe('text');
  });

  it('marks unavailable content while preserving its extension', () => {
    expect(getSftpPreviewDescriptor('video.mp4', 'none')).toMatchObject({
      kind: 'unavailable',
      extension: 'mp4',
    });
  });

  it('extracts the final extension and creates a media data URL', () => {
    expect(getFileExtension('/var/cache/archive.tar.gz')).toBe('gz');
    expect(createPreviewDataUrl('YWJj', 'image/png')).toBe('data:image/png;base64,YWJj');
  });

  it('formats binary content into offset, hex, and ASCII columns', () => {
    const encoded = btoa('ABC\0');
    expect(formatHexPreview(encoded)).toContain('00000000  41 42 43 00');
    expect(formatHexPreview(encoded)).toContain('|ABC.');
  });

  it('only decodes the base64 prefix needed by the hex view', () => {
    const originalAtob = globalThis.atob;
    const atobSpy = vi.fn(originalAtob);
    vi.stubGlobal('atob', atobSpy);
    try {
      formatHexPreview(btoa('A'.repeat(12_000)), 48);
      expect(atobSpy).toHaveBeenCalledOnce();
      expect(atobSpy.mock.calls[0]?.[0]).toHaveLength(64);
    } finally {
      vi.stubGlobal('atob', originalAtob);
    }
  });
});
