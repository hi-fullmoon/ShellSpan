import React from 'react';
import {
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type CompactAlertDialogContentProps = React.ComponentProps<typeof AlertDialogContent>;

export const CompactAlertDialogContent: React.FC<CompactAlertDialogContentProps> = ({
  className,
  ...props
}) => (
  <AlertDialogContent
    className={cn(
      'flex max-h-[min(720px,calc(100vh-2rem))] w-[calc(100%-2rem)] min-w-0 max-w-sm flex-col gap-0 overflow-hidden border-app-border bg-app-surface p-0 sm:rounded-lg',
      className,
    )}
    {...props}
  />
);

export const CompactAlertDialogHeader: React.FC<React.ComponentProps<typeof AlertDialogHeader>> = ({
  className,
  ...props
}) => (
  <AlertDialogHeader
    className={cn(
      'shrink-0 place-items-start gap-1 border-b border-app-border/60 px-4 py-3 text-left',
      className,
    )}
    {...props}
  />
);

export const CompactAlertDialogTitle: React.FC<React.ComponentProps<typeof AlertDialogTitle>> = ({
  className,
  ...props
}) => (
  <AlertDialogTitle className={cn('text-sm leading-5', className)} {...props} />
);

export const CompactAlertDialogDescription: React.FC<React.ComponentProps<typeof AlertDialogDescription>> = ({
  className,
  ...props
}) => (
  <AlertDialogDescription
    className={cn('text-left leading-5', className)}
    {...props}
  />
);

export const CompactAlertDialogBody: React.FC<React.ComponentProps<'div'>> = ({
  className,
  ...props
}) => (
  <ScrollArea className="min-h-0 max-h-[min(540px,calc(100vh-12rem))]">
    <div
      className={cn('flex min-w-0 flex-col gap-3 px-4 py-3', className)}
      {...props}
    />
  </ScrollArea>
);

export const CompactAlertDialogFooter: React.FC<React.ComponentProps<typeof AlertDialogFooter>> = ({
  className,
  ...props
}) => (
  <AlertDialogFooter
    className={cn(
      'mx-0 mb-0 shrink-0 rounded-none px-4 pb-4 pt-1',
      className,
    )}
    {...props}
  />
);
