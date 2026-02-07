const OnlineServer = require('../../../src/online');
const WebSocket = require('ws');

function createMessageQueue(ws) {
  const messages = [];
  let resolver = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (resolver) {
      const next = resolver;
      resolver = null;
      next(msg);
    } else {
      messages.push(msg);
    }
  });

  return function nextMessage(timeoutMs = 3000) {
    if (messages.length > 0) {
      return Promise.resolve(messages.shift());
    }
    return new Promise((resolve, reject) => {
      resolver = resolve;
      setTimeout(() => {
        if (resolver === resolve) {
          resolver = null;
          reject(new Error('Timeout waiting for message'));
        }
      }, timeoutMs);
    });
  };
}

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ws.once('open', resolve);
  });
}

describe('OnlineServer (Phase 1)', () => {
  let server;
  let port;

  beforeEach(async () => {
    server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['token-a', 'token-b'] });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  test('hello + auth handshake', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const nextMessage = createMessageQueue(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'hello',
      client: {
        subscriber_id: 'claude-code:abc123',
        agent_type: 'claude-code',
        nickname: 'agent-1',
        channel_type: 'private',
        world: 'world-1',
        version: '0.1.0',
        capabilities: [],
        project: { slug: 'demo' },
      },
    }));

    const ack = await nextMessage();
    const authRequired = await nextMessage();

    expect(ack.type).toBe('hello_ack');
    expect(ack.ok).toBe(true);
    expect(authRequired.type).toBe('auth_required');

    ws.send(JSON.stringify({ type: 'auth', method: 'token', token: 'token-a' }));
    const authOk = await nextMessage();
    expect(authOk.type).toBe('auth_ok');
    expect(authOk.ok).toBe(true);

    ws.close();
    await new Promise((resolve) => ws.once('close', resolve));
  });

  test('rejects duplicate nickname', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const next1 = createMessageQueue(ws1);
    const next2 = createMessageQueue(ws2);

    await waitForOpen(ws1);
    ws1.send(JSON.stringify({
      type: 'hello',
      client: {
        subscriber_id: 'claude-code:abc123',
        agent_type: 'claude-code',
        nickname: 'agent-dup',
        channel_type: 'private',
        world: 'world-1',
      },
    }));
    await next1();
    await next1();

    await waitForOpen(ws2);
    ws2.send(JSON.stringify({
      type: 'hello',
      client: {
        subscriber_id: 'codex:def456',
        agent_type: 'codex',
        nickname: 'agent-dup',
        channel_type: 'private',
        world: 'world-1',
      },
    }));

    const first = await next2();
    const error = first.type === 'hello_ack' ? await next2() : first;
    expect(error.type).toBe('error');
    expect(error.code).toBe('NICKNAME_TAKEN');
    expect(error.error).toMatch(/already exists/);

    ws1.close();
    ws2.close();
    await Promise.all([
      new Promise((resolve) => ws1.once('close', resolve)),
      new Promise((resolve) => ws2.once('close', resolve)),
    ]);
  }, 15000);

  test('join and relay channel events', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const next1 = createMessageQueue(ws1);
    const next2 = createMessageQueue(ws2);

    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    ws1.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'claude-code:one', agent_type: 'claude-code', nickname: 'one', channel_type: 'private', world: 'world-1' },
    }));
    await next1();
    await next1();
    ws1.send(JSON.stringify({ type: 'auth', method: 'token', token: 'token-a' }));
    await next1();

    ws2.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'codex:two', agent_type: 'codex', nickname: 'two', channel_type: 'private', world: 'world-1' },
    }));
    await next2();
    await next2();
    ws2.send(JSON.stringify({ type: 'auth', method: 'token', token: 'token-b' }));
    await next2();

    const channelId = 'channel_123456';
    server.channels.set(channelId, {
      name: 'demo',
      type: 'public',
      members: new Set(),
      created_at: new Date().toISOString(),
    });
    server.channelNames.set('demo', channelId);

    ws1.send(JSON.stringify({ type: 'join', channel: channelId }));
    ws2.send(JSON.stringify({ type: 'join', channel: channelId }));

    await next1();
    await next2();

    ws1.send(JSON.stringify({
      type: 'event',
      channel: channelId,
      payload: { kind: 'message', message: 'hello' },
    }));

    const delivered = await next2();
    expect(delivered.type).toBe('event');
    expect(delivered.channel).toBe(channelId);
    expect(delivered.payload).toEqual({ kind: 'message', message: 'hello' });
    expect(delivered.from).toBe('claude-code:one');

    ws1.close();
    ws2.close();
    await Promise.all([
      new Promise((resolve) => ws1.once('close', resolve)),
      new Promise((resolve) => ws2.once('close', resolve)),
    ]);
  }, 15000);

  test('relay direct messages by subscriber id', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ufoo/online`);
    const next1 = createMessageQueue(ws1);
    const next2 = createMessageQueue(ws2);

    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    ws1.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'claude-code:alpha', agent_type: 'claude-code', nickname: 'alpha', channel_type: 'private', world: 'world-1' },
    }));
    await next1();
    await next1();
    ws1.send(JSON.stringify({ type: 'auth', method: 'token', token: 'token-a' }));
    await next1();

    ws2.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'codex:beta', agent_type: 'codex', nickname: 'beta', channel_type: 'private', world: 'world-1' },
    }));
    await next2();
    await next2();
    ws2.send(JSON.stringify({ type: 'auth', method: 'token', token: 'token-b' }));
    await next2();

    ws1.send(JSON.stringify({
      type: 'event',
      to: 'codex:beta',
      payload: { kind: 'message', message: 'direct' },
    }));

    const delivered = await next2();
    expect(delivered.type).toBe('event');
    expect(delivered.to).toBe('codex:beta');
    expect(delivered.payload.message).toBe('direct');
    expect(delivered.from).toBe('claude-code:alpha');

    ws1.close();
    ws2.close();
    await Promise.all([
      new Promise((resolve) => ws1.once('close', resolve)),
      new Promise((resolve) => ws2.once('close', resolve)),
    ]);
  });
});
