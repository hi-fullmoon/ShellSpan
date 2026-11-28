import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SettingRow, SettingsGroup } from './settings-layout';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/hooks/useI18n';
import { testPetdexMessage } from '@/lib/petdex/messages';
import type { PetdexMessagePreferences } from '@/lib/petdex/message-preferences';
import type { PetdexDiagnostic } from '@/types';

interface PetdexMessageSettingsProps {
  onPreferenceSync?: (diagnostic: PetdexDiagnostic) => void;
  onRetrySubscription?: () => void;
}

export function PetdexMessageSettings({
  onPreferenceSync,
  onRetrySubscription,
}: PetdexMessageSettingsProps = {}) {
  const { t } = useI18n();
  const enabled = useAppStore((s) => s.petdexEnabled);
  const messagesEnabled = useAppStore((s) => s.petdexRequestedMessages?.petdexMessagesEnabled ?? s.petdexMessagesEnabled);
  const detailsEnabled = useAppStore((s) => s.petdexRequestedMessages?.petdexMessageDetailsEnabled ?? s.petdexMessageDetailsEnabled);
  const configuring = useAppStore((s) => s.petdexConfiguring);
  const [testing, setTesting] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const updateRevisionRef = useRef(0);
  const testRevisionRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      updateRevisionRef.current += 1;
      testRevisionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !messagesEnabled) {
      testRevisionRef.current += 1;
      busy.current = false;
      setTesting(false);
    }
  }, [enabled, messagesEnabled]);

  const update = async (key: keyof PetdexMessagePreferences, value: boolean) => {
    const updateRevision = ++updateRevisionRef.current;
    testRevisionRef.current += 1;
    busy.current = false;
    setTesting(false);
    onRetrySubscription?.();
    try {
      const diagnostic = await useAppStore.getState().setPetdexMessagePreference(key, value);
      if (mounted.current && updateRevision === updateRevisionRef.current) {
        onPreferenceSync?.(diagnostic);
        toast.success(t('settings.experimental.petdex.messages.saved'), { id: 'petdex-preferences-saved' });
      }
    } catch {
      if (mounted.current && updateRevision === updateRevisionRef.current) {
        toast.error(t('settings.experimental.petdex.messages.saveFailed'));
      }
    }
  };

  const test = async () => {
    if (busy.current) return;
    busy.current = true;
    const testRevision = ++testRevisionRef.current;
    onRetrySubscription?.();
    setTesting(true);
    try {
      const result = await testPetdexMessage();
      useAppStore.getState().receivePetdexMessageDiagnostic(result.diagnostic);
      if (mounted.current && testRevision === testRevisionRef.current) {
        const message = t(`settings.experimental.petdex.messages.test.${result.outcome}`);
        if (result.outcome === 'accepted') toast.success(message);
        else if (result.outcome === 'failed') toast.error(message);
        else toast.info(message);
      }
    } catch {
      if (mounted.current && testRevision === testRevisionRef.current) {
        toast.error(t('settings.experimental.petdex.operationError'));
      }
    } finally {
      if (mounted.current && testRevision === testRevisionRef.current) {
        busy.current = false;
        setTesting(false);
      }
    }
  };

  return (
    <SettingsGroup
      title={t('settings.experimental.petdex.messages.title')}
      titleId="petdex-messages-title"
      action={(
        <Button
          size="sm"
          variant="soft"
          type="button"
          disabled={!enabled || !messagesEnabled || configuring || testing}
          onClick={() => void test()}
        >
          {t(testing ? 'settings.experimental.petdex.testing' : 'settings.experimental.petdex.messages.test')}
        </Button>
      )}
    >
      <SettingRow
        controlId="petdex-messages-enabled"
        label={t('settings.experimental.petdex.messages.enabled')}
        descriptionId="petdex-message-description"
        description={t('settings.experimental.petdex.messages.description')}
      >
        <Switch
          id="petdex-messages-enabled"
          aria-label={t('settings.experimental.petdex.messages.enabled')}
          checked={messagesEnabled}
          aria-busy={configuring}
          aria-describedby="petdex-message-description petdex-message-visibility"
          onCheckedChange={(value) => void update('petdexMessagesEnabled', value)}
        />
      </SettingRow>
      <SettingRow
        controlId="petdex-message-details-enabled"
        label={t('settings.experimental.petdex.messages.details')}
        descriptionId="petdex-message-risk"
        description={t('settings.experimental.petdex.messages.risk')}
      >
        <Switch
          id="petdex-message-details-enabled"
          aria-label={t('settings.experimental.petdex.messages.details')}
          checked={detailsEnabled}
          aria-busy={configuring}
          aria-describedby="petdex-message-risk"
          onCheckedChange={(value) => void update('petdexMessageDetailsEnabled', value)}
        />
      </SettingRow>
      <p id="petdex-message-visibility" className="bg-muted/25 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        {t('settings.experimental.petdex.messages.visibility')}
      </p>
    </SettingsGroup>
  );
}
