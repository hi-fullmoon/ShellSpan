// Client compatibility only. Kernel deny-network remains the security boundary.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const connect = net.connect;
const socket = process.env.SHELLSPAN_PROXY_SOCKET;
if (!socket) throw new Error('Explicit proxy socket required');
function connectProxy(options, ...rest) {
  if (options && typeof options === 'object'
      && options.host === '127.0.0.1' && Number(options.port) === 65535) {
    return connect({ path: socket }, ...rest);
  }
  return connect(options, ...rest);
}
net.connect = connectProxy;
net.createConnection = connectProxy;
syncBuiltinESMExports();
