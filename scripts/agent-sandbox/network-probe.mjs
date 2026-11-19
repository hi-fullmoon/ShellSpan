import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';

const protocol = process.argv[2];
const port = Number(process.argv[3]);
const token = 'shellspan-loopback';

try {
  const signal = AbortSignal.timeout(900);
  if (protocol === 'tcp') {
    const socket = createConnection({ host: '127.0.0.1', port });
    try {
      await once(socket, 'connect', { signal });
      socket.end(token);
      socket.setEncoding('utf8');
      const [reply] = await once(socket, 'data', { signal });
      if (reply !== token) throw new Error('unexpected TCP response');
    } finally {
      socket.destroy();
    }
  } else if (protocol === 'udp') {
    const socket = createSocket('udp4');
    try {
      const reply = once(socket, 'message', { signal });
      socket.send(token, port, '127.0.0.1');
      const [message] = await reply;
      if (message.toString() !== token) throw new Error('unexpected UDP response');
    } finally {
      socket.close();
    }
  } else {
    throw new Error('protocol must be tcp or udp');
  }
  console.log('LOOPBACK_REACHED');
} catch (error) {
  console.error(`loopback: ${error.code ?? error.message}`);
  process.exitCode = 73;
}
