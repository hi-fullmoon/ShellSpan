import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import { deploymentRuntimeKey, formatDeploymentBytes } from './runtime-utils';

export const ArtifactDrawer: React.FC = () => {
  const { t } = useI18n();
  const artifact = useDeploymentWorkflowRunStore((state) => state.artifact);
  const clearArtifact = useDeploymentWorkflowRunStore((state) => state.clearArtifact);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (artifact && !wasOpenRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    wasOpenRef.current = artifact !== null;
  }, [artifact]);

  return (
    <Drawer
      open={artifact !== null}
      onOpenChange={(open) => { if (!open) clearArtifact(); }}
      onOpenChangeComplete={(open) => { if (!open) returnFocusRef.current?.focus(); }}
    >
      <DrawerContent
        className="flex min-h-0 flex-col gap-0 overflow-hidden p-0"
        closeButtonClassName="top-2 right-4 size-8 [&_svg]:size-3.5"
        data-testid="deployment-artifact-drawer"
      >
        <DrawerHeader className="shrink-0 border-b p-4 pr-12">
          <DrawerTitle>{t('deployment.runtime.artifact.title')}</DrawerTitle>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          {artifact && (
            <div className="flex flex-col gap-4 px-4 pb-4">
              <section className="flex flex-col gap-2 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{artifact.manifest.artifactType}</h3>
                  <Badge variant="secondary">
                    {t('deployment.runtime.artifact.components', { count: artifact.componentCount })}
                  </Badge>
                </div>
                <dl className="grid gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.contentDigest')}</dt>
                    <dd><code className="break-all text-xs">{artifact.handle.contentDigest}</code></dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.manifestDigest')}</dt>
                    <dd><code className="break-all text-xs">{artifact.handle.manifestDigest}</code></dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.source')}</dt>
                    <dd>{artifact.manifest.source.revision}{artifact.manifest.source.dirty ? ` · ${t('deployment.runtime.dirty')}` : ''}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.producer')}</dt>
                    <dd>{artifact.manifest.producer.nodeType} v{artifact.manifest.producer.nodeTypeVersion}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.totalSize')}</dt>
                    <dd>{formatDeploymentBytes(artifact.totalSize)}</dd>
                  </div>
                </dl>
              </section>
              <Separator />
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t('deployment.runtime.artifact.manifest')}</h3>
                <div className="flex flex-col">
                  {artifact.manifest.components.map((component, index) => (
                    <React.Fragment key={component.name}>
                      {index > 0 && <Separator />}
                      <div className="flex min-w-0 flex-col gap-2 py-3">
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{component.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{component.mediaType}</div>
                          </div>
                          <Badge variant="outline">{component.role}</Badge>
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <code className="truncate text-xs text-muted-foreground">{component.digest}</code>
                          <span className="shrink-0 text-xs">{formatDeploymentBytes(component.size)}</span>
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </section>
              <Separator />
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{t('deployment.runtime.artifact.retention')}</h3>
                  <Badge variant={artifact.retention.protected ? 'default' : 'outline'}>
                    {artifact.retention.protected
                      ? t('deployment.runtime.artifact.protected')
                      : t('deployment.runtime.artifact.unprotected')}
                  </Badge>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.references')}</dt>
                    <dd>{t('deployment.runtime.artifact.referenceCount', { count: artifact.retention.referenceCount })}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('deployment.runtime.artifact.leases')}</dt>
                    <dd>{t('deployment.runtime.artifact.leaseCount', { count: artifact.retention.leaseCount })}</dd>
                  </div>
                </dl>
                <p className="text-sm text-muted-foreground">
                  {artifact.retention.currentRelease
                    ? t('deployment.runtime.version.current')
                    : artifact.retention.previousRelease
                      ? t('deployment.runtime.version.previous')
                      : t('deployment.runtime.artifact.notRelease')}
                </p>
                {artifact.references.map((reference, index) => (
                  <div
                    key={`${reference.referenceKind}-${reference.ownerId}-${index}`}
                    className="flex min-w-0 items-center justify-between gap-2 text-sm"
                  >
                    <span>{t(deploymentRuntimeKey(`deployment.runtime.artifact.reference.${reference.referenceKind}`))}</span>
                    <code className="truncate text-xs text-muted-foreground">{reference.ownerId}</code>
                  </div>
                ))}
              </section>
            </div>
          )}
        </ScrollArea>
        <DrawerFooter className="shrink-0 border-t p-4">
          <Button variant="outline" onClick={clearArtifact}>{t('common.close')}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};
