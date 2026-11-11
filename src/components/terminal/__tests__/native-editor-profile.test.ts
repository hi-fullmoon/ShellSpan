import { describe, expect, it } from 'vitest';
import { isCurrentNativeEditorProfile } from './native-editor-profile';

const current = {
  shell: 'powerShell7', shellVersion: '7.6.9', editor: 'psReadLine', editorVersion: '2.4.5',
  adapterVersion: '1', verifiedProfileId: 'powershell-7.6.9-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native',
};

describe('native editor acceptance identity', () => {
  it('accepts the complete current PowerShell profile', () => {
    expect(isCurrentNativeEditorProfile(current, 'powerShell7')).toBe(true);
  });

  it.each([
    { verifiedProfileId: current.verifiedProfileId.replace('shellspan6', 'shellspan5') },
    { verifiedProfileId: current.verifiedProfileId.replace('shellspan6', 'shellspan4') },
    { verifiedProfileId: current.verifiedProfileId.replace('shellspan6', 'shellspan3') },
    { verifiedProfileId: current.verifiedProfileId.replace('shellspan6', 'shellspan2') },
    { verifiedProfileId: current.verifiedProfileId.replace('shellspan6', 'shellspan1') },
    { verifiedProfileId: `${current.verifiedProfileId}-capture1` },
    { verifiedProfileId: 'unverified-windows-x64-native' },
    { verifiedProfileId: 'powershell-7.6.9-psreadline-2.4.5-windows-x64-native' },
    { shellVersion: '7.6.8' },
    { editorVersion: '2.4.4' },
    { adapterVersion: '2' },
    { editor: 'custom' },
  ])('rejects a mismatched frozen identity: %j', changed => {
    expect(isCurrentNativeEditorProfile({ ...current, ...changed }, 'powerShell7')).toBe(false);
  });

  it('rejects missing peers and a different requested shell', () => {
    expect(isCurrentNativeEditorProfile(undefined, 'powerShell7')).toBe(false);
    expect(isCurrentNativeEditorProfile(current, 'windowsPowerShell')).toBe(false);
    expect(isCurrentNativeEditorProfile(current, null)).toBe(false);
  });

  it('rejects the retired Windows PowerShell native profile', () => {
    const windows = { ...current, shell: 'windowsPowerShell', shellVersion: '5.1.26100.9818',
      verifiedProfileId: 'windows-powershell-5.1.26100.9818-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native' };
    expect(isCurrentNativeEditorProfile(windows, 'windowsPowerShell')).toBe(false);
  });
});
