import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Dialog } from '@/components/ui/Dialog';
import type { PortForwardConfig } from '@/types';

export interface PortForwardDialogProps {
  open: boolean;
  onClose: () => void;
  onStart: (forwards: PortForwardConfig[]) => void;
  onStop: () => void;
  activeForwards?: PortForwardConfig[];
}

interface ForwardRow {
  id: string;
  kind: 'local' | 'remote';
  localPort: string;
  remoteHost: string;
  remotePort: string;
}

export const PortForwardDialog: React.FC<PortForwardDialogProps> = ({
  open,
  onClose,
  onStart,
  onStop,
  activeForwards,
}) => {
  const { t } = useI18n();
  const [rows, setRows] = useState<ForwardRow[]>(() =>
    activeForwards?.length
      ? activeForwards.map((f) => ({
          id: Math.random().toString(36).slice(2),
          kind: f.kind,
          localPort: String(f.localPort),
          remoteHost: f.remoteHost,
          remotePort: String(f.remotePort),
        }))
      : [
          {
            id: '1',
            kind: 'local',
            localPort: '',
            remoteHost: 'localhost',
            remotePort: '',
          },
        ],
  );

  const updateRow = (id: string, patch: Partial<ForwardRow>): void => {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  const addRow = (): void => {
    setRows((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        kind: 'local',
        localPort: '',
        remoteHost: 'localhost',
        remotePort: '',
      },
    ]);
  };

  const removeRow = (id: string): void => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const handleStart = (): void => {
    const forwards: PortForwardConfig[] = rows
      .filter(
        (row) =>
          row.localPort.trim() &&
          row.remoteHost.trim() &&
          row.remotePort.trim(),
      )
      .map((row) => ({
        kind: row.kind,
        localPort: Number(row.localPort),
        remoteHost: row.remoteHost.trim(),
        remotePort: Number(row.remotePort),
      }));
    onStart(forwards);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Port Forwards"
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {activeForwards && activeForwards.length > 0 && (
            <Button variant="danger" onClick={onStop}>
              Stop
            </Button>
          )}
          <Button variant="primary" onClick={handleStart}>
            Start
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[100px_80px_1fr_80px_32px] gap-2">
            <Select
              value={row.kind}
              options={[
                { value: 'local', label: 'Local' },
                { value: 'remote', label: 'Remote' },
              ]}
              onChange={(e) =>
                updateRow(row.id, {
                  kind: e.target.value as 'local' | 'remote',
                })
              }
            />
            <Input
              value={row.localPort}
              onChange={(e) => updateRow(row.id, { localPort: e.target.value })}
              placeholder="Local"
              type="number"
            />
            <Input
              value={row.remoteHost}
              onChange={(e) => updateRow(row.id, { remoteHost: e.target.value })}
              placeholder="Remote host"
            />
            <Input
              value={row.remotePort}
              onChange={(e) => updateRow(row.id, { remotePort: e.target.value })}
              placeholder="Remote"
              type="number"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeRow(row.id)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={addRow}>
          + Add Forward
        </Button>
      </div>
    </Dialog>
  );
};
