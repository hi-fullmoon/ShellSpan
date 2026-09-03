import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
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
      // Interactive Phase 0 capture host; its dedicated config runs it explicitly.
      'scripts/ai-panel-phase0-target-host.test.mjs',
    ],
    maxWorkers: 4,
    testTimeout: 15_000,
  },
});
