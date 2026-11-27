interface NativeEditorProfile {
  shell: string;
  shellVersion?: string | null;
  editor: string;
  editorVersion?: string | null;
  adapterVersion: string;
  verifiedProfileId?: string | null;
}

function isSupportedPowerShell7Version(version: string | null | undefined): boolean {
  if (!version) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  return Number(match[1]) === 7 && Number(match[2]) >= 4;
}

const bindings = {
  powerShell7: {
    matchesShellVersion: isSupportedPowerShell7Version,
    editor: 'psReadLine', editorVersion: '2.4.5',
    ids: ['powershell-7-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native'],
  },
  zsh: {
    matchesShellVersion: (version: string | null | undefined) => version === '5.9',
    editor: 'zle', editorVersion: '5.9',
    ids: ['zsh-5.9-zle-5.9-macos-arm64-native', 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native'],
  },
} as const;

export function isCurrentNativeEditorProfile(
  profile: NativeEditorProfile | null | undefined,
  shell: string | null,
): boolean {
  if (shell !== 'powerShell7' && shell !== 'zsh') return false;
  const expected = bindings[shell];
  return profile?.shell === shell && expected.matchesShellVersion(profile.shellVersion)
    && profile.editor === expected.editor && profile.editorVersion === expected.editorVersion
    && profile.adapterVersion === '1' && expected.ids.some(id => id === profile.verifiedProfileId);
}
