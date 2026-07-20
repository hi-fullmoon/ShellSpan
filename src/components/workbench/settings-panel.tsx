import React, { useMemo, useState } from 'react';
import { FolderCogIcon, Globe2Icon, KeyboardIcon, PaletteIcon, RotateCcwIcon, Settings2Icon, SquareTerminalIcon } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { getShortcutKeys, shortcutFromKeyboardEvent } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { AppSection, Locale, ShortcutAction, TerminalCursorStyle, TerminalFontFamily, ThemeMode } from '@/types';

const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'openWorkbench',
  'openTerminal',
  'openSftp',
  'openSettings',
];

interface SettingRowProps {
  description: string;
  label: string;
  children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ description, label, children }) => (
  <div className="flex min-h-14 items-center justify-between gap-4 px-3 py-2">
    <div className="flex min-w-0 flex-col gap-0.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
    <div className="w-44 shrink-0">{children}</div>
  </div>
);

const ShortcutKeys: React.FC<{ shortcut: string }> = ({ shortcut }) => {
  const platform = usePlatform();
  return (
    <KbdGroup>
      {getShortcutKeys(shortcut, platform).map((key, index) => (
        <Kbd key={`${key}-${index}`}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
};

export const SettingsPanel: React.FC = () => {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const startupUpdateCheck = useAppStore((state) => state.startupUpdateCheck);
  const setStartupUpdateCheck = useAppStore((state) => state.setStartupUpdateCheck);
  const startupSection = useAppStore((state) => state.startupSection);
  const setStartupSection = useAppStore((state) => state.setStartupSection);
  const terminalFontSize = useAppStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useAppStore((state) => state.setTerminalFontSize);
  const terminalFontFamily = useAppStore((state) => state.terminalFontFamily);
  const setTerminalFontFamily = useAppStore((state) => state.setTerminalFontFamily);
  const terminalCursorBlink = useAppStore((state) => state.terminalCursorBlink);
  const setTerminalCursorBlink = useAppStore((state) => state.setTerminalCursorBlink);
  const terminalCursorStyle = useAppStore((state) => state.terminalCursorStyle);
  const setTerminalCursorStyle = useAppStore((state) => state.setTerminalCursorStyle);
  const terminalCopyOnSelect = useAppStore((state) => state.terminalCopyOnSelect);
  const setTerminalCopyOnSelect = useAppStore((state) => state.setTerminalCopyOnSelect);
  const terminalScrollback = useAppStore((state) => state.terminalScrollback);
  const setTerminalScrollback = useAppStore((state) => state.setTerminalScrollback);
  const sftpShowHiddenFiles = useAppStore((state) => state.sftpShowHiddenFiles);
  const setSftpShowHiddenFiles = useAppStore((state) => state.setSftpShowHiddenFiles);
  const shortcuts = useAppStore((state) => state.shortcuts);
  const setShortcut = useAppStore((state) => state.setShortcut);
  const resetShortcut = useAppStore((state) => state.resetShortcut);
  const resetShortcuts = useAppStore((state) => state.resetShortcuts);
  const [editingAction, setEditingAction] = useState<ShortcutAction | null>(null);
  const [conflictAction, setConflictAction] = useState<ShortcutAction | null>(null);

  const shortcutLabels = useMemo<Record<ShortcutAction, string>>(
    () => ({
      openWorkbench: t('settings.shortcuts.openWorkbench'),
      openTerminal: t('settings.shortcuts.openTerminal'),
      openSftp: t('settings.shortcuts.openSftp'),
      openSettings: t('settings.shortcuts.openSettings'),
    }),
    [t],
  );

  const closeRecorder = (): void => {
    setEditingAction(null);
    setConflictAction(null);
  };

  const handleShortcutCapture = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      closeRecorder();
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut || !editingAction) return;

    const conflict = SHORTCUT_ACTIONS.find(
      (action) => action !== editingAction && shortcuts[action] === shortcut,
    );
    if (conflict) {
      setConflictAction(conflict);
      return;
    }

    setShortcut(editingAction, shortcut);
    closeRecorder();
  };

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center border-b border-app-border px-3 py-1.5">
        <div className="min-w-0">
          <h1 className="text-sm font-medium text-app-text">
            {t('workbench.settings.title')}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {t('settings.description')}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
          <Card size="sm" className="rounded-lg">
            <CardHeader>
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <PaletteIcon />
                </div>
                <div className="flex flex-col gap-1">
                  <CardTitle>{t('settings.appearance.title')}</CardTitle>
                  <CardDescription>{t('settings.appearance.description')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Separator />
              <SettingRow
                label={t('settings.appearance.theme')}
                description={t('settings.appearance.themeDescription')}
              >
                <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
                  <SelectTrigger size="sm" aria-label={t('settings.appearance.theme')}>
                    <SelectValue>
                      {theme === 'light'
                        ? t('theme.light')
                        : theme === 'dark'
                          ? t('theme.dark')
                          : t('theme.system')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="light">{t('theme.light')}</SelectItem>
                      <SelectItem value="dark">{t('theme.dark')}</SelectItem>
                      <SelectItem value="system">{t('theme.system')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.appearance.language')}
                description={t('settings.appearance.languageDescription')}
              >
                <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                  <SelectTrigger size="sm" aria-label={t('settings.appearance.language')}>
                    <Globe2Icon />
                    <SelectValue>
                      {locale === 'zh-CN' ? t('locale.zh-CN') : t('locale.en-US')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="zh-CN">{t('locale.zh-CN')}</SelectItem>
                      <SelectItem value="en-US">{t('locale.en-US')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
            </CardContent>
          </Card>

          <Card size="sm" className="rounded-lg">
            <CardHeader>
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <SquareTerminalIcon />
                </div>
                <div className="flex flex-col gap-1">
                  <CardTitle>{t('settings.terminal.title')}</CardTitle>
                  <CardDescription>{t('settings.terminal.description')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Separator />
              <SettingRow
                label={t('settings.terminal.fontFamily')}
                description={t('settings.terminal.fontFamilyDescription')}
              >
                <Select
                  value={terminalFontFamily}
                  onValueChange={(value) => setTerminalFontFamily(value as TerminalFontFamily)}
                >
                  <SelectTrigger size="sm" aria-label={t('settings.terminal.fontFamily')}>
                    <SelectValue>{t(`settings.terminal.fontFamily.${terminalFontFamily}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(['system', 'menlo', 'monaco', 'consolas', 'courierNew'] as const).map((font) => (
                        <SelectItem key={font} value={font}>
                          {t(`settings.terminal.fontFamily.${font}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.terminal.fontSize')}
                description={t('settings.terminal.fontSizeDescription')}
              >
                <Select
                  value={String(terminalFontSize)}
                  onValueChange={(value) => setTerminalFontSize(Number(value))}
                >
                  <SelectTrigger size="sm" aria-label={t('settings.terminal.fontSize')}>
                    <SelectValue>
                      {t('settings.terminal.fontSizeValue', { size: terminalFontSize })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[12, 13, 14, 15, 16, 18].map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {t('settings.terminal.fontSizeValue', { size })}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.terminal.cursorStyle')}
                description={t('settings.terminal.cursorStyleDescription')}
              >
                <Select
                  value={terminalCursorStyle}
                  onValueChange={(value) => setTerminalCursorStyle(value as TerminalCursorStyle)}
                >
                  <SelectTrigger size="sm" aria-label={t('settings.terminal.cursorStyle')}>
                    <SelectValue>{t(`settings.terminal.cursorStyle.${terminalCursorStyle}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(['block', 'underline', 'bar'] as const).map((style) => (
                        <SelectItem key={style} value={style}>
                          {t(`settings.terminal.cursorStyle.${style}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.terminal.cursorBlink')}
                description={t('settings.terminal.cursorBlinkDescription')}
              >
                <div className="flex justify-end">
                  <Switch
                    aria-label={t('settings.terminal.cursorBlink')}
                    checked={terminalCursorBlink}
                    onCheckedChange={setTerminalCursorBlink}
                  />
                </div>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.terminal.copyOnSelect')}
                description={t('settings.terminal.copyOnSelectDescription')}
              >
                <div className="flex justify-end">
                  <Switch
                    aria-label={t('settings.terminal.copyOnSelect')}
                    checked={terminalCopyOnSelect}
                    onCheckedChange={setTerminalCopyOnSelect}
                  />
                </div>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.terminal.scrollback')}
                description={t('settings.terminal.scrollbackDescription')}
              >
                <Select
                  value={String(terminalScrollback)}
                  onValueChange={(value) => setTerminalScrollback(Number(value))}
                >
                  <SelectTrigger size="sm" aria-label={t('settings.terminal.scrollback')}>
                    <SelectValue>
                      {t('settings.terminal.scrollbackValue', {
                        count: terminalScrollback.toLocaleString(),
                      })}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {[1000, 5000, 10000, 50000].map((lines) => (
                        <SelectItem key={lines} value={String(lines)}>
                          {t('settings.terminal.scrollbackValue', { count: lines.toLocaleString() })}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
            </CardContent>
          </Card>

          <Card size="sm" className="rounded-lg">
            <CardHeader>
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Settings2Icon />
                </div>
                <div className="flex flex-col gap-1">
                  <CardTitle>{t('settings.general.title')}</CardTitle>
                  <CardDescription>{t('settings.general.description')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Separator />
              <SettingRow
                label={t('settings.general.startupSection')}
                description={t('settings.general.startupSectionDescription')}
              >
                <Select
                  value={startupSection}
                  onValueChange={(value) => setStartupSection(value as AppSection)}
                >
                  <SelectTrigger size="sm" aria-label={t('settings.general.startupSection')}>
                    <SelectValue>{t(`settings.general.startupSection.${startupSection}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(['workbench', 'terminal', 'sftp'] as const).map((section) => (
                        <SelectItem key={section} value={section}>
                          {t(`settings.general.startupSection.${section}`)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </SettingRow>
              <Separator />
              <SettingRow
                label={t('settings.general.startupUpdateCheck')}
                description={t('settings.general.startupUpdateCheckDescription')}
              >
                <div className="flex justify-end">
                  <Switch
                    aria-label={t('settings.general.startupUpdateCheck')}
                    checked={startupUpdateCheck}
                    onCheckedChange={setStartupUpdateCheck}
                  />
                </div>
              </SettingRow>
            </CardContent>
          </Card>

          <Card size="sm" className="rounded-lg">
            <CardHeader>
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <FolderCogIcon />
                </div>
                <div className="flex flex-col gap-1">
                  <CardTitle>{t('settings.sftp.title')}</CardTitle>
                  <CardDescription>{t('settings.sftp.description')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <Separator />
              <SettingRow
                label={t('settings.sftp.showHiddenFiles')}
                description={t('settings.sftp.showHiddenFilesDescription')}
              >
                <div className="flex justify-end">
                  <Switch
                    aria-label={t('settings.sftp.showHiddenFiles')}
                    checked={sftpShowHiddenFiles}
                    onCheckedChange={setSftpShowHiddenFiles}
                  />
                </div>
              </SettingRow>
            </CardContent>
          </Card>

          <Card size="sm" className="rounded-lg">
            <CardHeader>
              <div className="flex items-start gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyboardIcon />
                </div>
                <div className="flex flex-col gap-1">
                  <CardTitle>{t('settings.shortcuts.title')}</CardTitle>
                  <CardDescription>{t('settings.shortcuts.description')}</CardDescription>
                </div>
              </div>
              <CardAction>
                <Button variant="ghost" size="sm" onClick={resetShortcuts}>
                  <RotateCcwIcon data-icon="inline-start" />
                  {t('settings.shortcuts.resetAll')}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="p-0">
              <Separator />
              {SHORTCUT_ACTIONS.map((action, index) => (
                <React.Fragment key={action}>
                  {index > 0 && <Separator />}
                  <div className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm font-medium">{shortcutLabels[action]}</span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-24"
                        onClick={() => {
                          setConflictAction(null);
                          setEditingAction(action);
                        }}
                      >
                        <ShortcutKeys shortcut={shortcuts[action]} />
                      </Button>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={shortcuts[action] === DEFAULT_SHORTCUTS[action]}
                              aria-label={t('settings.shortcuts.resetOne', { action: shortcutLabels[action] })}
                            />
                          }
                          onClick={() => resetShortcut(action)}
                        >
                          <RotateCcwIcon />
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.shortcuts.reset')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </React.Fragment>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={editingAction !== null} onOpenChange={(open) => { if (!open) closeRecorder(); }}>
        <DialogContent className="max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('settings.shortcuts.recordTitle')}</DialogTitle>
            <DialogDescription>
              {editingAction ? shortcutLabels[editingAction] : ''}
            </DialogDescription>
          </DialogHeader>
          <div
            role="button"
            tabIndex={0}
            autoFocus
            onKeyDown={handleShortcutCapture}
            className="flex min-h-24 flex-col items-center justify-center gap-2.5 rounded-md border border-dashed bg-muted/40 px-4 text-center outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <KeyboardIcon className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t('settings.shortcuts.recordPrompt')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.shortcuts.recordHint')}</p>
          </div>
          {conflictAction && (
            <p role="alert" className="text-xs text-destructive">
              {t('settings.shortcuts.conflict', { action: shortcutLabels[conflictAction] })}
            </p>
          )}
        </DialogContent>
      </Dialog>
      </div>
    </TooltipProvider>
  );
};
