import React from 'react';
import { Settings2Icon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { useDeploymentWorkflowStore, type DeploymentWorkflowDraft } from '@/stores/deploymentWorkflowStore';
import {
  DEPLOYMENT_NONE_VALUE,
  deploymentLocaleKey,
  deploymentPortLabel,
  deploymentPortTypeLabel,
  findDeploymentNodeSpec,
  readableDeploymentProfile,
} from './deployment-editor-ui';
import { DeploymentPaneHeader } from './deployment-pane-header';

export interface NodeInputFieldsProps {
  node: DeploymentWorkflowNode;
  spec: DeploymentNodeTypeSpec;
  definition: DeploymentWorkflowDefinition;
  catalog: DeploymentNodeTypeCatalog;
  editable?: boolean;
}

export const NodeInputFields: React.FC<NodeInputFieldsProps> = ({ node, spec, definition, catalog, editable = true }) => {
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
        const value = binding ? `${binding.fromNodeId}|${binding.fromPort}` : DEPLOYMENT_NONE_VALUE;

        return (
          <Field key={input.name} data-invalid={input.required && !binding}>
            <FieldLabel htmlFor={`input-${node.id}-${input.name}`}>{deploymentPortLabel(input.name, t)}</FieldLabel>
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
              <SelectTrigger id={`input-${node.id}-${input.name}`} size="sm" aria-invalid={input.required && !binding}>
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

interface IntegerFieldProps {
  id: string;
  label: string;
  description?: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  invalidMessage: string;
  onCommit: (value: number) => void;
}

// Number inputs sanitize arbitrary text on assignment, which makes controlled
// typing lossy ("-" alone becomes ""). Keep the raw text locally and only parse,
// clamp, and commit on blur so intermediate input is never swallowed.
const IntegerField: React.FC<IntegerFieldProps> = ({
  id,
  label,
  description,
  value,
  min,
  max,
  disabled = false,
  invalidMessage,
  onCommit,
}) => {
  const serialized = String(value);
  const [text, setText] = React.useState(serialized);
  const [invalid, setInvalid] = React.useState(false);
  const lastSerializedRef = React.useRef(serialized);

  React.useEffect(() => {
    if (serialized !== lastSerializedRef.current) {
      lastSerializedRef.current = serialized;
      setText(serialized);
      setInvalid(false);
    }
  }, [serialized]);

  const commit = (): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      // An empty field reverts to the committed value instead of writing.
      setText(lastSerializedRef.current);
      setInvalid(false);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const clamped = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    const next = String(clamped);
    lastSerializedRef.current = next;
    setText(next);
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <Field data-invalid={invalid ? 'true' : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="h-8"
        type="text"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
      />
      {invalid
        ? <FieldError>{invalidMessage}</FieldError>
        : description
          ? <FieldDescription>{description}</FieldDescription>
          : null}
    </Field>
  );
};

interface ConfigFieldControlProps {
  node: DeploymentWorkflowNode;
  field: DeploymentNodeConfigFieldSpec;
  definition: DeploymentWorkflowDefinition;
  editable: boolean;
}

const ConfigFieldControl: React.FC<ConfigFieldControlProps> = ({ node, field, definition, editable }) => {
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
        label: profile ? `${readableDeploymentProfile(profile)} · ${target.remoteRoot}` : target.remoteRoot,
      };
    });
    return (
      <Field>
        <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
        <Select items={options} value={String(value ?? '')} disabled={!editable} onValueChange={(next) => update(node.id, field.name, next ?? '')}>
          <SelectTrigger id={id} size="sm">
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
        <Select items={options} value={String(value ?? '')} disabled={!editable} onValueChange={(next) => update(node.id, field.name, next ?? '')}>
          <SelectTrigger id={id} size="sm">
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
        <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
      </Field>
    );
  }

  if (field.kind === 'boolean') {
    return (
      <Field className="flex-row items-start gap-2">
        <Checkbox id={id} checked={value === true} onCheckedChange={(checked) => update(node.id, field.name, checked)} disabled={!editable} />
        <div className="flex flex-col gap-1">
          <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
          <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
        </div>
      </Field>
    );
  }

  if (field.kind === 'stringList' || field.kind === 'integerList') {
    return <ListConfigField node={node} field={field} editable={editable} />;
  }

  if (field.kind === 'integer') {
    return (
      <IntegerField
        id={id}
        label={t(deploymentLocaleKey(field.labelKey))}
        description={t(deploymentLocaleKey(field.descriptionKey))}
        value={typeof value === 'number' ? value : 0}
        min={field.minimum}
        max={field.maximum}
        disabled={!editable}
        invalidMessage={t('deployment.editor.config.invalidNumber')}
        onCommit={(next) => update(node.id, field.name, next)}
      />
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
      <Input
        id={id}
        className="h-8"
        type="text"
        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
        disabled={!editable}
        onChange={(event) => update(node.id, field.name, event.target.value)}
      />
      <FieldDescription>{t(deploymentLocaleKey(field.descriptionKey))}</FieldDescription>
    </Field>
  );
};

