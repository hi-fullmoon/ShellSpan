// Client transport adapter. Ignoring this adapter cannot bypass kernel network denial.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const connect = net.connect;
const socket = process.env.SHELLSPAN_PROXY_SOCKET;
const services = JSON.parse(process.env.SHELLSPAN_SERVICE_ROUTES || '[]');
if (!socket) throw new Error('Explicit proxy socket required');
function connectProxy(options, ...rest) {
  if (options && typeof options === 'object'
      && ['localhost', '127.0.0.1'].includes(options.host)) {
    const service = services.find(service => service.port === Number(options.port));
    if (service) return connect({ path: service.socket }, ...rest);
  }
  if (options && typeof options === 'object'
      && options.host === '127.0.0.1' && Number(options.port) === 65535) {
    return connect({ path: socket }, ...rest);
  }
  return connect(options, ...rest);
}
net.connect = connectProxy;
net.createConnection = connectProxy;
const listen = net.Server.prototype.listen;
const address = net.Server.prototype.address;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  const options = first && typeof first === 'object' ? first : undefined;
  const port = typeof first === 'number' ? first : options?.port;
  const host = options?.host ?? (typeof args[1] === 'string' ? args[1] : undefined);
  const service = services.find(service => service.port === Number(port));
  if (!service || options?.ipv6Only || host !== undefined && !['localhost', '127.0.0.1'].includes(host)) {
    return listen.apply(this, args);
  }
  const callback = args.find(value => typeof value === 'function');
  this.address = function () {
    const current = address.call(this);
    return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: service.port } : current;
  };
  return listen.call(this, { fd: service.fd, backlog: options?.backlog, signal: options?.signal }, callback);
};
// Keep the approved listeners across the normal pnpm -> script -> Node spawn chain.
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (services.length === 0) return spawn.call(this, file, args, options);
  if (!Array.isArray(args)) { options = args; args = []; }
  const stdio = Array.isArray(options?.stdio) ? [...options.stdio]
    : Array(3).fill(options?.stdio || 'pipe');
  for (const service of services) {
    while (stdio.length <= service.fd) stdio.push('ignore');
    stdio[service.fd] = service.fd;
  }
  return spawn.call(this, file, args, { ...options, stdio });
};
syncBuiltinESMExports();
