import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AiNoticeAction({ className, ...props }: Omit<ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return <Button type="button" variant="plain" size="xs" data-ai-notice-action=""
    className={cn('m-0 border-0 p-0 text-[11px] underline-offset-4 hover:underline focus-visible:underline', className)}
    {...props} />;
}
