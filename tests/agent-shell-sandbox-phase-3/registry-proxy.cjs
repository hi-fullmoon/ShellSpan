// Real transport prototype, limited to the public npm registry. No fabricated replies.
const http = require('node:http');
const net = require('node:net');
const [socketPath] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  response.writeHead(405);
  response.end();
});
server.on('connect', (request, client, head) => {
  let destination;
  try { destination = new URL(`https://${request.url}`); }
  catch { client.destroy(); return; }
  if (destination.hostname !== 'registry.npmjs.org'
      || (destination.port && destination.port !== '443')
      || destination.username || destination.password || destination.pathname !== '/') {
    client.destroy();
    return;
  }
  const upstream = net.connect({ host: destination.hostname, port: 443 });
  upstream.setTimeout(15000, () => upstream.destroy());
  client.setTimeout(15000, () => client.destroy());
  upstream.on('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
server.listen(socketPath);
