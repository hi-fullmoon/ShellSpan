import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    const metadataSeparator = document.querySelector(
      '[data-slot="separator"][data-orientation="vertical"]',
    );
    expect(metadataSeparator).toHaveClass('h-4', 'data-vertical:self-center');
    expect(metadataSeparator).not.toHaveClass('data-vertical:self-stretch');
    fireEvent.click(screen.getByRole('button', { name: 'sftp.preview.openExternally' }));
    expect(onOpenExternally).toHaveBeenCalledWith('/srv/readme.txt');
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
    expect(binaryTitle.closest('[data-slot="alert"]')).toHaveClass(
      'w-fit',
      'max-w-[calc(100%-1.5rem)]',
      'self-start',
    );
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
});
