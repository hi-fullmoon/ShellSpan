import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from '../settings-layout';

afterEach(cleanup);

it('toggles the associated switch through its visible setting label', async () => {
  function Setting() {
    const [checked, setChecked] = useState(false);
    return (
      <SettingRow controlId="pet-setting" label="Desktop pet" description="Enable desktop pet integration">
        <Switch id="pet-setting" checked={checked} onCheckedChange={setChecked} />
      </SettingRow>
    );
  }
  render(<Setting />);
  const control = screen.getByRole('switch', { name: 'Desktop pet' });
  expect(control).not.toBeChecked();
  await userEvent.click(screen.getByText('Desktop pet'));
  expect(control).toBeChecked();
  await userEvent.click(screen.getByText('Desktop pet'));
  expect(control).not.toBeChecked();
});
