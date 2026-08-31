import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BotIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  FolderCogIcon,
  FolderOpenIcon,
  Globe2Icon,
  KeyboardIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCcwIcon,
  Settings2Icon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { usePlatform } from '@/hooks/usePlatform';
import { findShortcutConflict, getShortcutKeys, isLeaderShortcutAction, shortcutFromBareKeyEvent, shortcutFromKeyboardEvent } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UpdateSection } from './update-section';
import { TERMINAL_COLOR_SCHEME_IDS } from '@/types';
import type {
  AppSection,
  Locale,
  SettingsSection,
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
import { clearTerminalWorkspace } from '@/lib/terminal-workspace-persistence';
import { clearSftpWorkspace } from '@/lib/sftp-workspace-persistence';
import { getPetdexStatus, listenToPetdexStatus, testPetdexConnection } from '@/lib/petdex';
import { openPetdexPhase3Feedback } from '@/lib/petdex-feedback';
import type { PetdexConnectionStatus } from '@/types';

interface ShortcutGroup {
  id: 'app' | 'terminal' | 'sftp';
  actions: ShortcutAction[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'app',
    actions: ['openWorkbench', 'openTerminal', 'openSftp', 'openSettings', 'openCommandPalette', 'toggleAiPanel'],
  },
  {
    id: 'terminal',
    actions: [
      'newTerminalTab',
      'closeTerminalTab',
      'switchTerminalTab',
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

const SETTINGS_SECTIONS: {
  id: SettingsSection;
  icon: React.ElementType;
  titleKey: LocaleKey;
  descriptionKey: LocaleKey;
}[] = [
  { id: 'general', icon: Settings2Icon, titleKey: 'settings.general.title', descriptionKey: 'settings.general.description' },
  { id: 'appearance', icon: PaletteIcon, titleKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description' },
  { id: 'terminal', icon: SquareTerminalIcon, titleKey: 'settings.terminal.title', descriptionKey: 'settings.terminal.description' },
  { id: 'sftp', icon: FolderCogIcon, titleKey: 'settings.sftp.title', descriptionKey: 'settings.sftp.description' },
  { id: 'ai', icon: BotIcon, titleKey: 'settings.ai.title', descriptionKey: 'settings.ai.description' },
  { id: 'shortcuts', icon: KeyboardIcon, titleKey: 'settings.shortcuts.title', descriptionKey: 'settings.shortcuts.description' },
  { id: 'experimental', icon: FlaskConicalIcon, titleKey: 'settings.experimental.title', descriptionKey: 'settings.experimental.description' },
];

const PETDEX_STATUS_LABEL_KEYS: Record<PetdexConnectionStatus, LocaleKey> = {
  notDetected: 'settings.experimental.petdex.status.notDetected',
  connected: 'settings.experimental.petdex.status.connected',
  notRunning: 'settings.experimental.petdex.status.notRunning',
  connectionError: 'settings.experimental.petdex.status.connectionError',
};

interface SettingRowProps {
  className?: string;
  description: string;
  descriptionId?: string;
  label: string;
  labelId?: string;
  children: React.ReactNode;
}

const SettingRow: React.FC<SettingRowProps> = ({
  children,
  className,
  description,
  descriptionId,
  label,
  labelId,
}) => (
  <Field
    className={cn(
      'min-h-20 gap-3 px-5 py-4 @min-[34rem]:flex-row @min-[34rem]:items-center @min-[34rem]:justify-between @min-[34rem]:gap-6',
      className,
    )}
  >
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <FieldLabel id={labelId} className="text-sm font-medium text-foreground">
        {label}
      </FieldLabel>
      <FieldDescription id={descriptionId} className="leading-5">
        {description}
      </FieldDescription>
    </div>
    <div
      data-slot="setting-control"
      className="flex min-h-8 w-full items-center justify-start @min-[34rem]:w-auto @min-[34rem]:shrink-0 @min-[34rem]:justify-end"
    >
      {children}
    </div>
  </Field>
);

interface SettingGroupLabelProps {
  children: React.ReactNode;
}

const SettingGroupLabel: React.FC<SettingGroupLabelProps> = () => null;

const SettingsGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const groups: Array<{ rows: React.ReactNode[]; title?: React.ReactNode }> = [];
  let currentGroup: { rows: React.ReactNode[]; title?: React.ReactNode } = { rows: [] };

  React.Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (
      React.isValidElement<SettingGroupLabelProps>(child)
      && child.type === SettingGroupLabel
    ) {
      if (currentGroup.rows.length > 0) groups.push(currentGroup);
      currentGroup = { rows: [], title: child.props.children };
      return;
    }
    currentGroup.rows.push(child);
  });

  if (currentGroup.rows.length > 0) groups.push(currentGroup);

  return (
    <div data-slot="settings-groups" className="flex flex-col gap-6">
      {groups.map((group, groupIndex) => (
        <section
          key={groupIndex}
          data-slot="settings-group"
          className="flex min-w-0 flex-col gap-2.5"
        >
          {group.title && (
            <h3 className="px-1 text-sm font-semibold text-foreground">{group.title}</h3>
          )}
          <Card variant="outline" className="gap-0 py-0">
            <CardContent className="px-0">
              <FieldGroup className="gap-0">
                {group.rows.map((row, rowIndex) => (
                  <React.Fragment key={rowIndex}>
                    {rowIndex > 0 && <Separator />}
                    {row}
                  </React.Fragment>
                ))}
              </FieldGroup>
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
};

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

interface SettingsPanelProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  open = true,
  onOpenChange = () => undefined,
}) => {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const startupUpdateCheck = useAppStore((state) => state.startupUpdateCheck);
  const setStartupUpdateCheck = useAppStore((state) => state.setStartupUpdateCheck);
  const petdexEnabled = useAppStore((state) => state.petdexEnabled);
  const petdexRequestedEnabled = useAppStore((state) => state.petdexRequestedEnabled);
  const petdexConfiguring = useAppStore((state) => state.petdexConfiguring);
  const setPetdexEnabled = useAppStore((state) => state.setPetdexEnabled);
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
  const [petdexStatus, setPetdexStatus] = useState<PetdexConnectionStatus>('notDetected');
  const [testingPetdex, setTestingPetdex] = useState(false);
  const activeSection = useAppStore((state) => state.activeSettingsSection);
  const setActiveSection = useAppStore((state) => state.setActiveSettingsSection);
  const activeSectionMeta = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0];
  const settingsViewportRef = useRef<HTMLDivElement>(null);
  const petdexMountedRef = useRef(true);
  const petdexOperationRevisionRef = useRef(0);
  const petdexLiveStatusRevisionRef = useRef(0);
  const displayedPetdexEnabled = petdexRequestedEnabled ?? petdexEnabled;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    petdexMountedRef.current = true;
    void (async () => {
      try {
        const dispose = await listenToPetdexStatus((status) => {
          petdexLiveStatusRevisionRef.current += 1;
          if (active) setPetdexStatus(status);
        });
        if (!active) {
          dispose();
          return;
        }
        unlisten = dispose;
        const liveRevision = petdexLiveStatusRevisionRef.current;
        const operationRevision = petdexOperationRevisionRef.current;
        try {
          const status = await getPetdexStatus();
          if (
            active
            && liveRevision === petdexLiveStatusRevisionRef.current
            && operationRevision === petdexOperationRevisionRef.current
          ) {
            setPetdexStatus(status);
          }
        } catch {
          if (
            active
            && liveRevision === petdexLiveStatusRevisionRef.current
            && operationRevision === petdexOperationRevisionRef.current
          ) {
            setPetdexStatus('connectionError');
          }
        }
      } catch {
        if (active) setPetdexStatus('connectionError');
      }
    })();
    return () => {
      active = false;
      petdexMountedRef.current = false;
      petdexOperationRevisionRef.current += 1;
      unlisten?.();
    };
  }, []);

  const handleSectionChange = (value: string): void => {
    if (value === activeSection) return;
    if (settingsViewportRef.current) settingsViewportRef.current.scrollTop = 0;
    setActiveSection(value as SettingsSection);
  };

  const handleClearWorkspace = (): void => {
    setRestoreWorkspace(false);
    void Promise.all([clearTerminalWorkspace(), clearSftpWorkspace()]);
  };

  const handlePetdexEnabledChange = (enabled: boolean): void => {
    const operationRevision = ++petdexOperationRevisionRef.current;
    const liveRevision = petdexLiveStatusRevisionRef.current;
    setTestingPetdex(false);
    void setPetdexEnabled(enabled)
      .then((status) => {
        if (
          petdexMountedRef.current
          && operationRevision === petdexOperationRevisionRef.current
          && liveRevision === petdexLiveStatusRevisionRef.current
        ) {
          setPetdexStatus(status);
        }
      })
      .catch(() => {
        if (
          petdexMountedRef.current
          && operationRevision === petdexOperationRevisionRef.current
        ) {
          setPetdexStatus('connectionError');
        }
      });
  };

  const handleTestPetdex = async (): Promise<void> => {
    const operationRevision = ++petdexOperationRevisionRef.current;
    const liveRevision = petdexLiveStatusRevisionRef.current;
    setTestingPetdex(true);
    try {
      const status = await testPetdexConnection();
      if (
        petdexMountedRef.current
        && operationRevision === petdexOperationRevisionRef.current
        && liveRevision === petdexLiveStatusRevisionRef.current
      ) {
        setPetdexStatus(status);
      }
    } catch {
      if (
        petdexMountedRef.current
        && operationRevision === petdexOperationRevisionRef.current
      ) {
        setPetdexStatus('connectionError');
      }
    } finally {
      if (
        petdexMountedRef.current
        && operationRevision === petdexOperationRevisionRef.current
      ) {
        setTestingPetdex(false);
      }
    }
  };

  const shortcutLabels = useMemo<Record<ShortcutAction, string>>(
    () => ({
      openWorkbench: t('settings.shortcuts.openWorkbench'),
      openTerminal: t('settings.shortcuts.openTerminal'),
      openSftp: t('settings.shortcuts.openSftp'),
      openSettings: t('settings.shortcuts.openSettings'),
      openCommandPalette: t('settings.shortcuts.openCommandPalette'),
      toggleAiPanel: t('settings.shortcuts.toggleAiPanel'),
      newTerminalTab: t('settings.shortcuts.newTerminalTab'),
      closeTerminalTab: t('settings.shortcuts.closeTerminalTab'),
      switchTerminalTab: t('settings.shortcuts.switchTerminalTab'),
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

  const ActiveSectionIcon = activeSectionMeta.icon;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => onOpenChange(nextOpen)}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(52rem,calc(100vh-2rem))] w-[min(72rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-app-border/70 bg-card p-0 [&_[data-slot=input]]:h-8 [&_[data-slot=input-group]]:h-8 [&_[data-slot=select-trigger]]:h-8 [&_[data-slot=select-trigger]]:min-w-36 sm:rounded-xl"
      >
        <TooltipProvider>
          <DialogHeader className="flex-row items-center gap-3 border-b border-app-border/50 bg-card/80 px-5 py-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Settings2Icon className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-lg">{t('workbench.settings.title')}</DialogTitle>
              <DialogDescription className="mt-1 text-xs">{t('settings.description')}</DialogDescription>
            </div>
            <DialogClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('common.close')}
                />
              }
            >
              <XIcon />
            </DialogClose>
          </DialogHeader>

          <Tabs
            value={activeSection}
            onValueChange={handleSectionChange}
            orientation="vertical"
            className="@container min-h-0 flex-1 flex-row gap-0 overflow-hidden"
          >
            <aside className="flex w-52 shrink-0 flex-col border-r border-app-border/50 bg-muted/30 p-3">
            <TabsList
              aria-label={t('settings.sectionNavigation')}
              aria-orientation="vertical"
              className="h-auto w-full flex-col items-stretch justify-start gap-1 rounded-none bg-transparent p-0"
            >
              {SETTINGS_SECTIONS.map((section) => {
                const Icon = section.icon;
                return (
                  <TabsTrigger key={section.id} value={section.id} className="h-9 flex-none justify-start px-3 text-[13px]">
                    <Icon data-icon="inline-start" />
                    {t(section.titleKey)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col bg-background">
              <div className="flex shrink-0 items-center gap-3 border-b border-app-border/40 px-5 py-3.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <ActiveSectionIcon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{t(activeSectionMeta.titleKey)}</h2>
                  <p className="truncate text-xs text-muted-foreground">{t(activeSectionMeta.descriptionKey)}</p>
                </div>
              </div>

              <ScrollArea viewportRef={settingsViewportRef} className="min-h-0 flex-1">
                <div className="@container mx-auto w-full max-w-4xl p-4 @min-[44rem]:p-6">
            <TabsContent value="appearance" className="w-full">
              <SettingsGrid>
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
              </SettingsGrid>
            </TabsContent>

            <TabsContent value="experimental" className="w-full">
              <SettingsGrid>
                <SettingRow
                  label={t('settings.experimental.petdex.title')}
                  description={t('settings.experimental.petdex.description')}
                  labelId="petdex-integration-label"
                  descriptionId="petdex-integration-description"
                >
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.experimental.petdex.enabled')}
                      aria-describedby="petdex-integration-description petdex-privacy-description"
                      aria-busy={petdexConfiguring}
                      checked={displayedPetdexEnabled}
                      onCheckedChange={handlePetdexEnabledChange}
                    />
                  </div>
                </SettingRow>
                <SettingRow
                  label={t('settings.experimental.petdex.status')}
                  description={t('settings.experimental.petdex.privacy')}
                  labelId="petdex-status-label"
                  descriptionId="petdex-privacy-description"
                >
                  <div
                    className="flex items-center justify-end gap-2"
                    role="status"
                    aria-label={t('settings.experimental.petdex.statusAnnouncement', {
                      status: t(PETDEX_STATUS_LABEL_KEYS[petdexStatus]),
                    })}
                    aria-live="polite"
                    aria-atomic="true"
                    aria-busy={testingPetdex || petdexConfiguring}
                  >
                    <Badge
                      variant={petdexStatus === 'connected'
                        ? 'default'
                        : petdexStatus === 'connectionError'
                          ? 'destructive'
                          : 'outline'}
                    >
                      {t(PETDEX_STATUS_LABEL_KEYS[petdexStatus])}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-describedby="petdex-privacy-description"
                      disabled={!petdexEnabled || testingPetdex || petdexConfiguring}
                      onClick={() => void handleTestPetdex()}
                    >
                      <FlaskConicalIcon data-icon="inline-start" />
                      {testingPetdex
                        ? t('settings.experimental.petdex.testing')
                        : t('settings.experimental.petdex.testAction')}
                    </Button>
                  </div>
                </SettingRow>
                <SettingRow
                  label={t('settings.experimental.petdex.feedback')}
                  description={t('settings.experimental.petdex.feedbackDescription')}
                  descriptionId="petdex-feedback-description"
                >
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-describedby="petdex-feedback-description"
                      onClick={() => void openPetdexPhase3Feedback()}
                    >
                      <MessageSquareIcon data-icon="inline-start" />
                      {t('settings.experimental.petdex.feedbackAction')}
                      <ExternalLinkIcon data-icon="inline-end" />
                    </Button>
                  </div>
                </SettingRow>
              </SettingsGrid>
            </TabsContent>

            <TabsContent value="general" className="w-full">
              <SettingsGrid>
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
                <SettingRow label={t('settings.general.startupUpdateCheck')} description={t('settings.general.startupUpdateCheckDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.general.startupUpdateCheck')}
                      checked={startupUpdateCheck}
                      onCheckedChange={setStartupUpdateCheck}
                    />
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.general.confirmBeforeExit')} description={t('settings.general.confirmBeforeExitDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.general.confirmBeforeExit')} checked={confirmBeforeExit} onCheckedChange={setConfirmBeforeExit} />
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.general.restoreWorkspace')} description={t('settings.general.restoreWorkspaceDescription')}>
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={handleClearWorkspace}>
                      <Trash2Icon data-icon="inline-start" />
                      {t('settings.general.clearWorkspace')}
                    </Button>
                    <Switch aria-label={t('settings.general.restoreWorkspace')} checked={restoreWorkspace} onCheckedChange={setRestoreWorkspace} />
                  </div>
                </SettingRow>
                <UpdateSection />
              </SettingsGrid>
            </TabsContent>

            <TabsContent value="terminal" className="w-full">
              <SettingsGrid>
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
                <SettingRow label={t('settings.terminal.colorScheme')} description={t('settings.terminal.colorSchemeDescription')}>
                  <Select value={terminalColorScheme} onValueChange={(value) => setTerminalColorScheme(value as TerminalColorScheme)}>
                    <SelectTrigger size="sm" aria-label={t('settings.terminal.colorScheme')}>
                      <SelectValue>{t(`settings.terminal.colorScheme.${terminalColorScheme}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {TERMINAL_COLOR_SCHEME_IDS.map((scheme) => (
                          <SelectItem key={scheme} value={scheme}>
                            {t(`settings.terminal.colorScheme.${scheme}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </SettingRow>
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
                <SettingGroupLabel>{t('settings.terminal.groupInteraction')}</SettingGroupLabel>
                <SettingRow label={t('settings.terminal.cursorBlink')} description={t('settings.terminal.cursorBlinkDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.terminal.cursorBlink')} checked={terminalCursorBlink} onCheckedChange={setTerminalCursorBlink} />
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.terminal.copyOnSelect')} description={t('settings.terminal.copyOnSelectDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.copyOnSelect')}
                      checked={terminalCopyOnSelect}
                      onCheckedChange={setTerminalCopyOnSelect}
                    />
                  </div>
                </SettingRow>
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
                <SettingRow label={t('settings.terminal.urlDetection')} description={t('settings.terminal.urlDetectionDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.urlDetection')}
                      checked={terminalUrlDetection}
                      onCheckedChange={setTerminalUrlDetection}
                    />
                  </div>
                </SettingRow>
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
                <SettingRow
                  label={t('settings.terminal.scrollback')}
                  description={t('settings.terminal.scrollbackDescription')}
                >
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
                <SettingRow label={t('settings.terminal.largePasteWarning')} description={t('settings.terminal.largePasteWarningDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.largePasteWarning')}
                      checked={terminalLargePasteWarning}
                      onCheckedChange={setTerminalLargePasteWarning}
                    />
                  </div>
                </SettingRow>
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
                <SettingRow label={t('settings.terminal.hideSingleTabBar')} description={t('settings.terminal.hideSingleTabBarDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.terminal.hideSingleTabBar')}
                      checked={terminalHideSingleTabBar}
                      onCheckedChange={setTerminalHideSingleTabBar}
                    />
                  </div>
                </SettingRow>
              </SettingsGrid>
            </TabsContent>

            <TabsContent value="sftp" className="w-full">
              <SettingsGrid>
                <SettingRow label={t('settings.sftp.showHiddenFiles')} description={t('settings.sftp.showHiddenFilesDescription')}>
                  <div className="flex justify-end">
                    <Switch aria-label={t('settings.sftp.showHiddenFiles')} checked={sftpShowHiddenFiles} onCheckedChange={setSftpShowHiddenFiles} />
                  </div>
                </SettingRow>
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
                        <FolderOpenIcon data-icon="inline-start" />
                        <span className="truncate">{sftpDownloadDirectory || t('settings.sftp.downloadDirectoryAsk')}</span>
                      </TooltipTrigger>
                      <TooltipContent className="break-all">{sftpDownloadDirectory || t('settings.sftp.downloadDirectoryAsk')}</TooltipContent>
                    </Tooltip>
                    {sftpDownloadDirectory && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={t('settings.sftp.downloadDirectoryClear')}
                        onClick={() => setSftpDownloadDirectory('')}
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.sftp.completionNotification')} description={t('settings.sftp.completionNotificationDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.sftp.completionNotification')}
                      checked={sftpCompletionNotification}
                      onCheckedChange={setSftpCompletionNotification}
                    />
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.sftp.hideSingleTabBar')} description={t('settings.sftp.hideSingleTabBarDescription')}>
                  <div className="flex justify-end">
                    <Switch
                      aria-label={t('settings.sftp.hideSingleTabBar')}
                      checked={sftpHideSingleTabBar}
                      onCheckedChange={setSftpHideSingleTabBar}
                    />
                  </div>
                </SettingRow>
              </SettingsGrid>
            </TabsContent>

            <TabsContent value="ai" className="w-full">
              <AiSettingsSection embedded />
            </TabsContent>

            <TabsContent value="shortcuts" className="w-full">
              <div className="flex flex-col gap-6">
                <div className="flex items-center justify-end">
                  <Button variant="outline" size="sm" className="shrink-0" onClick={resetShortcuts}>
                    <RotateCcwIcon data-icon="inline-start" />
                    {t('settings.shortcuts.resetAll')}
                  </Button>
                </div>
                {SHORTCUT_GROUPS.map((group) => (
                  <section key={group.id} className="flex min-w-0 flex-col gap-2.5">
                    <h3 className="px-1 text-sm font-semibold text-foreground">
                      {t(SHORTCUT_GROUP_LABEL_KEYS[group.id])}
                    </h3>
                    <Card variant="outline" className="gap-0 py-0">
                      <CardContent className="px-0">
                        {group.actions.map((action, index) => {
                          const binding = shortcuts[action] ?? DEFAULT_SHORTCUTS[action];
                          const leaderBinding = shortcuts.terminalLeader ?? DEFAULT_SHORTCUTS.terminalLeader;
                          return (
                            <React.Fragment key={action}>
                              {index > 0 && <Separator />}
                              <div className="flex min-h-16 items-center justify-between gap-4 px-5 py-3">
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
                                    <KeyboardIcon data-icon="inline-start" />
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
                                          className="size-8"
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
                      </CardContent>
                    </Card>
                  </section>
                ))}
              </div>
            </TabsContent>
                </div>
              </ScrollArea>
            </section>
          </Tabs>

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
        </TooltipProvider>
      </DialogContent>
    </Dialog>
  );
};
