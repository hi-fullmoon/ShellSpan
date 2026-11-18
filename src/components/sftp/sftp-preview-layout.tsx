import type { ComponentProps, ReactNode } from 'react';
import { FileWarningIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Table } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export const sftpPreviewContentClassName = 'min-h-0 flex-1';

export function SftpPreviewScrollArea({ className, size = 'thin', ...props }: ComponentProps<typeof ScrollArea>) {
  return <ScrollArea className={cn(sftpPreviewContentClassName, className)} size={size} {...props} />;
}

export function SftpPreviewToolbar({ children, size = 'default' }: { children: ReactNode; size?: 'default' | 'sm' }) {
  return (
    <div data-slot="sftp-preview-toolbar" className="shrink-0 bg-app-bg">
      <div className={cn(
        'flex min-w-0 items-center justify-between gap-3 px-4 text-xs text-muted-foreground @min-xl/preview:px-6',
        size === 'sm' ? 'min-h-9' : 'min-h-10',
      )}>
        {children}
      </div>
      <Separator className="border-app-border/65" />
    </div>
  );
}

export function SftpPreviewPage({ className, ...props }: ComponentProps<'article'>) {
  return (
    <div className="px-4 pt-2 pb-4 @min-xl/preview:px-8 @min-xl/preview:pb-8">
      <article
        data-slot="sftp-preview-page"
        className={cn('mx-auto flex max-w-3xl min-w-0 flex-col rounded-lg bg-app-surface p-5 shadow-card ring-1 ring-app-border/60 ring-inset @min-xl/preview:p-10', className)}
        {...props}
      />
    </div>
  );
}

export function SftpPreviewTable({ className, ...props }: ComponentProps<typeof Table>) {
  return (
    <Table
      containerClassName="overflow-visible"
      className={cn(
        'text-xs [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-bg [&_th]:h-8 [&_th]:px-4 [&_td]:px-4 [&_td]:py-1.5 [&_tr]:border-app-border/60',
        className,
      )}
      {...props}
    />
  );
}

export function SftpPreviewNotice({ title, description }: { title: string; description: string }) {
  return (
    <SftpPreviewScrollArea>
      <div className="flex min-h-full items-center justify-center px-4 pt-2 pb-4">
        <Alert className="max-w-md">
          <FileWarningIcon />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </Alert>
      </div>
    </SftpPreviewScrollArea>
  );
}
