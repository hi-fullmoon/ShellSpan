import type { PetdexDiagnostic, PetdexCheckResult, PetdexTestResult } from '@/types';
import type { PetdexConfigurationResult, PetdexMessageDiagnostic, PetdexMessageTestResult } from './messages';

export function isPetdexConfigurationResult(value: unknown): value is PetdexConfigurationResult;
export function isPetdexMessageDiagnostic(value: unknown): value is PetdexMessageDiagnostic;
export function isPetdexMessageTestResult(value: unknown): value is PetdexMessageTestResult;

export function isPetdexDiagnostic(value: unknown): value is PetdexDiagnostic;
export function isPetdexCheckResult(value: unknown): value is PetdexCheckResult;
export function isPetdexTestResult(value: unknown): value is PetdexTestResult;
