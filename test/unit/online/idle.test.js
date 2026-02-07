const OnlineServer = require('../../../src/online');
const WebSocket = require('ws');

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve) => ws.once('open', resolve));
}

describe('OnlineServer idle timeout', () => {
  test('disconnects idle clients', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, idleTimeoutMs: 50, sweepIntervalMs: 20 });
    await server.start();
    const port = server.port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    await waitForOpen(ws);

    const idle = await new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    expect(idle.code).toBe('IDLE_TIMEOUT');

    await new Promise((resolve) => ws.once('close', resolve));
    await server.stop();
    ws.removeAllListeners();
  }, 15000);
});
