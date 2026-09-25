import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel, FieldDescription, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/hooks/useI18n';
import type { DeploymentEnvironmentConfig, HostComposeConfig } from '@/lib/deployment/applications';
import type { LocaleKey } from '@/locales';

export function HostComposeFields({ config, onChange }: {
  config: DeploymentEnvironmentConfig;
  onChange: (patch: Partial<DeploymentEnvironmentConfig>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = React.useId();
  const host = config.hostCompose;
  const key = (name: string): LocaleKey => `deployment.application.host.${name}` as LocaleKey;
  const patch = (values: Partial<HostComposeConfig>): void => {
    if (host) onChange({ hostCompose: { ...host, ...values } });
  };
  const lines = (name: string, values: string[], change: (values: string[]) => void): React.JSX.Element =>
    <Field><FieldLabel htmlFor={`${id}-${name}`}>{t(key(name))}</FieldLabel>
      <Textarea id={`${id}-${name}`} value={values.join('\n')} onChange={(event) => change(event.target.value.split('\n'))} />
      <FieldDescription>{t(key('onePerLine'))}</FieldDescription>
    </Field>;
  return <FieldGroup>
    <Field><FieldLabel htmlFor={`${id}-image`}>{t(key('imageRepository'))}</FieldLabel><Input id={`${id}-image`} value={config.imageRepository ?? ''} onChange={(event) => onChange({ imageRepository: event.target.value || undefined })} /></Field>
    <Field><FieldLabel htmlFor={`${id}-git`}>{t(key('gitRef'))}</FieldLabel>
      <Input id={`${id}-git`} value={config.gitRef ?? ''} onChange={(event) => onChange({ gitRef: event.target.value || undefined })} />
      <FieldDescription>{t(key('gitRefHelp'))}</FieldDescription>
    </Field>
    <Field><FieldLabel htmlFor={`${id}-verify`}>{t(key('verification'))}</FieldLabel>
      <Input id={`${id}-verify`} value={config.verification?.script ?? ''} onChange={(event) => onChange({ verification: event.target.value ? { packageManager: config.verification?.packageManager ?? 'npm', script: event.target.value } : undefined })} />
      <FieldDescription>{t(key('verificationHelp'))}</FieldDescription>
    </Field>
    {config.verification && <Field className="flex-row items-center"><Checkbox id={`${id}-pnpm`} checked={config.verification.packageManager === 'pnpm'} onCheckedChange={(checked) => onChange({ verification: { script: config.verification!.script, packageManager: checked ? 'pnpm' : 'npm' } })} /><FieldLabel htmlFor={`${id}-pnpm`}>{t(key('pnpm'))}</FieldLabel></Field>}
    <Field className="flex-row items-center"><Checkbox id={`${id}-enabled`} checked={Boolean(host)} onCheckedChange={(checked) => onChange({
      hostCompose: checked ? { environmentFile: '.env', overrideFiles: [], recreateServices: [], backup: { script: '', arguments: [] }, checks: [{ url: config.accessUrl, status: 200 }] } : undefined,
      ...(checked ? { existingService: true, gitRef: config.gitRef || 'main' } : {}),
    })} /><FieldLabel htmlFor={`${id}-enabled`}>{t(key('enabled'))}</FieldLabel></Field>
    {host && <>
      <FieldDescription>{t(key('help'))}</FieldDescription>
      <Field><FieldLabel htmlFor={`${id}-env`}>{t(key('environmentFile'))}</FieldLabel><Input id={`${id}-env`} value={host.environmentFile} onChange={(event) => patch({ environmentFile: event.target.value })} /></Field>
      {lines('overrideFiles', host.overrideFiles, (overrideFiles) => patch({ overrideFiles }))}
      {lines('recreateServices', host.recreateServices, (recreateServices) => patch({ recreateServices }))}
      {lines('files', config.nonSensitiveFiles, (nonSensitiveFiles) => onChange({ nonSensitiveFiles }))}
      <Field><FieldLabel htmlFor={`${id}-backup`}>{t(key('backup'))}</FieldLabel><Input id={`${id}-backup`} value={host.backup.script} onChange={(event) => patch({ backup: { ...host.backup, script: event.target.value } })} /></Field>
      {lines('arguments', host.backup.arguments, (args) => patch({ backup: { ...host.backup, arguments: args } }))}
      {lines('checks', host.checks.map((check) => check.url), (urls) => patch({ checks: urls.map((url, index) => ({ ...host.checks[index], url, status: host.checks[index]?.status ?? 200 })) }))}
      {host.checks.filter((check) => check.url).map((check, index) => {
        const update = (values: Partial<typeof check>): void => patch({ checks: host.checks.map((item) => item === check ? { ...item, ...values } : item) });
        const expectations = Object.entries(check.jsonFields ?? {});
        return <FieldGroup key={index}>
          <FieldDescription>{check.url}</FieldDescription>
          <Field><FieldLabel htmlFor={`${id}-status-${index}`}>{t(key('status'))}</FieldLabel><Input id={`${id}-status-${index}`} type="number" value={check.status} onChange={(event) => update({ status: Number(event.target.value) })} /></Field>
          <Field><FieldLabel htmlFor={`${id}-location-${index}`}>{t(key('location'))}</FieldLabel><Input id={`${id}-location-${index}`} value={check.location ?? ''} onChange={(event) => update({ location: event.target.value || undefined })} /></Field>
          {(expectations.length ? expectations : [['', '']]).map(([field, expected], fieldIndex) => <FieldGroup key={fieldIndex}>
            <Field><FieldLabel htmlFor={`${id}-json-key-${index}-${fieldIndex}`}>{t(key('jsonKey'))}</FieldLabel><Input id={`${id}-json-key-${index}-${fieldIndex}`} value={field} onChange={(event) => {
              const next = expectations.filter(([name]) => name !== field);
              if (event.target.value) next.splice(fieldIndex, 0, [event.target.value, expected ?? '']);
              update({ jsonFields: Object.fromEntries(next) });
            }} /></Field>
            <Field><FieldLabel htmlFor={`${id}-json-value-${index}-${fieldIndex}`}>{t(key('jsonValue'))}</FieldLabel><Input id={`${id}-json-value-${index}-${fieldIndex}`} disabled={!field} value={expected} onChange={(event) => update({ jsonFields: { ...check.jsonFields, [field!]: event.target.value } })} /></Field>
          </FieldGroup>)}
        </FieldGroup>;
      })}
      <FieldDescription>{t(key('recovery'))}</FieldDescription>
    </>}
  </FieldGroup>;
}
