import React, { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  CheckIcon,
  CopyIcon,
  FileArchiveIcon,
  FileWarningIcon,
  FolderIcon,
  WrapTextIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { formatSize } from '@/lib/sftp-utils';
import {
  parseArchiveEntries,
  parseDelimitedTable,
  parseJsonTable,
  parseOfficePreview,
  type SpreadsheetPreviewSheet,
  type TabularPreview,
} from '@/lib/sftp-rich-preview';
import { cn } from '@/lib/utils';

export const PlainTextPreview: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
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

  useEffect(() => {
    setWrap(false);
    setCopied(false);
  }, [content]);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied by the host WebView.
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b px-3">
        <span className="text-xs text-muted-foreground">{t('sftp.preview.lineCount', { count: lineCount })}</span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant={wrap ? 'secondary' : 'ghost'} size="icon" className="size-7" onClick={() => setWrap((value) => !value)} />}
            >
              <WrapTextIcon />
              <span className="sr-only">{t('sftp.preview.toggleWrap')}</span>
            </TooltipTrigger>
            <TooltipContent>{t('sftp.preview.toggleWrap')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => {
                    void handleCopy();
                  }}
                />
              }
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="sr-only">{t('sftp.preview.copyContent')}</span>
            </TooltipTrigger>
            <TooltipContent>{copied ? t('sftp.preview.copied') : t('sftp.preview.copyContent')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1" horizontal={!wrap} size="thin">
        <pre
          className={cn(
            'min-h-full p-4 font-mono text-xs leading-5 text-foreground selection:bg-primary/20',
            wrap ? 'whitespace-pre-wrap break-words' : 'w-max min-w-full whitespace-pre',
          )}
        >
          {content || t('sftp.preview.emptyFile')}
        </pre>
      </ScrollArea>
    </div>
  );
};

const PreviewTabs: React.FC<{
  preview: React.ReactNode;
  source: string;
  summary?: React.ReactNode;
}> = ({ preview, source, summary }) => {
  const { t } = useI18n();
  return (
    <Tabs defaultValue="preview" className="min-h-0 flex-1 gap-0">
      <div className="flex min-h-10 items-center gap-3 border-b px-3">
        <TabsList variant="line" className="h-8 p-0">
          <TabsTrigger value="preview">{t('sftp.preview.view.preview')}</TabsTrigger>
          <TabsTrigger value="source">{t('sftp.preview.view.source')}</TabsTrigger>
        </TabsList>
        {summary && <span className="ml-auto text-xs text-muted-foreground">{summary}</span>}
      </div>
      <TabsContent value="preview" className="min-h-0 flex flex-1 flex-col">{preview}</TabsContent>
      <TabsContent value="source" className="min-h-0 flex flex-1 flex-col"><PlainTextPreview content={source} /></TabsContent>
    </Tabs>
  );
};

export const MarkdownPreview: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const rendered = (
    <ScrollArea className="min-h-0 flex-1 bg-muted/25" size="thin">
      <article className="mx-auto flex max-w-3xl flex-col gap-4 px-8 py-7 text-sm leading-6">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">{children}</a>,
            blockquote: ({ children }) => <blockquote className="border-l-2 pl-4 text-muted-foreground">{children}</blockquote>,
            code: ({ children, className }) => <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}>{children}</code>,
            h1: ({ children }) => <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>,
            h2: ({ children }) => <h2 className="mt-2 text-xl font-semibold tracking-tight">{children}</h2>,
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
      </article>
    </ScrollArea>
  );
  return <PreviewTabs preview={rendered} source={content} />;
};

