import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  ListChecksIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import type { AgentPlanItemStatusV1, AgentPlanItemV1 } from '@/types/agent';

const statusIcon = {
  pending: CircleIcon,
  active: CircleDotIcon,
  completed: CheckCircle2Icon,
  skipped: CircleSlashIcon,
} satisfies Record<AgentPlanItemStatusV1, React.ComponentType>;

export function AgentPlan({ plan }: { plan: AgentPlanItemV1[] }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card size="sm" variant="outline">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecksIcon />
          {t('ai.dynamicAgent.plan.title')}
        </CardTitle>
        <CardDescription>
          {plan.length > 0
            ? `${plan.filter((item) => item.status === 'completed').length}/${plan.length}`
            : t('ai.dynamicAgent.plan.empty')}
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{plan.length}</Badge>
        </CardAction>
      </CardHeader>
      {plan.length > 0 && (
        <CardContent>
          <ol className="flex flex-col gap-2">
            {plan.map((item) => {
              const Icon = statusIcon[item.status];
              return (
                <li key={item.id} className="flex min-w-0 items-start gap-2">
                  <Badge
                    variant={item.status === 'active'
                      ? 'default'
                      : item.status === 'completed'
                        ? 'secondary'
                        : 'outline'}
                    aria-current={item.status === 'active' ? 'step' : undefined}
                  >
                    <Icon data-icon="inline-start" />
                    {t(`ai.dynamicAgent.plan.status.${item.status}` as LocaleKey)}
                  </Badge>
                  <span className="min-w-0 flex-1 text-sm leading-5">{item.title}</span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      )}
    </Card>
  );
}
