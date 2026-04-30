import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    codeInspectorPlugin({ bundler: 'vite' }),
  ],
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
