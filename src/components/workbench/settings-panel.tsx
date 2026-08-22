import React, { useMemo, useRef, useState } from 'react';
import { BotIcon, FolderCogIcon, Globe2Icon, KeyboardIcon, PaletteIcon, RotateCcwIcon, Settings2Icon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { findShortcutConflict, getShortcutKeys, isLeaderShortcutAction, shortcutFromBareKeyEvent, shortcutFromKeyboardEvent } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UpdateSection } from './update-section';
import type {
  AppSection,
  Locale,
  SftpConflictPolicy,
  ShortcutAction,
  TerminalBellStyle,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalFontFamily,
  TerminalRightClickBehavior,
  ThemeMode,
} from '@/types';
import { invokePickLocalFolder } from '@/lib/tauri';
import type { LocaleKey } from '@/locales';
import { AiSettingsSection } from '@/components/ai/ai-settings-section';

interface ShortcutGroup {
  id: 'app' | 'terminal' | 'sftp';
  actions: ShortcutAction[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'app',
    actions: ['openWorkbench', 'openTerminal', 'openSftp', 'openSettings', 'toggleAiPanel'],
  },
  {
    id: 'terminal',
    actions: [
      'newTerminalTab',
      'closeTerminalTab',
      'nextTerminalTab',
      'previousTerminalTab',
      'findTerminal',
      'terminalLeader',
      'terminalFocusLeft',
      'terminalFocusDown',
      'terminalFocusUp',
      'terminalFocusRight',
      'terminalSplitRight',
      'terminalSplitDown',
      'terminalClosePane',
    ],
  },
  {
    id: 'sftp',
    actions: ['newSftpConnection'],
  },
];

const SHORTCUT_GROUP_LABEL_KEYS: Record<ShortcutGroup['id'], LocaleKey> = {
  app: 'settings.shortcuts.groupApp',
  terminal: 'settings.shortcuts.groupTerminal',
  sftp: 'settings.shortcuts.groupSftp',
};

type SettingsSection = 'appearance' | 'general' | 'terminal' | 'sftp' | 'ai' | 'shortcuts';

const SETTINGS_SECTIONS: { id: SettingsSection; icon: React.ElementType; titleKey: LocaleKey }[] = [
  { id: 'general', icon: Settings2Icon, titleKey: 'settings.general.title' },
  { id: 'appearance', icon: PaletteIcon, titleKey: 'settings.appearance.title' },
  { id: 'terminal', icon: SquareTerminalIcon, titleKey: 'settings.terminal.title' },
  { id: 'sftp', icon: FolderCogIcon, titleKey: 'settings.sftp.title' },
  { id: 'ai', icon: BotIcon, titleKey: 'settings.ai.title' },
  { id: 'shortcuts', icon: KeyboardIcon, titleKey: 'settings.shortcuts.title' },
];

interface SettingRowProps {
  description: string;
  label: string;
  children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({ description, label, children }) => (
  <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_11rem] items-center gap-6 px-4 py-2.5">
    <div className="flex min-w-0 flex-col gap-0.5">
      <Label className="text-sm font-medium text-foreground">{label}</Label>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
    <div>{children}</div>
  </div>
);

const SettingGroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
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
  const terminalColorScheme = useAppStore((state) => state.terminalColorScheme);
  const setTerminalColorScheme = useAppStore((state) => state.setTerminalColorScheme);
  const terminalMultiLinePasteWarning = useAppStore((state) => state.terminalMultiLinePasteWarning);
  const setTerminalMultiLinePasteWarning = useAppStore((state) => state.setTerminalMultiLinePasteWarning);
  const terminalLargePasteWarning = useAppStore((state) => state.terminalLargePasteWarning);
  const setTerminalLargePasteWarning = useAppStore((state) => state.setTerminalLargePasteWarning);
  const terminalAutoReconnect = useAppStore((state) => state.terminalAutoReconnect);
  const setTerminalAutoReconnect = useAppStore((state) => state.setTerminalAutoReconnect);
  const terminalLineHeight = useAppStore((state) => state.terminalLineHeight);
  const setTerminalLineHeight = useAppStore((state) => state.setTerminalLineHeight);
  const terminalLetterSpacing = useAppStore((state) => state.terminalLetterSpacing);
  const setTerminalLetterSpacing = useAppStore((state) => state.setTerminalLetterSpacing);
  const terminalUrlDetection = useAppStore((state) => state.terminalUrlDetection);
  const setTerminalUrlDetection = useAppStore((state) => state.setTerminalUrlDetection);
  const terminalTrimTrailingWhitespace = useAppStore((state) => state.terminalTrimTrailingWhitespace);
  const setTerminalTrimTrailingWhitespace = useAppStore((state) => state.setTerminalTrimTrailingWhitespace);
  const terminalRightClickBehavior = useAppStore((state) => state.terminalRightClickBehavior);
  const setTerminalRightClickBehavior = useAppStore((state) => state.setTerminalRightClickBehavior);
  const terminalBellStyle = useAppStore((state) => state.terminalBellStyle);
  const setTerminalBellStyle = useAppStore((state) => state.setTerminalBellStyle);
  const confirmBeforeExit = useAppStore((state) => state.confirmBeforeExit);
  const setConfirmBeforeExit = useAppStore((state) => state.setConfirmBeforeExit);
  const restoreWorkspace = useAppStore((state) => state.restoreWorkspace);
  const setRestoreWorkspace = useAppStore((state) => state.setRestoreWorkspace);
  const sftpShowHiddenFiles = useAppStore((state) => state.sftpShowHiddenFiles);
  const setSftpShowHiddenFiles = useAppStore((state) => state.setSftpShowHiddenFiles);
  const sftpConflictPolicy = useAppStore((state) => state.sftpConflictPolicy);
  const setSftpConflictPolicy = useAppStore((state) => state.setSftpConflictPolicy);
  const sftpRetryCount = useAppStore((state) => state.sftpRetryCount);
  const setSftpRetryCount = useAppStore((state) => state.setSftpRetryCount);
  const sftpDownloadDirectory = useAppStore((state) => state.sftpDownloadDirectory);
  const setSftpDownloadDirectory = useAppStore((state) => state.setSftpDownloadDirectory);
  const sftpCompletionNotification = useAppStore((state) => state.sftpCompletionNotification);
  const setSftpCompletionNotification = useAppStore((state) => state.setSftpCompletionNotification);
  const terminalHideSingleTabBar = useAppStore((state) => state.terminalHideSingleTabBar);
  const setTerminalHideSingleTabBar = useAppStore((state) => state.setTerminalHideSingleTabBar);
  const sftpHideSingleTabBar = useAppStore((state) => state.sftpHideSingleTabBar);
  const setSftpHideSingleTabBar = useAppStore((state) => state.setSftpHideSingleTabBar);
  const shortcuts = useAppStore((state) => state.shortcuts);
  const setShortcut = useAppStore((state) => state.setShortcut);
  const resetShortcut = useAppStore((state) => state.resetShortcut);
  const resetShortcuts = useAppStore((state) => state.resetShortcuts);
  const [editingAction, setEditingAction] = useState<ShortcutAction | null>(null);
  const [conflictAction, setConflictAction] = useState<ShortcutAction | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const settingsViewportRef = useRef<HTMLDivElement>(null);

  const handleSectionChange = (value: string): void => {
    if (value === activeSection) return;
    if (settingsViewportRef.current) settingsViewportRef.current.scrollTop = 0;
    setActiveSection(value as SettingsSection);
  };

  const shortcutLabels = useMemo<Record<ShortcutAction, string>>(
    () => ({
      openWorkbench: t('settings.shortcuts.openWorkbench'),
      openTerminal: t('settings.shortcuts.openTerminal'),
      openSftp: t('settings.shortcuts.openSftp'),
      openSettings: t('settings.shortcuts.openSettings'),
      toggleAiPanel: t('settings.shortcuts.toggleAiPanel'),
      newTerminalTab: t('settings.shortcuts.newTerminalTab'),
      closeTerminalTab: t('settings.shortcuts.closeTerminalTab'),
      nextTerminalTab: t('settings.shortcuts.nextTerminalTab'),
      previousTerminalTab: t('settings.shortcuts.previousTerminalTab'),
      findTerminal: t('settings.shortcuts.findTerminal'),
      newSftpConnection: t('settings.shortcuts.newSftpConnection'),
      terminalLeader: t('settings.shortcuts.terminalLeader'),
      terminalFocusLeft: t('settings.shortcuts.terminalFocusLeft'),
      terminalFocusDown: t('settings.shortcuts.terminalFocusDown'),
      terminalFocusUp: t('settings.shortcuts.terminalFocusUp'),
      terminalFocusRight: t('settings.shortcuts.terminalFocusRight'),
      terminalSplitRight: t('settings.shortcuts.terminalSplitRight'),
      terminalSplitDown: t('settings.shortcuts.terminalSplitDown'),
      terminalClosePane: t('settings.shortcuts.terminalClosePane'),
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
    if (!editingAction) return;

    // Leader sub-keys are bare keys; everything else records a modifier chord.
    // The leader binding keeps Control literal (ctrl stays off the Cmd/mod
    // namespace so a tmux-style Ctrl+B never collides with Cmd shortcuts).
    const shortcut = isLeaderShortcutAction(editingAction)
      ? shortcutFromBareKeyEvent(event.nativeEvent)
      : shortcutFromKeyboardEvent(event.nativeEvent, editingAction === 'terminalLeader');
    if (!shortcut) return;

    const conflict = findShortcutConflict({ ...DEFAULT_SHORTCUTS, ...shortcuts }, editingAction, shortcut);
    if (conflict) {
      setConflictAction(conflict);
      return;
    }

    setShortcut(editingAction, shortcut);
    closeRecorder();
  };

  return (
    <TooltipProvider>
      <Tabs value={activeSection} onValueChange={handleSectionChange} className="h-full min-h-0 gap-0 overflow-hidden bg-background">
        <header className="flex shrink-0 items-center border-b border-app-border/50 px-3 py-1.5">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-app-text">{t('workbench.settings.title')}</h1>
            <p className="text-xs text-muted-foreground">{t('settings.description')}</p>
          </div>
        </header>

        <div className="shrink-0 border-b border-app-border/50">
          <ScrollArea horizontal vertical={false} size="thin" className="h-9 w-full">
            <TabsList
              aria-label={t('settings.sectionNavigation')}
              variant="line"
              className="min-w-max justify-start group-data-horizontal/tabs:h-9"
            >
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon;
                return (
                  <TabsTrigger key={section.id} value={section.id} className="flex-none px-2.5 text-[13px]">
                    <Icon data-icon="inline-start" />
                    {t(section.titleKey)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </ScrollArea>
        </div>

        <ScrollArea viewportRef={settingsViewportRef} className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-4xl flex-col p-3">
            <TabsContent value="appearance" className="w-full">
              <div>
                <div className="px-3 pb-2 pt-1">
                  <p className="text-xs text-muted-foreground">{t('settings.appearance.description')}</p>
                </div>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.appearance.theme')} description={t('settings.appearance.themeDescription')}>
                  <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
                    <SelectTrigger size="sm" aria-label={t('settings.appearance.theme')}>
                      <SelectValue>{theme === 'light' ? t('theme.light') : theme === 'dark' ? t('theme.dark') : t('theme.system')}</SelectValue>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.appearance.language')} description={t('settings.appearance.languageDescription')}>
                  <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                    <SelectTrigger size="sm" aria-label={t('settings.appearance.language')}>
                      <Globe2Icon />
                      <SelectValue>{locale === 'zh-CN' ? t('locale.zh-CN') : t('locale.en-US')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="zh-CN">{t('locale.zh-CN')}</SelectItem>
                        <SelectItem value="en-US">{t('locale.en-US')}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="general" className="w-full">
              <div>
                <div className="px-3 pb-2 pt-1">
                  <p className="text-xs text-muted-foreground">{t('settings.general.description')}</p>
                </div>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.general.startupSection')} description={t('settings.general.startupSectionDescription')}>
                  <Select value={startupSection} onValueChange={(value) => setStartupSection(value as AppSection)}>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.general.startupUpdateCheck')} description={t('settings.general.startupUpdateCheckDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.general.startupUpdateCheck')}
                      checked={startupUpdateCheck}
                      onCheckedChange={setStartupUpdateCheck}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.general.confirmBeforeExit')} description={t('settings.general.confirmBeforeExitDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.general.confirmBeforeExit')} checked={confirmBeforeExit} onCheckedChange={setConfirmBeforeExit} />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.general.restoreWorkspace')} description={t('settings.general.restoreWorkspaceDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.general.restoreWorkspace')} checked={restoreWorkspace} onCheckedChange={setRestoreWorkspace} />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <UpdateSection />
              </div>
            </TabsContent>

            <TabsContent value="terminal" className="w-full">
              <div>
                <div className="px-3 pb-2 pt-1">
                  <p className="text-xs text-muted-foreground">{t('settings.terminal.description')}</p>
                </div>
                <Separator className="data-horizontal:border-border/40" />
                <SettingGroupLabel>{t('settings.terminal.groupAppearance')}</SettingGroupLabel>
                <SettingRow label={t('settings.terminal.fontFamily')} description={t('settings.terminal.fontFamilyDescription')}>
                  <Select value={terminalFontFamily} onValueChange={(value) => setTerminalFontFamily(value as TerminalFontFamily)}>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.colorScheme')} description={t('settings.terminal.colorSchemeDescription')}>
                  <Select value={terminalColorScheme} onValueChange={(value) => setTerminalColorScheme(value as TerminalColorScheme)}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.colorScheme')}>
                      <SelectValue>{t(`settings.terminal.colorScheme.${terminalColorScheme}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(['app', 'oneDark', 'solarizedDark', 'light'] as const).map((scheme) => (
                          <SelectItem key={scheme} value={scheme}>
                            {t(`settings.terminal.colorScheme.${scheme}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.fontSize')} description={t('settings.terminal.fontSizeDescription')}>
                  <Select value={String(terminalFontSize)} onValueChange={(value) => setTerminalFontSize(Number(value))}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.fontSize')}>
                      <SelectValue>{t('settings.terminal.fontSizeValue', { size: terminalFontSize })}</SelectValue>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.lineHeight')} description={t('settings.terminal.lineHeightDescription')}>
                  <Select value={String(terminalLineHeight)} onValueChange={(value) => setTerminalLineHeight(Number(value))}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.lineHeight')}>
                      <SelectValue>{t('settings.terminal.lineHeightValue', { value: terminalLineHeight })}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[1, 1.1, 1.2, 1.4].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {t('settings.terminal.lineHeightValue', { value })}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.letterSpacing')} description={t('settings.terminal.letterSpacingDescription')}>
                  <Select value={String(terminalLetterSpacing)} onValueChange={(value) => setTerminalLetterSpacing(Number(value))}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.letterSpacing')}>
                      <SelectValue>{t('settings.terminal.letterSpacingValue', { value: terminalLetterSpacing })}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[0, 1, 2].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {t('settings.terminal.letterSpacingValue', { value })}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.cursorStyle')} description={t('settings.terminal.cursorStyleDescription')}>
                  <Select value={terminalCursorStyle} onValueChange={(value) => setTerminalCursorStyle(value as TerminalCursorStyle)}>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingGroupLabel>{t('settings.terminal.groupInteraction')}</SettingGroupLabel>
                <SettingRow label={t('settings.terminal.cursorBlink')} description={t('settings.terminal.cursorBlinkDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.terminal.cursorBlink')} checked={terminalCursorBlink} onCheckedChange={setTerminalCursorBlink} />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.copyOnSelect')} description={t('settings.terminal.copyOnSelectDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.copyOnSelect')}
                      checked={terminalCopyOnSelect}
                      onCheckedChange={setTerminalCopyOnSelect}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow
                  label={t('settings.terminal.trimTrailingWhitespace')}
                  description={t('settings.terminal.trimTrailingWhitespaceDescription')}
                >
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.trimTrailingWhitespace')}
                      checked={terminalTrimTrailingWhitespace}
                      onCheckedChange={setTerminalTrimTrailingWhitespace}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.rightClickBehavior')} description={t('settings.terminal.rightClickBehaviorDescription')}>
                  <Select
                    value={terminalRightClickBehavior}
                    onValueChange={(value) => setTerminalRightClickBehavior(value as TerminalRightClickBehavior)}
                  >
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.rightClickBehavior')}>
                      <SelectValue>{t(`settings.terminal.rightClickBehavior.${terminalRightClickBehavior}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(['paste', 'copyPaste', 'none'] as const).map((behavior) => (
                          <SelectItem key={behavior} value={behavior}>
                            {t(`settings.terminal.rightClickBehavior.${behavior}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.urlDetection')} description={t('settings.terminal.urlDetectionDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.urlDetection')}
                      checked={terminalUrlDetection}
                      onCheckedChange={setTerminalUrlDetection}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.bellStyle')} description={t('settings.terminal.bellStyleDescription')}>
                  <Select value={terminalBellStyle} onValueChange={(value) => setTerminalBellStyle(value as TerminalBellStyle)}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.bellStyle')}>
                      <SelectValue>{t(`settings.terminal.bellStyle.${terminalBellStyle}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(['none', 'sound'] as const).map((style) => (
                          <SelectItem key={style} value={style}>
                            {t(`settings.terminal.bellStyle.${style}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.scrollback')} description={t('settings.terminal.scrollbackDescription')}>
                  <Select value={String(terminalScrollback)} onValueChange={(value) => setTerminalScrollback(Number(value))}>
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
                <Separator className="data-horizontal:border-border/40" />
                <SettingGroupLabel>{t('settings.terminal.groupSafety')}</SettingGroupLabel>
                <SettingRow
                  label={t('settings.terminal.multiLinePasteWarning')}
                  description={t('settings.terminal.multiLinePasteWarningDescription')}
                >
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.multiLinePasteWarning')}
                      checked={terminalMultiLinePasteWarning}
                      onCheckedChange={setTerminalMultiLinePasteWarning}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.largePasteWarning')} description={t('settings.terminal.largePasteWarningDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.largePasteWarning')}
                      checked={terminalLargePasteWarning}
                      onCheckedChange={setTerminalLargePasteWarning}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingGroupLabel>{t('settings.terminal.groupSessions')}</SettingGroupLabel>
                <SettingRow label={t('settings.terminal.autoReconnect')} description={t('settings.terminal.autoReconnectDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.autoReconnect')}
                      checked={terminalAutoReconnect}
                      onCheckedChange={setTerminalAutoReconnect}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.terminal.hideSingleTabBar')} description={t('settings.terminal.hideSingleTabBarDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.hideSingleTabBar')}
                      checked={terminalHideSingleTabBar}
                      onCheckedChange={setTerminalHideSingleTabBar}
                    />
                  </div>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="sftp" className="w-full">
              <div>
                <div className="px-3 pb-2 pt-1">
                  <p className="text-xs text-muted-foreground">{t('settings.sftp.description')}</p>
                </div>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.showHiddenFiles')} description={t('settings.sftp.showHiddenFilesDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.sftp.showHiddenFiles')} checked={sftpShowHiddenFiles} onCheckedChange={setSftpShowHiddenFiles} />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.conflictPolicy')} description={t('settings.sftp.conflictPolicyDescription')}>
                  <Select value={sftpConflictPolicy} onValueChange={(value) => setSftpConflictPolicy(value as SftpConflictPolicy)}>
                    <SelectTrigger size="sm" aria-label={t('settings.sftp.conflictPolicy')}>
                      <SelectValue>{t(`settings.sftp.conflictPolicy.${sftpConflictPolicy}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(['ask', 'overwrite', 'skip'] as const).map((policy) => (
                          <SelectItem key={policy} value={policy}>
                            {t(`settings.sftp.conflictPolicy.${policy}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.retryCount')} description={t('settings.sftp.retryCountDescription')}>
                  <Select value={String(sftpRetryCount)} onValueChange={(value) => setSftpRetryCount(Number(value))}>
                    <SelectTrigger size="sm" aria-label={t('settings.sftp.retryCount')}>
                      <SelectValue>{t('settings.sftp.retryCountValue', { count: sftpRetryCount })}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {[0, 1, 3].map((count) => (
                          <SelectItem key={count} value={String(count)}>
                            {t('settings.sftp.retryCountValue', { count })}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.downloadDirectory')} description={t('settings.sftp.downloadDirectoryDescription')}>
                  <div className="flex gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            className="min-w-0 flex-1 justify-start"
                            onClick={() => {
                              void invokePickLocalFolder().then((folders) => {
                                if (folders[0]) setSftpDownloadDirectory(folders[0]);
                              });
                            }}
                          />
                        }
                      >
                        <span className="truncate">{sftpDownloadDirectory || t('settings.sftp.downloadDirectoryAsk')}</span>
                      </TooltipTrigger>
                      <TooltipContent className="break-all">{sftpDownloadDirectory || t('settings.sftp.downloadDirectoryAsk')}</TooltipContent>
                    </Tooltip>
                    {sftpDownloadDirectory && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        aria-label={t('settings.sftp.downloadDirectoryClear')}
                        onClick={() => setSftpDownloadDirectory('')}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.completionNotification')} description={t('settings.sftp.completionNotificationDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.sftp.completionNotification')}
                      checked={sftpCompletionNotification}
                      onCheckedChange={setSftpCompletionNotification}
                    />
                  </div>
                </SettingRow>
                <Separator className="data-horizontal:border-border/40" />
                <SettingRow label={t('settings.sftp.hideSingleTabBar')} description={t('settings.sftp.hideSingleTabBarDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.sftp.hideSingleTabBar')}
                      checked={sftpHideSingleTabBar}
                      onCheckedChange={setSftpHideSingleTabBar}
                    />
                  </div>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="ai" className="w-full">
              <AiSettingsSection />
            </TabsContent>

            <TabsContent value="shortcuts" className="w-full">
              <div>
                <div className="flex items-center justify-between gap-4 px-3 pb-2 pt-1">
                  <p className="min-w-0 text-xs text-muted-foreground">{t('settings.shortcuts.description')}</p>
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={resetShortcuts}>
                    <RotateCcwIcon data-icon="inline-start" />
                    {t('settings.shortcuts.resetAll')}
                  </Button>
                </div>
                <Separator className="data-horizontal:border-border/40" />
                {SHORTCUT_GROUPS.map((group) => (
                  <React.Fragment key={group.id}>
                    <div className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t(SHORTCUT_GROUP_LABEL_KEYS[group.id])}
                    </div>
                    {group.actions.map((action, index) => {
                      const binding = shortcuts[action] ?? DEFAULT_SHORTCUTS[action];
                      const leaderBinding = shortcuts.terminalLeader ?? DEFAULT_SHORTCUTS.terminalLeader;
                      return (
                        <React.Fragment key={action}>
                          {index > 0 && <Separator className="data-horizontal:border-border/40" />}
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
                                {isLeaderShortcutAction(action) ? (
                                  <span className="flex items-center gap-1.5">
                                    <ShortcutKeys shortcut={leaderBinding} />
                                    <span aria-hidden="true" className="text-muted-foreground">
                                      →
                                    </span>
                                    <ShortcutKeys shortcut={binding} />
                                  </span>
                                ) : (
                                  <ShortcutKeys shortcut={binding} />
                                )}
                              </Button>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      disabled={binding === DEFAULT_SHORTCUTS[action]}
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
                      );
                    })}
                    <Separator className="data-horizontal:border-border/40" />
                  </React.Fragment>
                ))}
              </div>
            </TabsContent>
          </div>
        </ScrollArea>

        <Dialog
          open={editingAction !== null}
          onOpenChange={(open) => {
            if (!open) closeRecorder();
          }}
        >
          <DialogContent className="max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t('settings.shortcuts.recordTitle')}</DialogTitle>
              <DialogDescription>{editingAction ? shortcutLabels[editingAction] : ''}</DialogDescription>
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
              <p className="text-xs text-muted-foreground">
                {editingAction && isLeaderShortcutAction(editingAction)
                  ? t('settings.shortcuts.recordHintBareKey')
                  : t('settings.shortcuts.recordHint')}
              </p>
            </div>
            {conflictAction && (
              <p role="alert" className="text-xs text-destructive">
                {t('settings.shortcuts.conflict', { action: shortcutLabels[conflictAction] })}
              </p>
            )}
          </DialogContent>
        </Dialog>
      </Tabs>
    </TooltipProvider>
  );
};
