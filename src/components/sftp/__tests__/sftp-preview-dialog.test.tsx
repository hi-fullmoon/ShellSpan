import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { SftpPreviewDialog } from '../sftp-preview-dialog';
import type { ReadRemoteFileResponse } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      key === 'sftp.preview.lineCount' ? `${values?.count} lines` : key,
  }),
}));

const response = (overrides: Partial<ReadRemoteFileResponse> = {}): ReadRemoteFileResponse => ({
  path: '/srv/readme.txt',
  name: 'readme.txt',
  content: 'first\nsecond',
  size: 12,
  isText: true,
  contentEncoding: 'utf8',
  truncated: false,
  ...overrides,
});

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe('SftpPreviewDialog', () => {
  it('opens immediately with a loading state before remote content arrives', () => {
    render(
      <SftpPreviewDialog
        open
        target={{ path: '/srv/slow-video.mp4', name: 'slow-video.mp4', size: 4096 }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('slow-video.mp4')).toBeInTheDocument();
    expect(screen.getByText('/srv/slow-video.mp4')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('sftp.preview.loading');
    expect(screen.getByText('4.0 KB')).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('renders text metadata, line count, and external-open action', () => {
    const onOpenExternally = vi.fn();
    render(
      <SftpPreviewDialog
        open
        content={response()}
        onClose={vi.fn()}
        onOpenExternally={onOpenExternally}
      />,
    );

    expect(screen.getByText('readme.txt')).toBeInTheDocument();
    expect(screen.getByText('/srv/readme.txt')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();
    expect(document.querySelector('pre')).toHaveTextContent(/first\s+second/);
    const dialogHeader = document.querySelector('[data-slot="dialog-header"]');
    expect(dialogHeader?.nextElementSibling).not.toHaveClass('border-t');
    const metadataSeparator = document.querySelector(
      '[data-slot="separator"][data-orientation="vertical"]',
    );
    expect(metadataSeparator).toHaveClass('h-4', 'data-vertical:self-center');
    expect(metadataSeparator).not.toHaveClass('data-vertical:self-stretch');
    fireEvent.click(screen.getByRole('button', { name: 'sftp.preview.openExternally' }));
    expect(onOpenExternally).toHaveBeenCalledWith('/srv/readme.txt');
  });

  it('renders Markdown as a document with a source view', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({ name: 'guide.md', path: '/srv/guide.md', content: '# Deploy guide\n\nReady.' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Deploy guide' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'sftp.preview.view.preview' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'sftp.preview.view.source' })).toBeInTheDocument();
  });

  it('renders CSV files as a table', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({ name: 'hosts.csv', path: '/srv/hosts.csv', content: 'host,port\nweb-01,22\ndb-01,5432' })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'host' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'port' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'web-01' })).toBeInTheDocument();
  });

  it('renders a ZIP archive as a file listing', () => {
    const archive = zipSync({ 'logs/app.log': strToU8('ok') });
    render(
      <SftpPreviewDialog
        open
        content={response({
          name: 'bundle.zip',
          path: '/srv/bundle.zip',
          content: toBase64(archive),
          size: archive.length,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('logs/app.log')).toBeInTheDocument();
    expect(screen.queryByText('sftp.preview.archiveTitle')).not.toBeInTheDocument();
  });

  it('renders extracted legacy DOC text as a document instead of hexadecimal data', async () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          name: 'overtime.doc',
          path: '/srv/overtime.doc',
          content: 'Overtime request\nName\tAda\nApproved',
          size: 50 * 1024,
          isText: true,
          contentEncoding: 'utf8',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Overtime request' })).toBeInTheDocument();
    expect(await screen.findByText((_content, element) => element?.textContent === 'Name\tAda')).toHaveClass('whitespace-pre-wrap');
    expect(screen.queryByText('sftp.preview.binaryTitle')).not.toBeInTheDocument();
  });

  it('renders image data with the correct MIME type', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          path: '/srv/photo.png',
          name: 'photo.png',
          content: 'iVBORw0KGgo=',
          size: 8,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(screen.getByText('PNG')).toBeInTheDocument();
  });

  it('stretches PDF previews through the remaining dialog height', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          path: '/srv/manual.pdf',
          name: 'manual.pdf',
          content: 'JVBERi0xLjQ=',
          size: 8,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    const frame = screen.getByTitle('manual.pdf');
    expect(frame).toHaveClass('min-h-0', 'w-full', 'flex-1');
    expect(frame.parentElement).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden');
  });

  it('renders UTF-8 SVG content as an encoded image source', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          path: '/srv/icon.svg',
          name: 'icon.svg',
          content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          size: 48,
          isText: true,
          contentEncoding: 'utf8',
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('img', { name: 'icon.svg' }).getAttribute('src')).toMatch(
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
  });

  it('shows a useful state for oversized files', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          name: 'large.mp4',
          path: '/srv/large.mp4',
          content: '',
          size: 20 * 1024 * 1024,
          isText: false,
          contentEncoding: 'none',
          truncated: true,
        })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('sftp.preview.tooLargeTitle')).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('renders non-UTF-8 text-like files in the binary inspector', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          name: 'legacy.txt',
          content: btoa('\0ABC'),
          size: 4,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    const binaryTitle = screen.getByText('sftp.preview.binaryTitle');
    expect(binaryTitle).toBeInTheDocument();
    const binaryAlert = binaryTitle.closest('[data-slot="alert"]');
    expect(binaryAlert).toHaveClass(
      'm-3',
      'w-fit',
      'max-w-[calc(100%-1.5rem)]',
      'self-start',
    );
    expect(binaryAlert).not.toHaveClass('mb-0');
    expect(document.querySelector('pre')).toHaveTextContent('00 41 42 43');
  });

  it('labels truncated text as a partial preview', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({ truncated: true, size: 512 * 1024 })}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('sftp.preview.partial')).toBeInTheDocument();
    expect(document.querySelector('pre')).toHaveTextContent(/first\s+second/);
  });

  it('changes the image layout size instead of applying a transform when zooming', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          path: '/srv/photo.png',
          name: 'photo.png',
          content: 'iVBORw0KGgo=',
          size: 8,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    const image = screen.getByRole('img', { name: 'photo.png' });
    Object.defineProperties(image, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    fireEvent.load(image);
    fireEvent.click(screen.getByRole('button', { name: 'sftp.preview.zoomIn' }));
    expect(image).toHaveStyle({ width: '500px', height: '375px' });
    expect(image.style.transform).toBe('');
  });

  it('reserves the canvas padding when fitting an image at 100%', () => {
    render(
      <SftpPreviewDialog
        open
        content={response({
          path: '/srv/large-photo.png',
          name: 'large-photo.png',
          content: 'iVBORw0KGgo=',
          size: 8,
          isText: false,
          contentEncoding: 'base64',
        })}
        onClose={vi.fn()}
      />,
    );

    const image = screen.getByRole('img', { name: 'large-photo.png' });
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 500 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1000 },
      naturalHeight: { configurable: true, value: 800 },
    });

    fireEvent.load(image);

    expect(image.parentElement).toHaveClass('p-4');
    expect(image.parentElement).not.toHaveClass('p-8');
    expect(image).toHaveStyle({ width: '568px', height: '454px' });
  });
});
