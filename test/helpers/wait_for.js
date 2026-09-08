function waitFor(check, { timeoutMs = 3000, intervalMs = 25, label = 'condition' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await check()) {
          resolve(undefined);
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    void tick();
  });
}

module.exports = { waitFor };
