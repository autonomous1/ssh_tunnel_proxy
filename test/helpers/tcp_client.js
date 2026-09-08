const net = require('node:net');

function waitForSocketDeath(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed || socket.readyState === 'closed') {
      resolve('already-closed');
      return;
    }
    const timer = setTimeout(() => {
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      reject(new Error(`Socket stayed open for ${timeoutMs}ms; expected the peer to close or reset it`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve('close');
    };
    const onError = () => {
      clearTimeout(timer);
      resolve('error');
    };
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function hold(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.once('error', reject);
    socket.once('connect', () => {
      resolve({
        socket,
        write(data) {
          socket.write(data);
        },
        close() {
          socket.destroy();
        },
      });
    });
  });
}

module.exports = { waitForSocketDeath, hold };
