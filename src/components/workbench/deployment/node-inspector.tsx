import React from 'react';
import { Settings2Icon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
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
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/hooks/useI18n';
import { compatibleOutputBindings } from '@/lib/deployment/editor';
import type {
  DeploymentJsonValue,
  DeploymentNodeConfigFieldSpec,
  DeploymentNodeTypeCatalog,
  DeploymentNodeTypeSpec,
  DeploymentWorkflowDefinition,
  DeploymentWorkflowNode,
} from '@/lib/deployment/types';
import { useProfileStore } from '@/stores/profileStore';
import {
  useDeploymentWorkflowStore,
  type DeploymentWorkflowDraft,
} from '@/stores/deploymentWorkflowStore';
import {
  DEPLOYMENT_NONE_VALUE,
  deploymentLocaleKey,
  deploymentPortLabel,
  deploymentPortTypeLabel,
  findDeploymentNodeSpec,
  readableDeploymentProfile,
} from './deployment-editor-ui';

export interface NodeInputFieldsProps {
  node: DeploymentWorkflowNode;
  spec: DeploymentNodeTypeSpec;
  definition: DeploymentWorkflowDefinition;
  catalog: DeploymentNodeTypeCatalog;
  editable?: boolean;
}

export const NodeInputFields: React.FC<NodeInputFieldsProps> = ({
  node,
  spec,
  definition,
  catalog,
  editable = true,
}) => {
  const { t } = useI18n();
  const connectInput = useDeploymentWorkflowStore((state) => state.connectInput);
  if (spec.inputs.length === 0) return null;

  return (
    <FieldGroup className="gap-3">
      {spec.inputs.map((input) => {
        const compatible = compatibleOutputBindings(definition, catalog, node.id, input.name);
        const options = [
          { value: DEPLOYMENT_NONE_VALUE, label: t('deployment.editor.connection.none') },
          ...compatible.map((candidate) => ({
            value: `${candidate.binding.fromNodeId}|${candidate.binding.fromPort}`,
            label: `${candidate.node.displayName} · ${deploymentPortLabel(candidate.port.name, t)}`,
          })),
        ];
        const binding = node.inputs[input.name];
        const value = binding
          ? `${binding.fromNodeId}|${binding.fromPort}`
          : DEPLOYMENT_NONE_VALUE;

        return (
          <Field key={input.name} data-invalid={input.required && !binding}>
            <FieldLabel htmlFor={`input-${node.id}-${input.name}`}>
              {deploymentPortLabel(input.name, t)}
            </FieldLabel>
            <Select
              items={options}
              value={value}
              disabled={!editable}
              onValueChange={(next) => {
                if (!next || next === DEPLOYMENT_NONE_VALUE) {
                  connectInput(node.id, input.name, null);
                  return;
                }
                const [fromNodeId, fromPort] = next.split('|');
                if (fromNodeId && fromPort) {
                  connectInput(node.id, input.name, { fromNodeId, fromPort });
                }
              }}
            >
              <SelectTrigger
                id={`input-${node.id}-${input.name}`}
                size="sm"
                aria-invalid={input.required && !binding}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {t('deployment.editor.connection.type', {
                type: deploymentPortTypeLabel(input.portType, t),
              })}
            </FieldDescription>
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
  editable: boolean;
}

const ConfigFieldControl: React.FC<ConfigFieldControlProps> = ({
  node,
  field,
  definition,
  editable,
}) => {
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
        label: profile
          ? `${readableDeploymentProfile(profile)} · ${target.remoteRoot}`
          : target.remoteRoot,
      };
    });
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
        <Select
          items={options}
          value={String(value ?? '')}
          disabled={!editable}
          onValueChange={(next) => update(node.id, field.name, next ?? '')}
        >
          <SelectTrigger id={id} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }

  if (field.kind === 'select') {
    const options = (field.options ?? []).map((option) => ({
      value: option.value,
      label: t(deploymentLocaleKey(option.labelKey)),
    }));
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
        <Select
          items={options}
          value={String(value ?? '')}
          disabled={!editable}
          onValueChange={(next) => update(node.id, field.name, next ?? '')}
        >
          <SelectTrigger id={id} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }

  if (field.kind === 'boolean') {
    return (
      <Field className="flex-row items-start gap-2">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => update(node.id, field.name, checked)}
          disabled={!editable}
        />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
          <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
        </div>
      </Field>
    );
  }

  if (field.kind === 'stringList' || field.kind === 'integerList') {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
        <Textarea
          id={id}
          value={listValue(value)}
          rows={3}
          disabled={!editable}
          onChange={(event) => {
            const entries = event.target.value
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter(Boolean);
            update(
              node.id,
              field.name,
              field.kind === 'integerList'
                ? entries.map(Number).filter(Number.isInteger)
                : entries,
            );
          }}
        />
        <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
      <Input
        id={id}
        className="h-8"
        type={field.kind === 'integer' ? 'number' : 'text'}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        disabled={!editable}
        onChange={(event) => update(
          node.id,
          field.name,
          field.kind === 'integer' ? Number(event.target.value) : event.target.value,
        )}
      />
      <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
    </Field>
  );
};

export interface NodeInspectorProps {
  draft: DeploymentWorkflowDraft;
  node: DeploymentWorkflowNode | null;
  catalog: DeploymentNodeTypeCatalog;
  editable?: boolean;
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  draft,
  node,
  catalog,
  editable = true,
}) => {
  const { t } = useI18n();
  const updateNode = useDeploymentWorkflowStore((state) => state.updateNode);
  const removeNode = useDeploymentWorkflowStore((state) => state.removeNode);

  if (!node) {
    return (
      <section
        className="flex size-full min-h-0 flex-col bg-background"
        data-testid="deployment-node-config"
        aria-label={t('deployment.editor.configuration')}
      >
        <header className="shrink-0 border-b px-3 py-2.5">
          <h2 className="text-sm font-medium">{t('deployment.editor.configuration')}</h2>
        </header>
        <EmptyState
          className="min-h-0 flex-1"
          icon={<Settings2Icon />}
          title={t('deployment.editor.config.empty')}
          description={t('deployment.editor.config.emptyDescription')}
        />
      </section>
    );
  }

  const spec = findDeploymentNodeSpec(catalog, node);
  if (!spec) return null;

  return (
    <section
      className="flex size-full min-h-0 flex-col bg-background"
      data-testid="deployment-node-config"
      aria-label={t('deployment.editor.configuration')}
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{node.displayName}</h2>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {t(deploymentLocaleKey(spec.descriptionKey))}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => removeNode(node.id)}
          disabled={!editable}
          aria-label={t('deployment.editor.removeNode')}
        >
          <Trash2Icon data-icon="inline-start" />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup className="gap-3 p-3">
          <Field>
            <FieldLabel htmlFor={`node-name-${node.id}`}>
              {t('deployment.editor.nodeName')}
            </FieldLabel>
            <Input
              id={`node-name-${node.id}`}
              className="h-8"
              value={node.displayName}
              onChange={(event) => updateNode(node.id, { displayName: event.target.value })}
              disabled={!editable}
            />
          </Field>
          <Field>
            <FieldLabel>{t('deployment.editor.nodeProperties')}</FieldLabel>
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">
                {t(deploymentLocaleKey(`deployment.editor.effect.${spec.effectClass}`))}
              </Badge>
              <Badge variant="outline">
                {t(deploymentLocaleKey(`deployment.editor.risk.${spec.riskLevel}`))}
              </Badge>
              <Badge variant="outline">
                {t(deploymentLocaleKey(`deployment.editor.domain.${spec.executionDomain}`))}
              </Badge>
            </div>
          </Field>
          <Field>
            <FieldLabel htmlFor={`node-timeout-${node.id}`}>
              {t('deployment.editor.timeout')}
            </FieldLabel>
            <Input
              id={`node-timeout-${node.id}`}
              className="h-8"
              type="number"
              min={1}
              max={86_400}
              value={node.timeoutSeconds}
              disabled={!editable}
              onChange={(event) => updateNode(node.id, {
                timeoutSeconds: Number(event.target.value),
              })}
            />
          </Field>
          <NodeInputFields
            node={node}
            spec={spec}
            definition={draft.definition}
            catalog={catalog}
            editable={editable}
          />
          {spec.configSchema.fields.map((field) => (
            <ConfigFieldControl
              key={field.name}
              node={node}
              field={field}
              definition={draft.definition}
              editable={editable}
            />
          ))}
          {spec.capabilities.length > 0 && (
            <Field>
              <FieldLabel>{t('deployment.editor.capabilities')}</FieldLabel>
              <div className="flex flex-wrap gap-1">
                {spec.capabilities.map((capability) => (
                  <Badge key={capability} variant="secondary">
                    {t(deploymentLocaleKey(`deployment.editor.capability.${capability}`))}
                  </Badge>
                ))}
              </div>
            </Field>
          )}
        </FieldGroup>
      </ScrollArea>
    </section>
  );
};
