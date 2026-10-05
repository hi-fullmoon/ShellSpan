import type { UnlistenFn } from '@tauri-apps/api/event';
import type { PetdexCategories, PetdexDiagnostic, PetdexTestResult } from '@/types';
import {
  invokePetdexGetStatus,
  invokePetdexCheckHealth,
  invokePetdexSetEnabled,
  invokePetdexTestConnection,
  listenPetdexStatus,
} from '@/lib/ipc/tauri';
import { isPetdexDiagnostic, isPetdexTestResult, isPetdexCheckResult } from './diagnostic';

export async function checkPetdexHealth() {
  const result = await invokePetdexCheckHealth();
  if (!isPetdexCheckResult(result)) throw new Error('petdex-invalid-check-result');
  return result;
}

function validateDiagnostic(value: unknown): PetdexDiagnostic {
  if (!isPetdexDiagnostic(value)) throw new Error('petdex-invalid-diagnostic');
  return value;
}

export async function configurePetdex(enabled: boolean, categories?: PetdexCategories): Promise<PetdexDiagnostic> {
  return validateDiagnostic(await invokePetdexSetEnabled(enabled, categories));
}

export async function getPetdexStatus(): Promise<PetdexDiagnostic> {
  return validateDiagnostic(await invokePetdexGetStatus());
}

export async function testPetdexConnection(): Promise<PetdexTestResult> {
  const result = await invokePetdexTestConnection();
  if (!isPetdexTestResult(result)) throw new Error('petdex-invalid-test-result');
  return result;
}

export function listenToPetdexStatus(callback: (snapshot: PetdexDiagnostic) => void): Promise<UnlistenFn> {
  return listenPetdexStatus((snapshot) => {
    if (isPetdexDiagnostic(snapshot)) callback(snapshot);
  });
}
