const OnlineServer = require('../../../src/online');
const OnlineClient = require('../../../src/online/client');
const { generateToken, hashToken } = require('../../../src/online/tokens');

function waitForMessage(client, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener('message', handler);
      reject(new Error('timeout'));
    }, timeoutMs);

    const handler = (msg) => {
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        client.removeListener('message', handler);
        resolve(msg);
      }
    };

    client.on('message', handler);
  });
}

function createPeer(server, tokenHash, opts = {}) {
  const client = new OnlineClient({
    url: `ws://127.0.0.1:${server.port}/ufoo/online`,
    subscriberId: opts.subscriberId || `peer-${Math.random().toString(16).slice(2)}`,
    nickname: opts.nickname || `peer-${Math.random().toString(16).slice(2)}`,
    channelType: opts.channelType || 'world',
    tokenHash,
  });
  return client;
}

describe('OnlineClient (Phase 1)', () => {
  let server;
  let client;
  let peer;

  afterEach(async () => {
    if (client) {
      client.close();
      client = null;
    }
    if (peer) {
      peer.close();
      peer = null;
    }
    if (server) {
      await server.stop();
      server = null;
    }
  });
  test('connects and authenticates with token hash', async () => {
    const token = generateToken(16);
    server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: [hashToken(token)] });
    await server.start();

    client = createPeer(server, hashToken(token), {
      subscriberId: 'codex:alpha',
      nickname: 'alpha',
      channelType: 'private',
    });
    peer = createPeer(server, hashToken(token), {
      subscriberId: 'claude:beta',
      nickname: 'beta',
      channelType: 'private',
    });

    await client.connect();
    await peer.connect();

    client.join('world');
    peer.join('world');
    await waitForMessage(client, (msg) => msg.type === 'join_ack');
    await waitForMessage(peer, (msg) => msg.type === 'join_ack');

    client.sendEvent({ channel: 'world', payload: { kind: 'message', message: 'hi' } });

    const delivered = await waitForMessage(peer, (msg) => msg.type === 'event');
    expect(delivered.payload.message).toBe('hi');

  }, 15000);
});
