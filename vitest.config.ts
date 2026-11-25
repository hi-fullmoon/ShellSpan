import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    css: true,
    exclude: [
      'node_modules',
      'dist',
      '**/.worktrees/**',
      '**/artifacts/**',
      '**/.artifacts/**',
      '**/src-tauri/target/**',
      '**/scripts/native-input/prototype/target/**',
      '**/scripts/native-input/acceptance/credential-cleanup/target/**',
      '**/*.native.test.{ts,tsx}',
    ],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
