// The caller owns this isolated verification server. Once the result has
// settled and the App has been stopped, unfinished requests must not retain it.
export function closeNativeValidationServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    // Stop accepting first, then terminate this server's remaining sockets.
    server.closeAllConnections();
  });
}
