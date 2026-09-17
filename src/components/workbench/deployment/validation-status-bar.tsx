import React from 'react';
import { AlertTriangleIcon, CheckCircle2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';

export interface ValidationStatusBarProps {
  issueCount: number;
  semanticDirty: boolean;
  layoutDirty: boolean;
  selectedNodeName: string | null;
  onOpenIssues: () => void;
}

export const ValidationStatusBar: React.FC<ValidationStatusBarProps> = ({
  issueCount,
  semanticDirty,
  layoutDirty,
  selectedNodeName,
  onOpenIssues,
}) => {
  const { t } = useI18n();
  return (
    <footer
      className="flex min-h-9 shrink-0 flex-nowrap items-center gap-2 overflow-hidden border-t bg-muted/20 px-2"
      data-testid="deployment-validation-status"
      aria-label={t('deployment.editor.status.label')}
    >
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        onClick={onOpenIssues}
      >
        {issueCount > 0
          ? <AlertTriangleIcon data-icon="inline-start" />
          : <CheckCircle2Icon data-icon="inline-start" />}
        {issueCount > 0
          ? t('deployment.editor.issues', { count: issueCount })
          : t('deployment.editor.validation.ready')}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {semanticDirty && (
          <Badge variant="secondary" size="sm">
            {t('deployment.editor.status.semanticDirty')}
          </Badge>
        )}
        {layoutDirty && (
          <Badge variant="outline" size="sm">
            {t('deployment.editor.status.layoutDirty')}
          </Badge>
        )}
        {!semanticDirty && !layoutDirty && (
          <span className="truncate text-xs text-muted-foreground">
            {t('deployment.editor.status.saved')}
          </span>
        )}
      </div>
      {selectedNodeName && (
        <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">
          {t('deployment.editor.status.selected', { name: selectedNodeName })}
        </span>
      )}
    </footer>
  );
};
