import { CircleAlertIcon, FileCheck2Icon, WrenchIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import type { LocaleKey } from '@/locales';
import type { AgentFinalReportV1 } from '@/types/agent';

export function AgentReport({
  report,
  onEvidenceNavigate,
}: {
  report: AgentFinalReportV1;
  onEvidenceNavigate: (evidenceId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCheck2Icon />
          {t('ai.dynamicAgent.report.title')}
        </CardTitle>
        <CardDescription>{report.summary}</CardDescription>
        <CardAction>
          <Badge variant={report.outcome === 'blocked' ? 'destructive' : 'default'}>
            {t(`ai.dynamicAgent.report.outcome.${report.outcome}` as LocaleKey)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {report.findings.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="agent-report-findings">
            <h3 id="agent-report-findings" className="text-xs font-medium text-muted-foreground">
              {t('ai.dynamicAgent.report.findings')}
            </h3>
            {report.findings.map((finding, index) => (
              <div key={`${finding.title}-${index}`}>
                {index > 0 && <Separator className="mb-2" />}
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{finding.title}</span>
                    <Badge variant={finding.confidence === 'verified'
                      ? 'default'
                      : finding.confidence === 'uncertain'
                        ? 'outline'
                        : 'secondary'}>
                      {t(`ai.dynamicAgent.report.confidence.${finding.confidence}` as LocaleKey)}
                    </Badge>
                    {finding.evidenceIds.length === 0 && (
                      <Badge variant="outline">{t('ai.dynamicAgent.report.hypothesis')}</Badge>
                    )}
                  </div>
                  <p className="text-sm leading-5 text-muted-foreground">{finding.detail}</p>
                  <div className="flex flex-wrap gap-1">
                    {finding.evidenceIds.map((evidenceId) => (
                      <Button
                        key={evidenceId}
                        variant="link"
                        size="xs"
                        className="px-0"
                        onClick={() => onEvidenceNavigate(evidenceId)}
                      >
                        {evidenceId}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}

        {report.warnings.length > 0 && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>{t('ai.dynamicAgent.report.warnings')}</AlertTitle>
            <AlertDescription>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {report.nextActions.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="agent-report-next-actions">
            <h3 id="agent-report-next-actions" className="text-xs font-medium text-muted-foreground">
              {t('ai.dynamicAgent.report.nextActions')}
            </h3>
            <ul className="flex flex-col gap-2">
              {report.nextActions.map((action, index) => (
                <li key={`${action.title}-${index}`} className="flex items-start gap-2">
                  <WrenchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-sm leading-5">{action.title}</span>
                  {action.requiresChange && (
                    <Badge variant="outline">{t('ai.dynamicAgent.report.requiresReview')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
