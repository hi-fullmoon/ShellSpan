import React from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudUploadIcon,
  LibraryIcon,
  ListTreeIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  Trash2Icon,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { EmptyState, PanelLoadingState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/hooks/useI18n';
import {
  compatibleOutputBindings,
  projectDeploymentEdges,
  topologyOrder,
  type DeploymentEditorIssue,
  type DeploymentWorkflowTemplateKind,
} from '@/lib/deployment/editor';
import type {
  DeploymentJsonValue,
  DeploymentNodeConfigFieldSpec,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowNode,
  DeploymentWorkflowRecord,
} from '@/lib/deployment/types';
import type { LocaleKey } from '@/locales';
import { useProfileStore } from '@/stores/profileStore';
import {
  useDeploymentWorkflowStore,
  type DeploymentWorkflowDraft,
} from '@/stores/deploymentWorkflowStore';
import { useToastStore } from '@/stores/toastStore';
import { useDeploymentWorkflowRunStore } from '@/stores/deploymentWorkflowRunStore';
import {
  DeploymentWorkflowRuntimeOverlays,
  DeploymentWorkflowRuntimeView,
} from './deployment-workflow-runtime';
import { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader, WorkbenchSearchInput } from './workbench-page';

type Translate = (key: LocaleKey, values?: Record<string, string | number>) => string;

const NONE_VALUE = '__none__';
const NODE_WIDTH = 240;
const NODE_HEIGHT = 132;

function dynamicKey(value: string): LocaleKey {
  return value as LocaleKey;
}

function readableProfile(profile: { name: string; username: string; host: string }): string {
  return `${profile.name} · ${profile.username}@${profile.host}`;
}

function nodeSpec(
  catalog: DeploymentNodeTypeCatalog | null,
  node: DeploymentWorkflowNode,
): DeploymentNodeTypeSpec | undefined {
  return catalog?.nodes.find(
    (item) => item.typeName === node.type && item.typeVersion === node.typeVersion,
  );
}

function portLabel(name: string, t: Translate): string {
  return t(dynamicKey(`deployment.editor.port.${name}`));
}

function portTypeLabel(value: string, t: Translate): string {
  return t(dynamicKey(`deployment.editor.portType.${value}`));
}

function issueLabel(issue: DeploymentEditorIssue, t: Translate): string {
  return t(issue.messageKey);
}

function localizedEditorError(error: string, t: Translate): string {
  if (error.includes('REVISION_CONFLICT')) return t('deployment.editor.error.revisionConflict');
  if (error.includes('DEPLOYMENT_WORKFLOW_DISABLED')) return t('deployment.editor.error.disabled');
  if (error.includes('PROFILE_NOT_FOUND')) return t('deployment.editor.error.profileMissing');
  return t('deployment.editor.error.generic');
}

interface TemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TemplateDialog: React.FC<TemplateDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const startTemplate = useDeploymentWorkflowStore((state) => state.startTemplate);
  const [kind, setKind] = React.useState<DeploymentWorkflowTemplateKind>('staticSite');
  const [name, setName] = React.useState('');
  const [profileId, setProfileId] = React.useState('');
  const [remoteRoot, setRemoteRoot] = React.useState('/srv/apps/example');
  const templateOptions = React.useMemo(() => [
    { value: 'staticSite', label: t('deployment.editor.template.staticSite') },
    { value: 'dockerCompose', label: t('deployment.editor.template.dockerCompose') },
    { value: 'prebuiltFiles', label: t('deployment.editor.template.prebuiltFiles') },
    { value: 'blank', label: t('deployment.editor.template.blank') },
  ], [t]);
  const profileOptions = React.useMemo(() => profiles.map((profile) => ({
    value: profile.id,
    label: readableProfile(profile),
  })), [profiles]);

  React.useEffect(() => {
    if (!open) return;
    setKind('staticSite');
    setName('');
    setProfileId(profiles[0]?.id ?? '');
    setRemoteRoot('/srv/apps/example');
  }, [open, profiles]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || !profileId || !remoteRoot.startsWith('/') || remoteRoot === '/') return;
    startTemplate(kind, name.trim(), profileId, remoteRoot.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(40rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 p-4">
          <DialogTitle>{t('deployment.editor.template.title')}</DialogTitle>
          <DialogDescription>{t('deployment.editor.template.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submit}>
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="px-4 pb-4">
              <Field>
                <FieldLabel htmlFor="deployment-template">{t('deployment.editor.template.kind')}</FieldLabel>
                <Select
                  items={templateOptions}
                  value={kind}
                  onValueChange={(value) => setKind((value ?? 'staticSite') as DeploymentWorkflowTemplateKind)}
                >
                  <SelectTrigger id="deployment-template">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {templateOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {t(dynamicKey(`deployment.editor.template.${kind}Description`))}
                  {kind === 'prebuiltFiles' ? ` · ${t('deployment.editor.template.beta')}` : ''}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="deployment-name">{t('deployment.editor.workflowName')}</FieldLabel>
                <Input
                  id="deployment-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoFocus
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="deployment-profile">{t('deployment.editor.targetProfile')}</FieldLabel>
                <Select items={profileOptions} value={profileId} onValueChange={(value) => setProfileId(value ?? '')}>
                  <SelectTrigger id="deployment-profile"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {profileOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="deployment-root">{t('deployment.editor.remoteRoot')}</FieldLabel>
                <Input
                  id="deployment-root"
                  value={remoteRoot}
                  onChange={(event) => setRemoteRoot(event.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
          </ScrollArea>
          <DialogFooter className="shrink-0 border-t p-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!name.trim() || !profileId || !remoteRoot.startsWith('/') || remoteRoot === '/'}>
              <PlusIcon data-icon="inline-start" />
              {t('deployment.editor.template.use')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface WorkflowListProps {
  workflows: readonly DeploymentWorkflowRecord[];
  selectedWorkflowId: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

const WorkflowListCard: React.FC<WorkflowListProps> = ({
  workflows,
  selectedWorkflowId,
  search,
  onSearchChange,
  onSelect,
  onCreate,
}) => {
  const { t } = useI18n();
  const visible = workflows.filter((workflow) => workflow.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <Card className="min-h-0 flex-1" size="sm" variant="outline" radius="compact" data-testid="deployment-workflow-list">
      <CardHeader>
        <CardTitle>{t('deployment.editor.workflows')}</CardTitle>
        <CardDescription>{t('deployment.editor.workflowCount', { count: workflows.length })}</CardDescription>
        <CardAction>
          <Button size="icon-sm" variant="ghost" onClick={onCreate} aria-label={t('deployment.editor.template.title')}>
            <PlusIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-0">
        <div className="px-3">
          <WorkbenchSearchInput
            containerClassName="min-w-0 w-full flex-1"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('deployment.editor.search')}
            aria-label={t('deployment.editor.search')}
            onClear={() => onSearchChange('')}
            clearLabel={t('common.clear')}
          />
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 px-2 pb-2">
            {visible.map((workflow) => (
              <Button
                key={workflow.id}
                variant={workflow.id === selectedWorkflowId ? 'secondary' : 'ghost'}
                className="h-auto min-w-0 justify-start py-2"
                onClick={() => onSelect(workflow.id)}
              >
                <span className="min-w-0 flex-1 truncate text-left">{workflow.name}</span>
                <Badge variant="outline">{t('deployment.editor.revision', { revision: workflow.revision })}</Badge>
              </Button>
            ))}
            {visible.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('deployment.editor.noSearchResults')}</p>}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

interface NodeLibraryProps {
  catalog: DeploymentNodeTypeCatalog;
  onAdd: (spec: DeploymentNodeTypeSpec) => void;
}

const NodeLibraryCard: React.FC<NodeLibraryProps> = ({ catalog, onAdd }) => {
  const { t } = useI18n();
  return (
    <Card className="min-h-0 flex-1" size="sm" variant="outline" radius="compact" data-testid="deployment-node-library">
      <CardHeader>
        <CardTitle>{t('deployment.editor.nodeLibrary')}</CardTitle>
        <CardDescription>{t('deployment.editor.nodeLibraryDescription')}</CardDescription>
        <CardAction><Badge variant="secondary">{catalog.nodes.length}</Badge></CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-2 px-3 pb-3">
            {catalog.nodes.map((spec) => (
              <Card key={`${spec.typeName}@${spec.typeVersion}`} size="sm" variant="outline" radius="compact">
                <CardHeader>
                  <CardTitle>{t(dynamicKey(spec.displayNameKey))}</CardTitle>
                  <CardDescription>{t(dynamicKey(spec.descriptionKey))}</CardDescription>
                  <CardAction>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => onAdd(spec)}
                      aria-label={t('deployment.editor.addNodeNamed', { name: t(dynamicKey(spec.displayNameKey)) })}
                    >
                      <PlusIcon />
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

interface NodeInputFieldsProps {
  node: DeploymentWorkflowNode;
  spec: DeploymentNodeTypeSpec;
  definition: DeploymentWorkflowDefinition;
  catalog: DeploymentNodeTypeCatalog;
}

const NodeInputFields: React.FC<NodeInputFieldsProps> = ({ node, spec, definition, catalog }) => {
  const { t } = useI18n();
  const connectInput = useDeploymentWorkflowStore((state) => state.connectInput);
  if (spec.inputs.length === 0) return null;
  return (
    <FieldGroup>
      {spec.inputs.map((input) => {
        const compatible = compatibleOutputBindings(definition, catalog, node.id, input.name);
        const options = [
          { value: NONE_VALUE, label: t('deployment.editor.connection.none') },
          ...compatible.map((candidate) => ({
            value: `${candidate.binding.fromNodeId}|${candidate.binding.fromPort}`,
            label: `${candidate.node.displayName} · ${portLabel(candidate.port.name, t)}`,
          })),
        ];
        const binding = node.inputs[input.name];
        const value = binding ? `${binding.fromNodeId}|${binding.fromPort}` : NONE_VALUE;
        return (
          <Field key={input.name} data-invalid={input.required && !binding}>
            <FieldLabel htmlFor={`input-${node.id}-${input.name}`}>{portLabel(input.name, t)}</FieldLabel>
            <Select
              items={options}
              value={value}
              onValueChange={(next) => {
                if (!next || next === NONE_VALUE) {
                  connectInput(node.id, input.name, null);
                  return;
                }
                const [fromNodeId, fromPort] = next.split('|');
                if (fromNodeId && fromPort) connectInput(node.id, input.name, { fromNodeId, fromPort });
              }}
            >
              <SelectTrigger id={`input-${node.id}-${input.name}`} aria-invalid={input.required && !binding}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{t('deployment.editor.connection.type', { type: portTypeLabel(input.portType, t) })}</FieldDescription>
          </Field>
        );
      })}
    </FieldGroup>
  );
};

function listValue(value: DeploymentJsonValue | undefined): string {
  return Array.isArray(value) ? value.map(String).join('\n') : '';
}

interface ConfigFieldControlProps {
  node: DeploymentWorkflowNode;
  field: DeploymentNodeConfigFieldSpec;
  definition: DeploymentWorkflowDefinition;
}

const ConfigFieldControl: React.FC<ConfigFieldControlProps> = ({ node, field, definition }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const update = useDeploymentWorkflowStore((state) => state.updateNodeConfig);
  const value = node.config[field.name];
  const id = `config-${node.id}-${field.name}`;
  if (field.name === 'targetId') {
    const options = definition.targets.map((target) => {
      const profile = profiles.find((item) => item.id === target.connectionProfileId);
      return {
        value: target.id,
        label: profile ? `${readableProfile(profile)} · ${target.remoteRoot}` : target.remoteRoot,
      };
    });
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(dynamicKey(field.labelKey))}</FieldLabel>
        <Select items={options} value={String(value ?? '')} onValueChange={(next) => update(node.id, field.name, next ?? '')}>
          <SelectTrigger id={id}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <FieldDescription>{t(dynamicKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }
  if (field.kind === 'select') {
    const options = (field.options ?? []).map((option) => ({
      value: option.value,
      label: t(dynamicKey(option.labelKey)),
    }));
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(dynamicKey(field.labelKey))}</FieldLabel>
        <Select items={options} value={String(value ?? '')} onValueChange={(next) => update(node.id, field.name, next ?? '')}>
          <SelectTrigger id={id}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
        <FieldDescription>{t(dynamicKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }
  if (field.kind === 'boolean') {
    return (
      <Field className="flex-row items-start gap-2">
        <Checkbox id={id} checked={value === true} onCheckedChange={(checked) => update(node.id, field.name, checked)} />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={id}>{t(dynamicKey(field.labelKey))}</FieldLabel>
          <FieldDescription>{t(dynamicKey(field.descriptionKey))}</FieldDescription>
        </div>
      </Field>
    );
  }
  if (field.kind === 'stringList' || field.kind === 'integerList') {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(dynamicKey(field.labelKey))}</FieldLabel>
        <Textarea
          id={id}
          value={listValue(value)}
          rows={3}
          onChange={(event) => {
            const entries = event.target.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
            update(node.id, field.name, field.kind === 'integerList' ? entries.map(Number).filter(Number.isInteger) : entries);
          }}
        />
        <FieldDescription>{t(dynamicKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(dynamicKey(field.labelKey))}</FieldLabel>
      <Input
        id={id}
        type={field.kind === 'integer' ? 'number' : 'text'}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        onChange={(event) => update(
          node.id,
          field.name,
          field.kind === 'integer' ? Number(event.target.value) : event.target.value,
        )}
      />
      <FieldDescription>{t(dynamicKey(field.descriptionKey))}</FieldDescription>
    </Field>
  );
};

interface NodeConfigurationProps {
  draft: DeploymentWorkflowDraft;
  node: DeploymentWorkflowNode | null;
  catalog: DeploymentNodeTypeCatalog;
}

const NodeConfiguration: React.FC<NodeConfigurationProps> = ({ draft, node, catalog }) => {
  const { t } = useI18n();
  const updateNode = useDeploymentWorkflowStore((state) => state.updateNode);
  const removeNode = useDeploymentWorkflowStore((state) => state.removeNode);
  if (!node) {
    return (
      <EmptyState
        className="min-h-64"
        icon={<Settings2Icon />}
        title={t('deployment.editor.config.empty')}
        description={t('deployment.editor.config.emptyDescription')}
      />
    );
  }
  const spec = nodeSpec(catalog, node);
  if (!spec) return null;
  return (
    <Card className="min-h-0 flex-1" size="sm" variant="outline" radius="compact" data-testid="deployment-node-config">
      <CardHeader className="shrink-0">
        <CardTitle>{node.displayName}</CardTitle>
        <CardDescription>{t(dynamicKey(spec.descriptionKey))}</CardDescription>
        <CardAction>
          <Button size="icon-sm" variant="ghost" onClick={() => removeNode(node.id)} aria-label={t('deployment.editor.removeNode')}>
            <Trash2Icon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <FieldGroup className="px-3 pb-3">
            <Field>
              <FieldLabel htmlFor={`node-name-${node.id}`}>{t('deployment.editor.nodeName')}</FieldLabel>
              <Input id={`node-name-${node.id}`} value={node.displayName} onChange={(event) => updateNode(node.id, { displayName: event.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">{t(dynamicKey(`deployment.editor.effect.${spec.effectClass}`))}</Badge>
              <Badge variant="outline">{t(dynamicKey(`deployment.editor.risk.${spec.riskLevel}`))}</Badge>
              <Badge variant="outline">{t(dynamicKey(`deployment.editor.domain.${spec.executionDomain}`))}</Badge>
            </div>
            <Field>
              <FieldLabel htmlFor={`node-timeout-${node.id}`}>{t('deployment.editor.timeout')}</FieldLabel>
              <Input
                id={`node-timeout-${node.id}`}
                type="number"
                min={1}
                max={86_400}
                value={node.timeoutSeconds}
                onChange={(event) => updateNode(node.id, { timeoutSeconds: Number(event.target.value) })}
              />
            </Field>
            <NodeInputFields node={node} spec={spec} definition={draft.definition} catalog={catalog} />
            {spec.configSchema.fields.map((field) => (
              <ConfigFieldControl key={field.name} node={node} field={field} definition={draft.definition} />
            ))}
            {spec.capabilities.length > 0 && (
              <Field>
                <FieldLabel>{t('deployment.editor.capabilities')}</FieldLabel>
                <div className="flex flex-wrap gap-1">
                  {spec.capabilities.map((capability) => (
                    <Badge key={capability} variant="secondary">{t(dynamicKey(`deployment.editor.capability.${capability}`))}</Badge>
                  ))}
                </div>
              </Field>
            )}
          </FieldGroup>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

interface CanvasProps {
  draft: DeploymentWorkflowDraft;
  catalog: DeploymentNodeTypeCatalog;
  selectedNodeId: string | null;
}

const WorkflowCanvas: React.FC<CanvasProps> = ({ draft, catalog, selectedNodeId }) => {
  const { t } = useI18n();
  const selectNode = useDeploymentWorkflowStore((state) => state.selectNode);
  const moveNode = useDeploymentWorkflowStore((state) => state.moveNode);
  const edges = projectDeploymentEdges(draft.definition);
  const positions = draft.layout.nodes;
  const width = Math.max(1_120, ...draft.definition.nodes.map((node) => (positions[node.id]?.x ?? 0) + NODE_WIDTH + 80));
  const height = Math.max(560, ...draft.definition.nodes.map((node) => (positions[node.id]?.y ?? 0) + NODE_HEIGHT + 80));
  const dragRef = React.useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  return (
    <ScrollArea
      className="h-full min-w-0 max-w-full"
      horizontal
      data-testid="deployment-workflow-canvas"
    >
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          {edges.map((edge) => {
            const source = positions[edge.sourceNodeId] ?? { x: 0, y: 0 };
            const target = positions[edge.targetNodeId] ?? { x: 0, y: 0 };
            const x1 = source.x + NODE_WIDTH;
            const y1 = source.y + NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + NODE_HEIGHT / 2;
            return <path key={edge.id} d={`M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`} fill="none" stroke="currentColor" className="text-border" />;
          })}
        </svg>
        {draft.definition.nodes.map((workflowNode) => {
          const spec = nodeSpec(catalog, workflowNode);
          const position = positions[workflowNode.id] ?? { x: 0, y: 0 };
          return (
            <Card
              key={workflowNode.id}
              size="sm"
              variant="outline"
              radius="compact"
              role="button"
              tabIndex={0}
              data-node-id={workflowNode.id}
              aria-label={t('deployment.editor.selectNodeNamed', { name: workflowNode.displayName })}
              className="absolute cursor-grab select-none"
              style={{ width: NODE_WIDTH, left: position.x, top: position.y }}
              onClick={() => selectNode(workflowNode.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectNode(workflowNode.id);
                }
                if (!event.altKey) return;
                const delta = event.shiftKey ? 40 : 12;
                if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
                if (event.key === 'ArrowLeft') moveNode(workflowNode.id, position.x - delta, position.y);
                if (event.key === 'ArrowRight') moveNode(workflowNode.id, position.x + delta, position.y);
                if (event.key === 'ArrowUp') moveNode(workflowNode.id, position.x, position.y - delta);
                if (event.key === 'ArrowDown') moveNode(workflowNode.id, position.x, position.y + delta);
              }}
              onPointerDown={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('button')) return;
                dragRef.current = { id: workflowNode.id, offsetX: event.clientX - position.x, offsetY: event.clientY - position.y };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (drag?.id !== workflowNode.id || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                moveNode(workflowNode.id, Math.max(0, event.clientX - drag.offsetX), Math.max(0, event.clientY - drag.offsetY));
              }}
              onPointerUp={() => { dragRef.current = null; }}
            >
              <CardHeader>
                <CardTitle className="truncate">{workflowNode.displayName}</CardTitle>
                <CardDescription>{spec ? t(dynamicKey(`deployment.editor.effect.${spec.effectClass}`)) : workflowNode.type}</CardDescription>
                <CardAction className="flex gap-1">
                  {selectedNodeId === workflowNode.id && <Badge>{t('deployment.editor.selected')}</Badge>}
                  <Badge variant="outline">v{workflowNode.typeVersion}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex items-start justify-between gap-2 text-xs">
                <div className="flex flex-col gap-1">
                  {(spec?.inputs ?? []).map((input) => <span key={input.name}>← {portLabel(input.name, t)}</span>)}
                </div>
                <div className="flex flex-col gap-1 text-right">
                  {(spec?.outputs ?? []).map((output) => <span key={output.name}>{portLabel(output.name, t)} →</span>)}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </ScrollArea>
  );
};

interface IssueListProps {
  issues: readonly DeploymentEditorIssue[];
  onSelectNode: (id: string) => void;
  nodeName: (id: string) => string;
}

const IssueList: React.FC<IssueListProps> = ({ issues, onSelectNode, nodeName }) => {
  const { t } = useI18n();
  if (issues.length === 0) {
    return (
      <Alert>
        <CheckCircle2Icon />
        <AlertTitle>{t('deployment.editor.validation.ready')}</AlertTitle>
        <AlertDescription>{t('deployment.editor.validation.readyDescription')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="deployment-validation-list">
      {issues.map((issue) => (
        <Alert key={issue.id} variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>{issueLabel(issue, t)}</AlertTitle>
          <AlertDescription>{issue.nodeId ? t('deployment.editor.validation.nodeContext', { node: nodeName(issue.nodeId) }) : t('deployment.editor.validation.workflowContext')}</AlertDescription>
          {issue.nodeId && (
            <AlertAction>
            <Button variant="outline" size="sm" onClick={() => onSelectNode(issue.nodeId!)}>{t('deployment.editor.validation.openNode')}</Button>
            </AlertAction>
          )}
        </Alert>
      ))}
    </div>
  );
};

interface TopologyListProps {
  draft: DeploymentWorkflowDraft;
  catalog: DeploymentNodeTypeCatalog;
  onConfigure: (id: string) => void;
}

const TopologyList: React.FC<TopologyListProps> = ({ draft, catalog, onConfigure }) => {
  const { t } = useI18n();
  const nodes = topologyOrder(draft.definition);
  const edges = projectDeploymentEdges(draft.definition);
  return (
    <div className="flex flex-col gap-3 @min-[48rem]:hidden" data-testid="deployment-topology-list">
      {nodes.map((workflowNode, index) => {
        const spec = nodeSpec(catalog, workflowNode);
        if (!spec) return null;
        const upstream = edges.filter((edge) => edge.targetNodeId === workflowNode.id).length;
        const downstream = edges.filter((edge) => edge.sourceNodeId === workflowNode.id).length;
        return (
          <Card key={workflowNode.id} size="sm" variant="outline" radius="compact" data-topology-node-id={workflowNode.id}>
            <CardHeader>
              <CardTitle>{index + 1}. {workflowNode.displayName}</CardTitle>
              <CardDescription>{t('deployment.editor.topologyRelations', { upstream, downstream })}</CardDescription>
              <CardAction>
                <Button size="sm" variant="outline" onClick={() => onConfigure(workflowNode.id)}>
                  <Settings2Icon data-icon="inline-start" />
                  {t('deployment.editor.configure')}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <NodeInputFields node={workflowNode} spec={spec} definition={draft.definition} catalog={catalog} />
            </CardContent>
          </Card>
        );
      })}
      {nodes.length === 0 && (
        <EmptyState icon={<ListTreeIcon />} title={t('deployment.editor.emptyGraph')} description={t('deployment.editor.emptyGraphDescription')} />
      )}
    </div>
  );
};

const PlaceholderView: React.FC<{ kind: 'prepare' | 'runs' | 'versions' }> = ({ kind }) => {
  const { t } = useI18n();
  return (
    <Card size="sm" variant="outline" radius="compact">
      <CardHeader>
        <CardTitle>{t(dynamicKey(`deployment.editor.tab.${kind}`))}</CardTitle>
        <CardDescription>{t(dynamicKey(`deployment.editor.placeholder.${kind}`))}</CardDescription>
        <CardAction><Badge variant="secondary">{t('deployment.editor.placeholder.phase5')}</Badge></CardAction>
      </CardHeader>
    </Card>
  );
};

export const DeploymentWorkflowCenter: React.FC<{
  initialTab?: 'design' | 'prepare' | 'runs' | 'versions';
}> = ({ initialTab = 'design' }) => {
  const { t } = useI18n();
  const profiles = useProfileStore((state) => state.profiles);
  const state = useDeploymentWorkflowStore();
  const runState = useDeploymentWorkflowRunStore();
  const addToast = useToastStore((toastState) => toastState.addToast);
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [workflowsOpen, setWorkflowsOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [configOpen, setConfigOpen] = React.useState(false);
  const [issuesOpen, setIssuesOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [activeTab, setActiveTab] = React.useState(initialTab);
  const handledNoticeRef = React.useRef<number | null>(null);
  const handledErrorRef = React.useRef<string | null>(null);
  const handledRunNoticeRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!state.initialized && !state.loading) void state.initialize().catch(() => undefined);
  }, [state]);

  React.useEffect(() => {
    if (!state.requestedTab) return;
    setActiveTab(state.requestedTab);
    state.clearRequestedTab();
  }, [state]);

  React.useEffect(() => {
    if (!state.notice || handledNoticeRef.current === state.notice.id) return;
    handledNoticeRef.current = state.notice.id;
    addToast(t(dynamicKey(`deployment.editor.toast.${state.notice.kind}`)), 'success');
    state.clearNotice();
  }, [addToast, state, t]);

  React.useEffect(() => {
    const workflowId = state.draft?.id;
    if (!workflowId || runState.workflowId === workflowId) return;
    void runState.loadWorkflow(workflowId).catch(() => undefined);
  }, [runState, state.draft?.id]);

  React.useEffect(() => {
    if (!runState.notice || handledRunNoticeRef.current === runState.notice.id) return;
    handledRunNoticeRef.current = runState.notice.id;
    addToast(t(dynamicKey(`deployment.runtime.toast.${runState.notice.kind}`)), 'success');
    runState.clearNotice();
  }, [addToast, runState, t]);

  React.useEffect(() => {
    if (!state.error) {
      handledErrorRef.current = null;
      return;
    }
    if (state.error.includes('VALIDATION_FAILED')) {
      state.clearError();
      return;
    }
    if (handledErrorRef.current === state.error) return;
    handledErrorRef.current = state.error;
    addToast(localizedEditorError(state.error, t), 'error', 6_000);
    state.clearError();
  }, [addToast, state, t]);

  const draft = state.draft;
  const catalog = state.catalog;
  const selectedRecord = draft?.id ? state.workflows.find((workflow) => workflow.id === draft.id) ?? null : null;
  const selectedNode = draft?.definition.nodes.find((node) => node.id === state.selectedNodeId) ?? null;
  const admissionsEnabled = state.capabilities?.admissionsEnabled === true;
  const dirty = state.semanticDirty || state.layoutDirty;
  const visibleWorkflows = state.profileFilterId
    ? state.workflows.filter((workflow) => workflow.definition.targets.some(
      (target) => target.connectionProfileId === state.profileFilterId,
    ))
    : state.workflows;

  React.useEffect(() => {
    if (!state.initialized || visibleWorkflows.length === 0) return;
    if (visibleWorkflows.some((workflow) => workflow.id === state.selectedWorkflowId)) return;
    state.selectWorkflow(visibleWorkflows[0]!.id);
  }, [state, visibleWorkflows]);

  const openConfiguration = (id: string): void => {
    state.selectNode(id);
    setConfigOpen(true);
  };

  const validate = async (): Promise<void> => {
    const issues = await state.validateDraft().catch(() => []);
    setIssuesOpen(issues.length > 0);
  };

  return (
    <WorkbenchPage>
      <WorkbenchPageHeader
        icon={CloudUploadIcon}
        title={t('deployment.editor.title')}
        description={t('deployment.editor.description')}
        titleMeta={draft?.id ? <Badge variant="outline">{t('deployment.editor.revision', { revision: draft.revision })}</Badge> : undefined}
        actions={(
          <>
            <Button variant="outline" size="sm" onClick={() => void state.refresh().catch(() => undefined)} disabled={state.loading}>
              {state.loading ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
              {t('common.refresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTemplateOpen(true)} disabled={!admissionsEnabled || profiles.length === 0}>
              <PlusIcon data-icon="inline-start" />
              {t('deployment.editor.newWorkflow')}
            </Button>
            <Button size="sm" onClick={() => void state.saveDraft().catch(() => undefined)} disabled={!admissionsEnabled || !draft || !dirty || state.saving}>
              {state.saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              {t('common.save')}
            </Button>
          </>
        )}
      />
      <WorkbenchPageContent className="min-h-0 flex-1 overflow-y-auto @min-[48rem]:overflow-hidden">
        {state.capabilities && !admissionsEnabled && (
          <Alert variant="warning">
            <AlertTriangleIcon />
            <AlertTitle>{t('deployment.editor.readOnly')}</AlertTitle>
            <AlertDescription>{t('deployment.editor.readOnlyDescription', { flag: state.capabilities.flagName })}</AlertDescription>
          </Alert>
        )}
        {!state.initialized && state.loading ? (
          <PanelLoadingState label={t('deployment.editor.loading')} />
        ) : profiles.length === 0 ? (
          <EmptyState icon={<CloudUploadIcon />} title={t('deployment.noProfiles')} description={t('deployment.noProfilesDescription')} />
        ) : !draft || !catalog ? (
          <EmptyState
            icon={<ListTreeIcon />}
            title={t('deployment.editor.empty')}
            description={t('deployment.editor.emptyDescription')}
            action={<Button onClick={() => setTemplateOpen(true)} disabled={!admissionsEnabled}><PlusIcon data-icon="inline-start" />{t('deployment.editor.newWorkflow')}</Button>}
          />
        ) : (
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="min-h-0 flex-1">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <TabsList variant="line" className="min-w-0 overflow-x-auto">
                <TabsTrigger value="design">{t('deployment.editor.tab.design')}</TabsTrigger>
                <TabsTrigger value="prepare">{t('deployment.editor.tab.prepare')}</TabsTrigger>
                <TabsTrigger value="runs">{t('deployment.editor.tab.runs')}</TabsTrigger>
                <TabsTrigger value="versions">{t('deployment.editor.tab.versions')}</TabsTrigger>
              </TabsList>
              <div className="flex shrink-0 gap-1 @min-[72rem]:hidden">
                <Button size="icon-sm" variant="outline" onClick={() => setWorkflowsOpen(true)} aria-label={t('deployment.editor.workflows')}><ListTreeIcon /></Button>
                <Button size="icon-sm" variant="outline" onClick={() => setLibraryOpen(true)} aria-label={t('deployment.editor.nodeLibrary')}><LibraryIcon /></Button>
                <Button size="icon-sm" variant="outline" onClick={() => setConfigOpen(true)} aria-label={t('deployment.editor.configuration')}><PanelRightIcon /></Button>
              </div>
            </div>
            <TabsContent value="design" className="flex min-h-0">
              <div className="flex min-h-0 min-w-0 flex-1 gap-3">
                <aside className="hidden min-h-0 w-64 shrink-0 flex-col gap-3 @min-[72rem]:flex">
                  <WorkflowListCard
                    workflows={visibleWorkflows}
                    selectedWorkflowId={state.selectedWorkflowId}
                    search={search}
                    onSearchChange={setSearch}
                    onSelect={state.selectWorkflow}
                    onCreate={() => setTemplateOpen(true)}
                  />
                  <NodeLibraryCard catalog={catalog} onAdd={(spec) => state.addNode(spec.typeName, spec.typeVersion)} />
                </aside>
                <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                  <Card className="hidden min-h-0 min-w-0 flex-1 @min-[48rem]:flex" size="sm" variant="outline" radius="compact">
                    <CardHeader className="shrink-0">
                      <CardTitle>{draft.name}</CardTitle>
                      <CardDescription>{t('deployment.editor.canvasDescription')}</CardDescription>
                      <CardAction className="flex gap-1">
                        <Button variant="outline" size="sm" onClick={() => setIssuesOpen(true)}>
                          <AlertTriangleIcon data-icon="inline-start" />
                          {t('deployment.editor.issues', { count: state.issues.length })}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void validate()} disabled={state.validating}>
                          {state.validating ? <Spinner data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
                          {t('deployment.editor.validate')}
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent className="min-h-0 min-w-0 flex-1 p-0">
                      <WorkflowCanvas draft={draft} catalog={catalog} selectedNodeId={state.selectedNodeId} />
                    </CardContent>
                  </Card>
                  <div className="flex items-center justify-between gap-2 @min-[48rem]:hidden">
                    <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}><PlusIcon data-icon="inline-start" />{t('deployment.editor.addNode')}</Button>
                    <Button variant="outline" size="sm" onClick={() => setIssuesOpen(true)}><AlertTriangleIcon data-icon="inline-start" />{t('deployment.editor.issues', { count: state.issues.length })}</Button>
                  </div>
                  <TopologyList draft={draft} catalog={catalog} onConfigure={openConfiguration} />
                </section>
                <aside className="hidden min-h-0 w-80 shrink-0 @min-[72rem]:flex">
                  <NodeConfiguration draft={draft} node={selectedNode} catalog={catalog} />
                </aside>
              </div>
            </TabsContent>
            <TabsContent value="prepare" className="flex min-h-0">
              {selectedRecord
                ? <DeploymentWorkflowRuntimeView kind="prepare" workflow={selectedRecord} semanticDirty={state.semanticDirty} />
                : <PlaceholderView kind="prepare" />}
            </TabsContent>
            <TabsContent value="runs" className="flex min-h-0">
              {selectedRecord
                ? <DeploymentWorkflowRuntimeView kind="runs" workflow={selectedRecord} />
                : <PlaceholderView kind="runs" />}
            </TabsContent>
            <TabsContent value="versions" className="flex min-h-0">
              {selectedRecord
                ? <DeploymentWorkflowRuntimeView kind="versions" workflow={selectedRecord} />
                : <PlaceholderView kind="versions" />}
            </TabsContent>
          </Tabs>
        )}
      </WorkbenchPageContent>

      <TemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />
      {draft && catalog && (
        <>
          <Drawer open={workflowsOpen} onOpenChange={setWorkflowsOpen}>
            <DrawerContent className="flex min-h-0 flex-col gap-0 p-0">
              <DrawerHeader className="shrink-0 p-4"><DrawerTitle>{t('deployment.editor.workflows')}</DrawerTitle></DrawerHeader>
              <div className="min-h-0 flex-1 px-4 pb-4">
                <WorkflowListCard
                  workflows={state.workflows}
                  selectedWorkflowId={state.selectedWorkflowId}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={(id) => { state.selectWorkflow(id); setWorkflowsOpen(false); }}
                  onCreate={() => { setWorkflowsOpen(false); setTemplateOpen(true); }}
                />
              </div>
            </DrawerContent>
          </Drawer>
          <Drawer open={libraryOpen} onOpenChange={setLibraryOpen}>
            <DrawerContent className="flex min-h-0 flex-col gap-0 p-0">
              <DrawerHeader className="shrink-0 p-4"><DrawerTitle>{t('deployment.editor.nodeLibrary')}</DrawerTitle></DrawerHeader>
              <div className="min-h-0 flex-1 px-4 pb-4">
                <NodeLibraryCard catalog={catalog} onAdd={(spec) => state.addNode(spec.typeName, spec.typeVersion)} />
              </div>
            </DrawerContent>
          </Drawer>
          <Drawer open={configOpen} onOpenChange={setConfigOpen}>
            <DrawerContent className="flex min-h-0 flex-col gap-0 p-0">
              <DrawerHeader className="shrink-0 p-4"><DrawerTitle>{t('deployment.editor.configuration')}</DrawerTitle></DrawerHeader>
              <div className="min-h-0 flex-1 px-4 pb-4">
                <NodeConfiguration draft={draft} node={selectedNode} catalog={catalog} />
              </div>
            </DrawerContent>
          </Drawer>
          <Dialog open={issuesOpen} onOpenChange={setIssuesOpen}>
            <DialogContent className="flex h-[min(36rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
              <DialogHeader className="shrink-0 p-4">
                <DialogTitle>{t('deployment.editor.validation.title')}</DialogTitle>
                <DialogDescription>{t('deployment.editor.validation.description')}</DialogDescription>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-4 pb-4">
                  <IssueList
                    issues={state.issues}
                    nodeName={(id) => draft.definition.nodes.find((item) => item.id === id)?.displayName ?? t('deployment.editor.validation.workflowContext')}
                    onSelectNode={(id) => { state.selectNode(id); setIssuesOpen(false); }}
                  />
                </div>
              </ScrollArea>
              <DialogFooter className="shrink-0 border-t p-4">
                <Button variant="outline" onClick={() => setIssuesOpen(false)}>{t('common.close')}</Button>
                <Button onClick={() => void validate()} disabled={state.validating}>{state.validating && <Spinner data-icon="inline-start" />}{t('deployment.editor.validate')}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
      <DeploymentWorkflowRuntimeOverlays />
    </WorkbenchPage>
  );
};
