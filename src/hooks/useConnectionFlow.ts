import { invoke } from '@tauri-apps/api/core';
import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { t } from '../lib/i18n';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { createSessionFromProfile } from '../lib/sessionCreate';
import { createEmptyProfile, sanitizeProfileForStorage } from '../lib/profile';
import { consumeBufferedSessionStatus, insertSessionAfterActive, type PendingSessionStatusEvents } from '../lib/session';
import type { ConnectionProfile, CreateSessionError, HostKeyCheckResponse, SessionState } from '../types';

const connectionLogger = createLogger('app');

interface HostKeyDialogState {
  open: boolean;
  profile?: ConnectionProfile;
  fingerprint?: string;
  remember?: boolean;
  rememberPassword?: boolean;
}

export interface UseConnectionFlowOptions {
  historyLimit: number;
  setSavedProfiles: Dispatch<SetStateAction<ConnectionProfile[]>>;
  setSessions: Dispatch<SetStateAction<SessionState[]>>;
  sessionsRef: MutableRefObject<SessionState[]>;
  activeSessionId: string | undefined;
  setActiveSessionId: Dispatch<SetStateAction<string | undefined>>;
  pendingStatusEventsRef: MutableRefObject<PendingSessionStatusEvents>;
  setErrorMessage: (message: string | undefined) => void;
  onSuccess?: (profile: ConnectionProfile, sessionId: string) => void;
}

export interface UseConnectionFlowResult {
  draftProfile: ConnectionProfile;
  setDraftProfile: (profile: ConnectionProfile) => void;
  connectDialogOpen: boolean;
  setConnectDialogOpen: (open: boolean) => void;
  isConnecting: boolean;
  hostKeyDialog: HostKeyDialogState;
  setHostKeyDialog: (state: HostKeyDialogState) => void;
  handleConnect: (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => Promise<void>;
  handleTrustAndConnect: () => Promise<void>;
  loadProfile: (profile: ConnectionProfile) => Promise<void>;
}

export function useConnectionFlow({
  historyLimit,
  setSavedProfiles,
  setSessions,
  sessionsRef,
  activeSessionId,
  setActiveSessionId,
  pendingStatusEventsRef,
  setErrorMessage,
  onSuccess,
}: UseConnectionFlowOptions): UseConnectionFlowResult {
  const [draftProfile, setDraftProfile] = useState<ConnectionProfile>(createEmptyProfile());
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hostKeyDialog, setHostKeyDialog] = useState<HostKeyDialogState>({ open: false });

  const openHostKeyDialog = (
    profile: ConnectionProfile,
    fingerprint: string | undefined,
    remember: boolean,
    rememberPassword: boolean,
  ) => {
    setHostKeyDialog({
      open: true,
      profile,
      fingerprint,
      remember,
      rememberPassword,
    });
  };

