import type { PetdexDiagnostic, PetdexCheckResult, PetdexTestResult } from '@/types';

export function isPetdexDiagnostic(value: unknown): value is PetdexDiagnostic;
export function isPetdexCheckResult(value: unknown): value is PetdexCheckResult;
export function isPetdexTestResult(value: unknown): value is PetdexTestResult;
