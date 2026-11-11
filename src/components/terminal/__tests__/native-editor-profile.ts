interface NativeEditorProfile {
  shell: string;
  shellVersion?: string | null;
  editor: string;
  editorVersion?: string | null;
  adapterVersion: string;
  verifiedProfileId?: string | null;
}

const bindings = {
  powerShell7: {
    shellVersion: '7.6.9', editor: 'psReadLine', editorVersion: '2.4.5',
    ids: ['powershell-7.6.9-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native'],
  },
  zsh: {
    shellVersion: '5.9', editor: 'zle', editorVersion: '5.9',
    ids: ['zsh-5.9-zle-5.9-macos-arm64-native', 'zsh-5.9-zle-5.9-linux-aarch64-glibc-2.36-native'],
  },
} as const;

export function isCurrentNativeEditorProfile(
  profile: NativeEditorProfile | null | undefined,
  shell: string | null,
): boolean {
  if (shell !== 'powerShell7' && shell !== 'zsh') return false;
  const expected = bindings[shell];
  return profile?.shell === shell && profile.shellVersion === expected.shellVersion
    && profile.editor === expected.editor && profile.editorVersion === expected.editorVersion
    && profile.adapterVersion === '1' && expected.ids.some(id => id === profile.verifiedProfileId);
}
