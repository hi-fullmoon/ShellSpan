import { CheckIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import type { AgentCallPreviewV3 } from '@/types/agent-v3';

interface AgentDiffApprovalProps {
  readonly preview: AgentCallPreviewV3;
  readonly disabled?: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}

export function AgentDiffApproval({
  preview,
  disabled = false,
  onApprove,
  onReject,
}: AgentDiffApprovalProps): React.ReactNode {
  if (preview.toolName !== 'apply_patch' || !preview.diff || !preview.path) return null;

  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle>Review exact file diff</CardTitle>
        <CardDescription className="break-all">{preview.path}</CardDescription>
        <CardAction>Native authorization required</CardAction>
      </CardHeader>
      <CardContent>
        <ScrollArea horizontal className="max-h-72 rounded-md bg-muted">
          <ScrollAreaContent>
            <pre className="min-w-max p-3 text-xs leading-relaxed text-foreground">{preview.diff}</pre>
          </ScrollAreaContent>
        </ScrollArea>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onReject}>
          <XIcon data-icon="inline-start" />
          Reject
        </Button>
        <Button size="sm" disabled={disabled} onClick={onApprove}>
          <CheckIcon data-icon="inline-start" />
          Continue to native approval
        </Button>
      </CardFooter>
    </Card>
  );
}
