import { defineConfig } from 'vite';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';

export default defineConfig({
  plugins: [codeInspectorPlugin({ bundler: 'vite' }), tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
  clearScreen: false,
  build: {
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-terminal',
              test: /node_modules[\\/]@xterm[\\/]/,
              priority: 30,
            },
          ],
        },
      },
    },
  },
});
