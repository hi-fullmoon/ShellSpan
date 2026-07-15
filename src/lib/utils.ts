import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(timestamp: number | undefined): string {
  if (timestamp === undefined || timestamp === null) return '-';
  return new Date(timestamp * 1000).toLocaleString();
}

export function formatPermissions(mode: number | undefined): string {
  if (mode === undefined) return '-';
  const perms = (mode & 0o777).toString(8).padStart(3, '0');
  return perms;
}

export function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
