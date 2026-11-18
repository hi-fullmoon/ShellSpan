import React, { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  CheckIcon,
  CopyIcon,
  FileArchiveIcon,
  FolderIcon,
  WrapTextIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { formatSize } from '@/lib/sftp/sftp-utils';
import { getSftpCodeLanguage, highlightSftpCode } from '@/lib/sftp/sftp-code-highlight';
import {
  parseArchiveEntries,
  parseDelimitedTable,
  parseOfficePreview,
  type SpreadsheetPreviewSheet,
  type TabularPreview,
} from '@/lib/sftp/sftp-rich-preview';
import { cn } from '@/lib/utils';
import { SftpPreviewNotice, SftpPreviewPage, SftpPreviewScrollArea, SftpPreviewTable, SftpPreviewToolbar } from './sftp-preview-layout';

function TextPreviewLineCount({ content }: { content: string }) {
  const { t } = useI18n();
  const lineCount = useMemo(() => {
    if (!content) return 0;
    let count = 1;
    let index = content.indexOf('\n');
    while (index !== -1) {
      count += 1;
      index = content.indexOf('\n', index + 1);
    }
    return count;
  }, [content]);
  return <span className="min-w-0 truncate">{t('sftp.preview.lineCount', { count: lineCount })}</span>;
}

function TextPreviewActions({ content, wrap, onToggleWrap }: { content: string; wrap: boolean; onToggleWrap: () => void }) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<{ content: string }>();
  const copied = copy?.content === content;

  useEffect(() => {
    if (!copy) return;
    const timer = window.setTimeout(() => setCopy(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopy({ content });
    } catch {
      // Clipboard access can be denied by the host WebView.
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" className={cn(wrap && 'text-primary')} aria-pressed={wrap} onClick={onToggleWrap} />}
        >
          <WrapTextIcon />
          <span className="sr-only">{t('sftp.preview.toggleWrap')}</span>
        </TooltipTrigger>
        <TooltipContent>{t('sftp.preview.toggleWrap')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" onClick={() => void handleCopy()} />}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="sr-only">{t('sftp.preview.copyContent')}</span>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('sftp.preview.copied') : t('sftp.preview.copyContent')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function TextPreviewBody({ content, fileName, wrap }: { content: string; fileName?: string; wrap: boolean }) {
  const { t } = useI18n();
  const [highlighted, setHighlighted] = useState<{ content: string; fileName?: string; html: string | null }>();
  const language = getSftpCodeLanguage(fileName);
  const highlightedHtml = highlighted?.content === content && highlighted.fileName === fileName ? highlighted.html : null;

  useEffect(() => {
    const controller = new AbortController();
    void highlightSftpCode(content, fileName, controller.signal).then((html) => {
      if (!controller.signal.aborted) setHighlighted({ content, fileName, html });
    });
    return () => controller.abort();
  }, [content, fileName]);

  return (
    <SftpPreviewScrollArea className="bg-app-surface" horizontal={!wrap}>
      <pre
        className={cn(
          'min-h-full px-4 pb-4 font-mono text-[13px] leading-6 text-foreground selection:bg-primary/20 @min-xl/preview:px-6',
          wrap ? 'whitespace-pre-wrap break-words' : 'w-max min-w-full whitespace-pre',
        )}
      >
        {highlightedHtml !== null ? (
          // The worker returns only escaped highlight.js markup, never raw file HTML.
          <code className="sftp-source-code" data-language={language} data-highlighted="true" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <code className="sftp-source-code" data-language={language} data-highlighted="false">{content || t('sftp.preview.emptyFile')}</code>
        )}
      </pre>
    </SftpPreviewScrollArea>
  );
}

export const PlainTextPreview: React.FC<{ content: string; fileName?: string }> = ({ content, fileName }) => {
  const [wrap, setWrap] = useState(false);
  useEffect(() => setWrap(false), [content]);
  return (
    <>
      <SftpPreviewToolbar>
        <TextPreviewLineCount content={content} />
        <TextPreviewActions content={content} wrap={wrap} onToggleWrap={() => setWrap((value) => !value)} />
      </SftpPreviewToolbar>
      <TextPreviewBody content={content} fileName={fileName} wrap={wrap} />
    </>
  );
};

const PreviewTabs: React.FC<{
  preview: React.ReactNode;
  source: string;
  sourceFileName?: string;
  summary?: React.ReactNode;
}> = ({ preview, source, sourceFileName, summary }) => {
  const { t } = useI18n();
  const [showSource, setShowSource] = useState(false);
  const [wrap, setWrap] = useState(false);
  useEffect(() => setWrap(false), [source]);
  return (
    <Tabs
      defaultValue="preview"
      onValueChange={(value) => {
        setShowSource(value === 'source');
        setWrap(false);
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <SftpPreviewToolbar>
        <TabsList className="shrink-0">
          <TabsTrigger value="preview">{t('sftp.preview.view.preview')}</TabsTrigger>
          <TabsTrigger value="source">{t('sftp.preview.view.source')}</TabsTrigger>
        </TabsList>
        {showSource ? (
          <div className="flex min-w-0 items-center gap-2">
            <TextPreviewLineCount content={source} />
            <TextPreviewActions content={source} wrap={wrap} onToggleWrap={() => setWrap((value) => !value)} />
          </div>
        ) : summary && <span className="min-w-0 truncate">{summary}</span>}
      </SftpPreviewToolbar>
      <TabsContent value="preview" className="min-h-0 flex flex-1 flex-col">{preview}</TabsContent>
      <TabsContent value="source" className="min-h-0 flex flex-1 flex-col">
        <TextPreviewBody content={source} fileName={sourceFileName} wrap={wrap} />
      </TabsContent>
    </Tabs>
  );
};

export const MarkdownPreview: React.FC<{ content: string; fileName?: string }> = ({ content, fileName }) => {
  const { t } = useI18n();
  const rendered = (
    <SftpPreviewScrollArea>
      <SftpPreviewPage className="gap-4 text-sm leading-6 wrap-anywhere">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">{children}</a>,
            blockquote: ({ children }) => <blockquote className="border-l-2 pl-4 text-muted-foreground">{children}</blockquote>,
            code: ({ children, className }) => <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}>{children}</code>,
            h1: ({ children }) => <h1 className="text-2xl font-semibold tracking-tight @min-xl/preview:text-3xl">{children}</h1>,
            h2: ({ children }) => <h2 className="mt-3 text-xl font-semibold tracking-tight">{children}</h2>,
            h3: ({ children }) => <h3 className="mt-1 text-base font-semibold">{children}</h3>,
            hr: () => <Separator />,
            img: ({ alt }) => <span className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('sftp.preview.markdown.image', { name: alt || 'image' })}</span>,
            ol: ({ children }) => <ol className="flex list-decimal flex-col gap-1 pl-6">{children}</ol>,
            p: ({ children }) => <p>{children}</p>,
            pre: ({ children }) => <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-5 [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
            table: ({ children }) => <div className="overflow-x-auto rounded-lg border"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
            td: ({ children }) => <td className="border-t px-2 py-1.5 align-top">{children}</td>,
            th: ({ children }) => <th className="bg-muted px-2 py-1.5 font-medium">{children}</th>,
            ul: ({ children }) => <ul className="flex list-disc flex-col gap-1 pl-6">{children}</ul>,
          }}
        >
          {content}
        </Markdown>
      </SftpPreviewPage>
    </SftpPreviewScrollArea>
  );
  return <PreviewTabs preview={rendered} source={content} sourceFileName={fileName} />;
};

const DataTable: React.FC<{ data: TabularPreview }> = ({ data }) => {
  const { t } = useI18n();
  return (
    <SftpPreviewScrollArea className="bg-app-surface" horizontal>
      <SftpPreviewTable className="min-w-max">
        <TableHeader>
          <TableRow>
            <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
            {data.columns.map((column, index) => <TableHead key={`${column}-${index}`}>{column}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex} className="even:bg-muted/25">
              <TableCell className="text-right font-mono text-muted-foreground">{rowIndex + 1}</TableCell>
              {data.columns.map((_, columnIndex) => (
                <TableCell key={columnIndex} className="max-w-80 truncate font-mono" title={row[columnIndex]}>
                  {row[columnIndex]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </SftpPreviewTable>
      {data.omittedRows && <p className="p-3 text-xs text-muted-foreground">{t('sftp.preview.table.truncated')}</p>}
    </SftpPreviewScrollArea>
  );
};

export const StructuredDataPreview: React.FC<{ content: string; extension: string; fileName?: string }> = ({ content, extension, fileName }) => {
  const { t } = useI18n();
  const data = useMemo(() => {
    if (extension === 'csv') return parseDelimitedTable(content, ',');
    if (extension === 'tsv') return parseDelimitedTable(content, '\t');
    return undefined;
  }, [content, extension]);
  if (!data) return <PlainTextPreview content={content} fileName={fileName} />;
  return (
    <PreviewTabs
      preview={<DataTable data={data} />}
      source={content}
      sourceFileName={fileName}
      summary={t('sftp.preview.table.summary', { rows: data.rows.length, columns: data.columns.length })}
    />
  );
};

export const ArchivePreview: React.FC<{ content: string; extension: string; fallback: React.ReactNode }> = ({ content, extension, fallback }) => {
  const { t } = useI18n();
  const entries = useMemo(() => {
    try {
      return parseArchiveEntries(content, extension);
    } catch {
      return undefined;
    }
  }, [content, extension]);
  if (!entries) return <>{fallback}</>;
  return (
    <>
      <SftpPreviewToolbar>
        <span>{t('sftp.preview.archive.summary', { count: entries.length })}</span>
      </SftpPreviewToolbar>
      <SftpPreviewScrollArea className="bg-app-surface">
        <SftpPreviewTable className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead>{t('sftp.preview.archive.name')}</TableHead>
              <TableHead className="w-20 @min-xl/preview:w-32">{t('sftp.preview.archive.type')}</TableHead>
              <TableHead className="w-20 text-right @min-xl/preview:w-32">{t('sftp.preview.archive.size')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => (
              <TableRow key={`${entry.name}-${index}`} className="even:bg-muted/25">
                <TableCell className="max-w-xl">
                  <span className="flex min-w-0 items-center gap-1">
                    {entry.isDirectory ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileArchiveIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate" title={entry.name}>{entry.name}</span>
                  </span>
                </TableCell>
                <TableCell>{entry.isDirectory ? t('sftp.preview.archive.folder') : t('sftp.preview.archive.file')}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">{entry.isDirectory ? '—' : formatSize(entry.size)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </SftpPreviewTable>
      </SftpPreviewScrollArea>
    </>
  );
};

const SpreadsheetSheet: React.FC<{ sheet: SpreadsheetPreviewSheet }> = ({ sheet }) => (
  <DataTable data={{ columns: sheet.columns, rows: sheet.rows, omittedRows: sheet.omittedRows }} />
);

export const OfficeDocumentPreview: React.FC<{ content: string; extension: string }> = ({ content, extension }) => {
  const { t } = useI18n();
  const preview = useMemo(() => {
    try {
      return parseOfficePreview(content, extension);
    } catch {
      return undefined;
    }
  }, [content, extension]);
  if (!preview) {
    return (
      <SftpPreviewNotice
        title={t('sftp.preview.office.unavailableTitle')}
        description={t('sftp.preview.office.unavailableDescription')}
      />
    );
  }
  if (preview.kind === 'document') {
    return (
      <SftpPreviewScrollArea>
        <SftpPreviewPage className="min-h-[34rem] gap-3 wrap-anywhere">
          {preview.blocks.map((block, index) => block.kind === 'heading'
            ? <h2 key={index} className="mt-3 text-lg font-semibold tracking-tight first:mt-0">{block.text}</h2>
            : <p key={index} className="whitespace-pre-wrap text-sm leading-6">{block.text}</p>)}
        </SftpPreviewPage>
      </SftpPreviewScrollArea>
    );
  }
  if (preview.kind === 'spreadsheet') {
    return (
      <Tabs defaultValue="0" className="min-h-0 flex-1 gap-0">
        <SftpPreviewToolbar>
          <TabsList variant="line" className="h-8 max-w-full justify-start overflow-x-auto p-0">
            {preview.sheets.map((sheet, index) => <TabsTrigger key={`${sheet.name}-${index}`} value={String(index)}>{sheet.name}</TabsTrigger>)}
          </TabsList>
        </SftpPreviewToolbar>
        {preview.sheets.map((sheet, index) => <TabsContent key={`${sheet.name}-${index}`} value={String(index)} className="min-h-0 flex flex-1 flex-col"><SpreadsheetSheet sheet={sheet} /></TabsContent>)}
      </Tabs>
    );
  }
  return (
    <SftpPreviewScrollArea>
      <div className={cn(
        'mx-auto grid gap-3 px-4 pb-4 @min-xl/preview:px-8 @min-xl/preview:pb-8',
        preview.slides.length === 1 ? 'max-w-3xl' : 'max-w-6xl @min-3xl/preview:grid-cols-2',
      )}>
        {preview.slides.map((slide) => (
          <section key={slide.number} className="relative aspect-video overflow-hidden rounded-lg bg-app-surface p-4 shadow-card ring-1 ring-app-border/60 @min-xl/preview:p-6">
            <Badge variant="secondary" className="absolute bottom-2 right-2">{slide.number}</Badge>
            <div className="flex h-full flex-col justify-center gap-3 overflow-hidden">
              {slide.lines.length > 0 ? slide.lines.map((line, index) => index === 0
                ? <h2 key={index} className="line-clamp-2 text-xl font-semibold tracking-tight">{line}</h2>
                : <p key={index} className="line-clamp-3 text-sm text-muted-foreground">{line}</p>)
                : <p className="text-sm text-muted-foreground">{t('sftp.preview.presentation.emptySlide')}</p>}
            </div>
          </section>
        ))}
      </div>
    </SftpPreviewScrollArea>
  );
};