  const proceedWithConnection = async (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => {
    try {
      if (remember) {
        // Store password in OS keychain before saving profile
        if (rememberPassword && profile.password && isTauriRuntime()) {
          try {
            await invoke('store_password', {
              profileId: profile.id,
              password: profile.password,
            });
          } catch (error) {
            connectionLogger.warn('Failed to store password in keychain', { error: String(error) });
          }
        }
        const nextProfile = sanitizeProfileForStorage({
          ...profile,
          rememberPassword,
        });
        setSavedProfiles((current) => {
          const others = current.filter((item) => item.id !== nextProfile.id);
          return [nextProfile, ...others].slice(0, historyLimit);
        });
      }

      const summary = await createSessionFromProfile(profile);
      const bufferedStatus = consumeBufferedSessionStatus(summary.sessionId, pendingStatusEventsRef.current);
      const nextSession: SessionState = {
        ...summary,
        profile,
        status: bufferedStatus?.status ?? 'connecting',
        note: bufferedStatus?.note,
        createdAt: Date.now(),
      };
      const insertAfterSessionId = activeSessionId;
      sessionsRef.current = insertSessionAfterActive(sessionsRef.current, nextSession, insertAfterSessionId);
      setSessions((current) => insertSessionAfterActive(current, nextSession, insertAfterSessionId));
      setActiveSessionId(summary.sessionId);

      // Start port forwards if configured
      if ((profile.portForwards?.length ?? 0) > 0 && isTauriRuntime()) {
        const forwardOpId = `pf-${summary.sessionId}`;
        void invoke('start_port_forwards', {
          operationId: forwardOpId,
          host: profile.host.trim(),
          port: profile.port,
          username: profile.username.trim(),
          authMethod: profile.authMethod,
          password: profile.password || undefined,
          privateKeyPath: profile.privateKeyPath?.trim() || undefined,
          passphrase: profile.passphrase || undefined,
          jumpHost: profile.jumpHost
            ? {
                host: profile.jumpHost.host.trim(),
                port: profile.jumpHost.port,
                username: profile.jumpHost.username.trim(),
                authMethod: profile.jumpHost.authMethod,
                password: profile.jumpHost.password || undefined,
                privateKeyPath: profile.jumpHost.privateKeyPath?.trim() || undefined,
                passphrase: profile.jumpHost.passphrase || undefined,
              }
            : undefined,
          forwards: profile.portForwards,
        }).catch((error) => {
          connectionLogger.warn('Failed to start port forwards', { error: String(error) });
        });
      }

      setDraftProfile({
        ...createEmptyProfile(),
        username: profile.username,
        port: profile.port,
        authMethod: profile.authMethod,
        rememberPassword: false,
        privateKeyPath: profile.privateKeyPath ?? '',
      });
      setErrorMessage(undefined);
      setConnectDialogOpen(false);
      onSuccess?.(profile, summary.sessionId);
      connectionLogger.info('SSH 会话创建成功', {
        sessionId: summary.sessionId,
        title: summary.title,
      });
    } catch (error) {
      connectionLogger.error('SSH 会话创建失败', error);

      const hostKeyError = parseCreateSessionError(error);
      if (hostKeyError?.type === 'hostKeyUnknown') {
        openHostKeyDialog(
          profile,
          hostKeyError.payload.fingerprint,
          remember,
          rememberPassword,
        );
        return;
      }

      if (hostKeyError?.type === 'hostKeyMismatch') {
        setErrorMessage(t('app.error.hostKeyMismatch'));
        return;
      }

      setErrorMessage(String(error));
    }
  };

  const handleConnect = async (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => {
    if (isConnecting) return;

    if (!profile.host.trim() || !profile.username.trim()) {
      connectionLogger.warn('连接参数校验失败：Host 或 Username 为空');
      setErrorMessage(t('app.error.hostUsernameRequired'));
      return;
    }

    if (!isTauriRuntime()) {
      connectionLogger.warn('浏览器预览模式下尝试建立连接');
      setErrorMessage(t('app.error.desktopOnly'));
      return;
    }

    setIsConnecting(true);
    try {
      connectionLogger.info('开始检查主机密钥', {
        host: profile.host.trim(),
        port: profile.port,
      });

      const checkResult = await invoke<HostKeyCheckResponse>('check_host_key', {
        request: {
          host: profile.host.trim(),
          port: profile.port,
        },
      });

      if (checkResult.status === 'mismatch') {
        connectionLogger.warn('主机密钥不匹配，可能存在中间人攻击', {
          host: profile.host.trim(),
          port: profile.port,
        });
        setErrorMessage(t('app.error.hostKeyMismatch'));
        return;
      }

      if (checkResult.status === 'failure') {
        connectionLogger.warn('主机密钥检查失败', {
          host: profile.host.trim(),
          port: profile.port,
        });
        setErrorMessage(checkResult.message || t('app.error.hostKeyCheckFailed'));
        return;
      }

      if (checkResult.status === 'notFound') {
        connectionLogger.info('首次连接到该主机，等待用户确认指纹', {
          host: profile.host.trim(),
          fingerprint: checkResult.fingerprint,
        });
        openHostKeyDialog(profile, checkResult.fingerprint, remember, rememberPassword);
        return;
      }

      await proceedWithConnection(profile, remember, rememberPassword);
    } catch (error) {
      connectionLogger.error('主机密钥检查或连接失败', error);
      setErrorMessage(String(error));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleTrustAndConnect = async () => {
    if (!hostKeyDialog.profile) return;

    const { profile, remember, rememberPassword } = hostKeyDialog;
    try {
      await invoke('trust_host', {
        request: {
          host: profile.host.trim(),
          port: profile.port,
        },
      });
      setHostKeyDialog({ open: false });
      await proceedWithConnection(profile, remember ?? false, rememberPassword ?? false);
    } catch (error) {
      connectionLogger.error('信任主机失败', error);
      setErrorMessage(String(error));
    }
  };

  const loadProfile = async (profile: ConnectionProfile) => {
    let password = '';
    if (profile.rememberPassword && isTauriRuntime()) {
      try {
        const stored = await invoke<string | null>('retrieve_password', {
          profileId: profile.id,
        });
        if (stored) {
          password = stored;
        }
      } catch (error) {
        connectionLogger.warn('Failed to retrieve password from keychain', { error: String(error) });
      }
    }
    setDraftProfile({
      ...profile,
      password,
      passphrase: '',
    });
    setErrorMessage(undefined);
    setConnectDialogOpen(true);
  };

  return {
    draftProfile,
    setDraftProfile,
    connectDialogOpen,
    setConnectDialogOpen,
    isConnecting,
    hostKeyDialog,
    setHostKeyDialog,
    handleConnect,
    handleTrustAndConnect,
    loadProfile,
  };
}

function parseCreateSessionError(error: unknown): CreateSessionError | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const type = record.type;
  const payload = record.payload;

  if (type !== 'hostKeyUnknown' && type !== 'hostKeyMismatch' && type !== 'other') {
    return undefined;
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const payloadRecord = payload as Record<string, unknown>;

  if (type === 'hostKeyUnknown') {
    const host = payloadRecord.host;
    const port = payloadRecord.port;
    if (typeof host !== 'string' || typeof port !== 'number') {
      return undefined;
    }
    return {
      type: 'hostKeyUnknown',
      payload: {
        host,
        port,
        fingerprint: typeof payloadRecord.fingerprint === 'string' ? payloadRecord.fingerprint : undefined,
      },
    };
  }

  if (type === 'hostKeyMismatch') {
    const host = payloadRecord.host;
    const port = payloadRecord.port;
    if (typeof host !== 'string' || typeof port !== 'number') {
      return undefined;
    }
    return {
      type: 'hostKeyMismatch',
      payload: { host, port },
    };
  }

  const message = payloadRecord.message;
  if (typeof message !== 'string') {
    return undefined;
  }

  return {
    type: 'other',
    payload: { message },
  };
}