interface ListConfigFieldProps {
  node: DeploymentWorkflowNode;
  field: DeploymentNodeConfigFieldSpec;
  editable: boolean;
}

// Splitting and filtering on every keystroke used to normalize the controlled
// value immediately, swallowing trailing commas and newlines before the user
// could finish typing. Keep the raw text and parse only on blur.
const ListConfigField: React.FC<ListConfigFieldProps> = ({ node, field, editable }) => {
  const { t } = useI18n();
  const update = useDeploymentWorkflowStore((state) => state.updateNodeConfig);
  const value = node.config[field.name];
  const id = `config-${node.id}-${field.name}`;
  const serialized = listValue(value);
  const [text, setText] = React.useState(serialized);
  const lastSerializedRef = React.useRef(serialized);

  React.useEffect(() => {
    if (serialized !== lastSerializedRef.current) {
      lastSerializedRef.current = serialized;
      setText(serialized);
    }
  }, [serialized]);

  const commit = (): void => {
    const entries = text
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const next = field.kind === 'integerList'
      ? entries.map(Number).filter(Number.isInteger)
      : entries;
    lastSerializedRef.current = next.map(String).join('\n');
    update(node.id, field.name, next);
  };

  return (
    <Field>
      <FieldLabel htmlFor={id}>{t(deploymentLocaleKey(field.labelKey))}</FieldLabel>
      <Textarea
        id={id}
        value={text}
        rows={3}
        disabled={!editable}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
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

export const NodeInspector: React.FC<NodeInspectorProps> = ({ draft, node, catalog, editable = true }) => {
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
        <DeploymentPaneHeader title={t('deployment.editor.configuration')} />
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
      <DeploymentPaneHeader
        title={node.displayName}
        description={t(deploymentLocaleKey(spec.descriptionKey))}
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => removeNode(node.id)}
            disabled={!editable}
            aria-label={t('deployment.editor.removeNode')}
          >
            <Trash2Icon data-icon="inline-start" />
          </Button>
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <FieldGroup className="gap-3 p-2">
          <Field>
            <FieldLabel htmlFor={`node-name-${node.id}`}>{t('deployment.editor.nodeName')}</FieldLabel>
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
              <Badge variant="outline">{t(deploymentLocaleKey(`deployment.editor.effect.${spec.effectClass}`))}</Badge>
              <Badge variant="outline">{t(deploymentLocaleKey(`deployment.editor.risk.${spec.riskLevel}`))}</Badge>
              <Badge variant="outline">{t(deploymentLocaleKey(`deployment.editor.domain.${spec.executionDomain}`))}</Badge>
            </div>
          </Field>
          <IntegerField
            id={`node-timeout-${node.id}`}
            label={t('deployment.editor.timeout')}
            value={node.timeoutSeconds}
            min={1}
            max={86_400}
            disabled={!editable}
            invalidMessage={t('deployment.editor.config.invalidNumber')}
            onCommit={(next) => updateNode(node.id, { timeoutSeconds: next })}
          />
          <NodeInputFields node={node} spec={spec} definition={draft.definition} catalog={catalog} editable={editable} />
          {spec.configSchema.fields.map((field) => (
            <ConfigFieldControl key={field.name} node={node} field={field} definition={draft.definition} editable={editable} />
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
