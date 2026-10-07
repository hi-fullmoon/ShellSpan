import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Dedicated review server keeps another chat's HMR edits from replacing an
// in-progress native UI case. It serves real source and supplies no IPC data.
const root = path.resolve(import.meta.dirname, '..');
const server = await createServer({
  root, configFile: false, cacheDir: '/tmp/shellspan-sandbox-settings-vite',
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [tailwindcss()],
  optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 1421, strictPort: true, hmr: false, watch: null },
});
await server.listen();
console.log('Sandbox settings review source: http://127.0.0.1:1421');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void server.close().then(() => process.exit(0));
});
