import { invoke } from '@tauri-apps/api/core';
import { describeSession } from './profile';
import type { ConnectionProfile, SessionSummary } from '../types';

export async function createSessionFromProfile(profile: ConnectionProfile): Promise<SessionSummary> {
  const request: Record<string, unknown> = {
    name: describeSession(profile),
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    authMethod: profile.authMethod,
    password: profile.password || undefined,
    privateKeyPath: profile.privateKeyPath?.trim() || undefined,
    passphrase: profile.passphrase || undefined,
    terminalCols: 120,
    terminalRows: 32,
  };
  if (profile.jumpHost) {
    request.jumpHost = {
      host: profile.jumpHost.host.trim(),
      port: profile.jumpHost.port,
      username: profile.jumpHost.username.trim(),
      authMethod: profile.jumpHost.authMethod,
      password: profile.jumpHost.password || undefined,
      privateKeyPath: profile.jumpHost.privateKeyPath?.trim() || undefined,
      passphrase: profile.jumpHost.passphrase || undefined,
    };
  }
  return invoke<SessionSummary>('create_session', { request });
}
