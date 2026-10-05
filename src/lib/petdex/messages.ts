import type { Locale, PetdexDiagnostic } from '@/types';
import type { PetdexConfiguration } from './preferences';
import type { PetdexMessagePreferences } from './message-preferences';
import { invokePetdexConfigure, invokePetdexMessageDiagnostic, invokePetdexTestMessage } from '@/lib/ipc/tauri';
import { isPetdexConfigurationResult, isPetdexMessageDiagnostic, isPetdexMessageTestResult } from './diagnostic-validators';

export type CleanupOutcome = 'notNeeded' | 'accepted' | 'unconfirmed';
export interface PetdexSettings extends PetdexConfiguration, PetdexMessagePreferences { locale: Locale }
export interface PetdexMessageDiagnostic {
  revision: number;
  status: 'disabled' | 'ready' | 'unavailable' | 'unsupported' | 'error';
  acceptedCount: number;
  lastAcceptedAt: number | null;
  usedSlotCount: number;
  errorReason: PetdexDiagnostic['errorReason'];
  unsupported: boolean;
  cleanupOutcome: CleanupOutcome;
}
export interface PetdexConfigurationResult {
  effective: PetdexSettings;
  diagnostic: PetdexDiagnostic;
  messageDiagnostic: PetdexMessageDiagnostic;
  cleanupOutcome: CleanupOutcome;
}
export interface PetdexMessageTestResult {
  diagnostic: PetdexMessageDiagnostic;
  outcome: 'accepted' | 'overridden' | 'failed' | 'disabled';
}
export function newestMessageDiagnostic(current: PetdexMessageDiagnostic | null, next: PetdexMessageDiagnostic): PetdexMessageDiagnostic {
  return current && current.revision >= next.revision ? current : next;
}
export async function configurePetdexSettings(configuration: PetdexSettings): Promise<PetdexConfigurationResult> {
  const result = await invokePetdexConfigure(configuration);
  if (!isPetdexConfigurationResult(result)) throw new Error('petdex-invalid-configuration-result');
  return result;
}
export async function getPetdexMessageDiagnostic(): Promise<PetdexMessageDiagnostic> {
  const result = await invokePetdexMessageDiagnostic();
  if (!isPetdexMessageDiagnostic(result)) throw new Error('petdex-invalid-message-diagnostic');
  return result;
}
export async function testPetdexMessage(): Promise<PetdexMessageTestResult> {
  const result = await invokePetdexTestMessage();
  if (!isPetdexMessageTestResult(result)) throw new Error('petdex-invalid-message-test');
  return result;
}
