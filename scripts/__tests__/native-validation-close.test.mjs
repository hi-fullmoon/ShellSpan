import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { closeNativeValidationServer } from '../native-input-p3/close-validation-server.mjs';

it('closes a real unfinished HTTP request after the completed result without retaining a listener', async () => {
  let received;
  const bodyReceived = new Promise(resolve => { received = resolve; });
  const server = createServer((incoming, response) => {
    if (incoming.url === '/completed') { response.end('recorded'); return; }
    incoming.resume(); incoming.once('end', received);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let pending;
  try {
    expect(await (await fetch(origin + '/completed')).text()).toBe('recorded');
    pending = request(origin + '/unfinished', { method: 'POST' });
    const disconnected = new Promise(resolve => pending.once('error', resolve));
    pending.end('owned unfinished request'); await bodyReceived;
    await closeNativeValidationServer(server);
    expect(server.listening).toBe(false);
    expect((await disconnected).code).toBe('ECONNRESET');
  } finally {
    pending?.destroy();
    if (server.listening) await closeNativeValidationServer(server);
  }
});

it('reports closing a server that was never started as an error', async () => {
  await expect(closeNativeValidationServer(createServer())).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
});