const DataTable: React.FC<{ data: TabularPreview }> = ({ data }) => {
  const { t } = useI18n();
  return (
    <ScrollArea className="min-h-0 flex-1" horizontal size="thin">
      <Table className="min-w-max text-xs">
        <TableHeader className="sticky top-0 bg-background">
          <TableRow>
            <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
            {data.columns.map((column, index) => <TableHead key={`${column}-${index}`}>{column}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              <TableCell className="text-right font-mono text-muted-foreground">{rowIndex + 1}</TableCell>
              {data.columns.map((_, columnIndex) => (
                <TableCell key={columnIndex} className="max-w-80 truncate font-mono" title={row[columnIndex]}>
                  {row[columnIndex]}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.omittedRows && <p className="p-3 text-xs text-muted-foreground">{t('sftp.preview.table.truncated')}</p>}
    </ScrollArea>
  );
};

export const StructuredDataPreview: React.FC<{ content: string; extension: string }> = ({ content, extension }) => {
  const { t } = useI18n();
  const data = useMemo(() => {
    if (extension === 'csv') return parseDelimitedTable(content, ',');
    if (extension === 'tsv') return parseDelimitedTable(content, '\t');
    if (extension === 'json' || extension === 'jsonl' || extension === 'ndjson') return parseJsonTable(content, extension);
    return undefined;
  }, [content, extension]);
  if (!data) return <PlainTextPreview content={content} />;
  return (
    <PreviewTabs
      preview={<DataTable data={data} />}
      source={content}
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <FileArchiveIcon className="size-4" />
        <span>{t('sftp.preview.archive.summary', { count: entries.length })}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1" size="thin">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>{t('sftp.preview.archive.name')}</TableHead>
              <TableHead className="w-32">{t('sftp.preview.archive.type')}</TableHead>
              <TableHead className="w-32 text-right">{t('sftp.preview.archive.size')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => (
              <TableRow key={`${entry.name}-${index}`}>
                <TableCell className="max-w-xl">
                  <span className="flex min-w-0 items-center gap-2">
                    {entry.isDirectory ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileArchiveIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate" title={entry.name}>{entry.name}</span>
                  </span>
                </TableCell>
                <TableCell>{entry.isDirectory ? t('sftp.preview.archive.folder') : t('sftp.preview.archive.file')}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">{entry.isDirectory ? '—' : formatSize(entry.size)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
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
      <div className="flex flex-1 items-center justify-center p-8">
        <Alert className="max-w-md">
          <FileWarningIcon />
          <AlertTitle>{t('sftp.preview.office.unavailableTitle')}</AlertTitle>
          <AlertDescription>{t('sftp.preview.office.unavailableDescription')}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (preview.kind === 'document') {
    return (
      <ScrollArea className="min-h-0 flex-1 bg-muted/35" size="thin">
        <article className="mx-auto my-6 flex min-h-[34rem] max-w-3xl flex-col gap-3 rounded-lg border bg-background px-12 py-10 shadow-sm">
          {preview.blocks.map((block, index) => block.kind === 'heading'
            ? <h2 key={index} className="mt-3 text-lg font-semibold tracking-tight first:mt-0">{block.text}</h2>
            : <p key={index} className="whitespace-pre-wrap text-sm leading-6">{block.text}</p>)}
        </article>
      </ScrollArea>
    );
  }
  if (preview.kind === 'spreadsheet') {
    return (
      <Tabs defaultValue="0" className="min-h-0 flex-1 gap-0">
        <div className="flex min-h-10 items-center border-b px-3">
          <TabsList variant="line" className="h-8 max-w-full justify-start overflow-x-auto p-0">
            {preview.sheets.map((sheet, index) => <TabsTrigger key={`${sheet.name}-${index}`} value={String(index)}>{sheet.name}</TabsTrigger>)}
          </TabsList>
        </div>
        {preview.sheets.map((sheet, index) => <TabsContent key={`${sheet.name}-${index}`} value={String(index)} className="min-h-0 flex flex-1 flex-col"><SpreadsheetSheet sheet={sheet} /></TabsContent>)}
      </Tabs>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1 bg-muted/35" size="thin">
      <div className="grid gap-5 p-6 md:grid-cols-2">
        {preview.slides.map((slide) => (
          <section key={slide.number} className="relative aspect-video overflow-hidden rounded-lg border bg-background p-7 shadow-sm">
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
    </ScrollArea>
  );
};
