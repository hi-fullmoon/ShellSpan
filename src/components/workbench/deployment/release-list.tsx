import React from 'react';
import { ArchiveIcon, AlertTriangleIcon, RotateCcwIcon, ShieldCheckIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentWorkflowRecord } from '@/lib/deployment/types';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import {
  formatDeploymentDate,
  shortDeploymentDigest,
} from './runtime-utils';

export interface ReleaseListProps {
  workflow: DeploymentWorkflowRecord;
  admissionsEnabled?: boolean;
  onOpenApproval: (trigger?: HTMLElement | null) => void;
}

export const ReleaseList: React.FC<ReleaseListProps> = ({
  workflow,
  admissionsEnabled = true,
  onOpenApproval,
}) => {
  const { t } = useI18n();
  const state = useDeploymentWorkflowRunStore();
  const [rollbackOpen, setRollbackOpen] = React.useState(false);
  const [selectedReleaseId, setSelectedReleaseId] = React.useState('');
  const rollbackReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const rollbackable = state.releases.filter((release) => release.rollbackable);
  const options = rollbackable.map((release) => ({
    value: release.releaseId,
    label: `${release.releaseId} · ${shortDeploymentDigest(release.contentDigest)}`,
  }));
  const openRollback = (releaseId: string, trigger: HTMLElement): void => {
    rollbackReturnFocusRef.current = trigger;
    setSelectedReleaseId(releaseId);
    setRollbackOpen(true);
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col border"
      data-testid="deployment-versions-view"
    >
      <header className="shrink-0 border-b px-3 py-2.5">
        <h2 className="text-sm font-medium">{t('deployment.editor.tab.versions')}</h2>
        <p className="text-xs text-muted-foreground">{t('deployment.runtime.version.description')}</p>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {state.releases.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('deployment.runtime.version.release')}</TableHead>
                  <TableHead>{t('deployment.runtime.version.artifact')}</TableHead>
                  <TableHead>{t('deployment.runtime.version.activated')}</TableHead>
                  <TableHead className="text-right">{t('deployment.runtime.version.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.releases.map((release) => (
                  <TableRow key={`${release.position}-${release.releaseId}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{release.releaseId}</span>
                        <Badge variant={release.position === 'current' ? 'default' : 'secondary'}>
                          {release.position === 'current'
                            ? t('deployment.runtime.version.current')
                            : t('deployment.runtime.version.previous')}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-64">
                      <div className="truncate">{release.artifactType}</div>
                      <code className="block max-w-64 truncate text-xs text-muted-foreground">
                        {release.contentDigest}
                      </code>
                    </TableCell>
                    <TableCell>{formatDeploymentDate(release.activatedAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          disabled={state.loading || state.preparing || state.action !== null}
                          onClick={() => void state.inspectArtifact(release.artifactReference).catch(() => undefined)}
                          aria-label={t('deployment.runtime.artifact.open')}
                        >
                          <ArchiveIcon data-icon="inline-start" />
                        </Button>
                        {release.rollbackable && (
                          <Button
                            size="icon-sm"
                            disabled={!admissionsEnabled
                              || state.loading
                              || state.preparing
                              || state.action !== null}
                            onClick={(event) => openRollback(release.releaseId, event.currentTarget)}
                            aria-label={t('deployment.runtime.rollback.action')}
                            data-testid="deployment-open-rollback"
                          >
                            <RotateCcwIcon data-icon="inline-start" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<RotateCcwIcon />}
              title={t('deployment.runtime.version.empty')}
              description={t('deployment.runtime.version.emptyDescription')}
            />
          )}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t p-3">
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>{t('deployment.runtime.rollback.safetyTitle')}</AlertTitle>
          <AlertDescription>{t('deployment.runtime.rollback.safetyDescription')}</AlertDescription>
        </Alert>
      </div>

      <Dialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        onOpenChangeComplete={(nextOpen) => { if (!nextOpen) rollbackReturnFocusRef.current?.focus(); }}
      >
        <DialogContent
          className="flex h-[min(30rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0"
          data-testid="deployment-rollback-dialog"
        >
          <DialogHeader className="shrink-0 border-b p-4">
            <DialogTitle>{t('deployment.runtime.rollback.title')}</DialogTitle>
            <DialogDescription>{t('deployment.runtime.rollback.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="px-4 pb-4 pt-4">
              <Field>
                <FieldLabel htmlFor="deployment-rollback-release">
                  {t('deployment.runtime.rollback.release')}
                </FieldLabel>
                <Select
                  items={options}
                  value={selectedReleaseId}
                  onValueChange={(value) => setSelectedReleaseId(value ?? '')}
                >
                  <SelectTrigger id="deployment-rollback-release" autoFocus><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{t('deployment.runtime.rollback.releaseDescription')}</FieldDescription>
              </Field>
              <Alert variant="warning">
                <AlertTriangleIcon />
                <AlertTitle>{t('deployment.runtime.rollback.confirmTitle')}</AlertTitle>
                <AlertDescription>{t('deployment.runtime.rollback.confirmDescription')}</AlertDescription>
              </Alert>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 border-t p-4">
            <Button variant="outline" onClick={() => setRollbackOpen(false)}>{t('common.cancel')}</Button>
            <Button
              disabled={!selectedReleaseId
                || !admissionsEnabled
                || state.loading
                || state.preparing
                || state.action !== null}
              onClick={() => void state.prepare(workflow, selectedReleaseId)
                .then(() => {
                  const latest = useDeploymentWorkflowRunStore.getState();
                  if (latest.workflowId !== workflow.id
                    || latest.detail?.summary.workflowId !== workflow.id) return;
                  setRollbackOpen(false);
                  onOpenApproval(rollbackReturnFocusRef.current);
                })
                .catch(() => undefined)}
            >
              {state.preparing
                ? <Spinner data-icon="inline-start" />
                : <RotateCcwIcon data-icon="inline-start" />}
              {t('deployment.runtime.rollback.prepare')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
