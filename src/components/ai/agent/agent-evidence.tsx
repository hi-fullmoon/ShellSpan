import { DatabaseIcon, FileTerminalIcon, SearchCheckIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type { AgentEvidenceSourceV1, AgentEvidenceV1 } from '@/types/agent';

const sourceIcon = {
  terminalSnapshot: FileTerminalIcon,
  'host.inspect': SearchCheckIcon,
  'shell.execReadOnly': DatabaseIcon,
} satisfies Record<AgentEvidenceSourceV1, React.ComponentType>;

export function agentEvidenceElementId(runId: string, evidenceId: string): string {
  return `agent-evidence-${runId}-${evidenceId}`;
}

function sourceLabel(
  source: AgentEvidenceSourceV1,
): 'ai.dynamicAgent.evidence.source.terminalSnapshot'
  | 'ai.dynamicAgent.evidence.source.hostInspect'
  | 'ai.dynamicAgent.evidence.source.shellExec' {
  if (source === 'terminalSnapshot') return 'ai.dynamicAgent.evidence.source.terminalSnapshot';
  if (source === 'host.inspect') return 'ai.dynamicAgent.evidence.source.hostInspect';
  return 'ai.dynamicAgent.evidence.source.shellExec';
}

export function AgentEvidence({
  runId,
  evidence,
}: {
  runId: string;
  evidence: AgentEvidenceV1[];
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle>{t('ai.dynamicAgent.evidence.title')}</CardTitle>
        <CardDescription>
          {evidence.length === 0
            ? t('ai.dynamicAgent.evidence.empty')
            : evidence.map((item) => item.evidenceId).join(' · ')}
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{evidence.length}</Badge>
        </CardAction>
      </CardHeader>
      {evidence.length > 0 && (
        <CardContent className="flex flex-col">
          {evidence.map((item, index) => {
            const Icon = sourceIcon[item.source];
            return (
              <div key={item.evidenceId}>
                {index > 0 && <Separator className="my-2" />}
                <article
                  id={agentEvidenceElementId(runId, item.evidenceId)}
                  tabIndex={-1}
                  className="flex scroll-m-6 flex-col gap-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${t('ai.dynamicAgent.evidence.title')} ${item.evidenceId}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">
                      <Icon data-icon="inline-start" />
                      {t(sourceLabel(item.source))}
                    </Badge>
                    <Badge variant="outline">{item.evidenceId}</Badge>
                    {item.truncated && (
                      <Badge variant="destructive">{t('ai.dynamicAgent.tool.truncated')}</Badge>
                    )}
                  </div>
                  <p className="text-sm leading-5 text-foreground">{item.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('ai.dynamicAgent.evidence.observedAt', {
                      time: new Date(item.observedAt).toLocaleString(),
                    })}
                    {item.exitCode === undefined ? '' : ` · ${t('ai.dynamicAgent.tool.exitCode', { code: item.exitCode })}`}
                  </p>
                </article>
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}
