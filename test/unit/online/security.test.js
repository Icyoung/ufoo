const OnlineServer = require('../../../src/online/server');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');

function httpRequest({ method, url, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const mergedHeaders = { 'Content-Type': 'application/json', ...headers };
    const req = http.request(url, { method, headers: mergedHeaders }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw || '{}') });
        } catch {
          resolve({ status: res.statusCode, data: {} });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

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
    if (messages.length > 0) return Promise.resolve(messages.shift());
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

describe('Security hardening', () => {

  // Step 1: No token startup guard
  test('throws when no tokens and not insecure', () => {
    expect(() => new OnlineServer({ host: '127.0.0.1', port: 0 })).toThrow(/No tokens configured/);
  });

  test('allows startup with insecure flag', () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, insecure: true });
    expect(server.insecure).toBe(true);
    expect(server.allowAnyToken).toBe(true);
  });

  test('allows startup with tokens', () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['abc'] });
    expect(server.insecure).toBe(false);
    expect(server.allowAnyToken).toBe(false);
  });

  // Step 4: HTTP auth
  test('HTTP endpoints return 401 without auth header', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['secret-token'] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const roomsRes = await httpRequest({ method: 'GET', url: `${base}/ufoo/online/rooms` });
    expect(roomsRes.status).toBe(401);

    const channelsRes = await httpRequest({ method: 'GET', url: `${base}/ufoo/online/channels` });
    expect(channelsRes.status).toBe(401);

    await server.stop();
  }, 15000);

  test('HTTP endpoints return 401 with wrong token', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['secret-token'] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const res = await httpRequest({
      method: 'GET',
      url: `${base}/ufoo/online/rooms`,
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);

    await server.stop();
  }, 15000);

  test('HTTP endpoints return 200 with valid token', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['secret-token'] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const res = await httpRequest({
      method: 'GET',
      url: `${base}/ufoo/online/rooms`,
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);

    await server.stop();
  }, 15000);

  test('HTTP endpoints skip auth in insecure mode', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, insecure: true });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    const res = await httpRequest({ method: 'GET', url: `${base}/ufoo/online/rooms` });
    expect(res.status).toBe(200);

    await server.stop();
  }, 15000);

  // Step 3: Payload size limit (HTTP body)
  test('HTTP POST returns 413 for oversized body', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'], maxHttpBodyBytes: 64,
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;

    const bigBody = { name: 'x'.repeat(200), type: 'public' };
    try {
      const res = await httpRequest({
        method: 'POST',
        url: base,
        body: bigBody,
        headers: { Authorization: 'Bearer t' },
      });
      // If we get a response, it should be 413
      expect(res.status).toBe(413);
    } catch (err) {
      // Socket hang up is also acceptable - req.destroy() kills the connection
      expect(err.message).toMatch(/socket hang up|ECONNRESET/);
    }

    await server.stop();
  }, 15000);

  // Step 5: Rate limiting
  test('rate limits excessive messages', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
      rateLimitWindow: 60000, rateLimitMax: 5,
    });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next = createMessageQueue(ws);
    await waitForOpen(ws);

    // Send 6 messages rapidly (max is 5)
    for (let i = 0; i < 6; i++) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }

    // Collect all messages
    const received = [];
    try {
      for (let i = 0; i < 7; i++) {
        const msg = await next(2000);
        received.push(msg);
      }
    } catch {
      // timeout is expected
    }

    const rateLimited = received.find((m) => m.code === 'RATE_LIMITED');
    expect(rateLimited).toBeDefined();

    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    });
    await server.stop();
  }, 15000);

  // Step 6: scrypt password hashing
  test('scrypt hashPassword + verifyPassword', () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['t'] });
    const hashed = server.hashPassword('my-secret');
    expect(hashed).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);

    expect(server.verifyPassword('my-secret', hashed)).toBe(true);
    expect(server.verifyPassword('wrong-password', hashed)).toBe(false);
    expect(server.verifyPassword('my-secret', '')).toBe(false);
    expect(server.verifyPassword('my-secret', 'invalid')).toBe(false);
  });

  // Step 8: Path traversal protection
  test('bridge rejects path traversal filenames', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-security-'));
    const decisionsDir = path.join(tmpDir, '.ufoo', 'context', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    const OnlineConnect = require('../../../src/online/bridge');
    const bridge = new OnlineConnect({
      projectRoot: tmpDir,
      nickname: 'test',
      token: 'test-token',
      trustRemote: true,
    });

    // Prevent actual network connection
    bridge.subscriberId = 'test:123';

    // Try path traversal
    bridge.applyDecisionFromRemote({
      payload: {
        kind: 'decisions.sync',
        origin: 'other:456',
        decision: {
          id: 'evil',
          filename: '../../../etc/passwd',
          content: 'malicious content',
        },
      },
    });

    // Verify the traversal file was NOT created
    expect(fs.existsSync(path.join(tmpDir, 'etc', 'passwd'))).toBe(false);

    // Try with dot-dot in filename
    bridge.applyDecisionFromRemote({
      payload: {
        kind: 'decisions.sync',
        origin: 'other:456',
        decision: {
          id: 'evil2',
          filename: '..%2F..%2Fhacked.md',
          content: 'more malicious',
        },
      },
    });

    // Valid filename should still work
    bridge.applyDecisionFromRemote({
      payload: {
        kind: 'decisions.sync',
        origin: 'other:456',
        decision: {
          id: '0001-alice-valid-decision',
          filename: '0001-alice-valid-decision.md',
          content: '# Valid Decision',
        },
      },
    });
    expect(fs.existsSync(path.join(decisionsDir, '0001-alice-valid-decision.md'))).toBe(true);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Step 8.5: Remote trust gating
  test('bridge blocks remote bus/decision sync by default', () => {
    const OnlineConnect = require('../../../src/online/bridge');
    const bridge = new OnlineConnect({
      projectRoot: process.cwd(),
      nickname: 'test',
      token: 'test-token',
    });
    expect(bridge.isRemoteTrusted({ from: 'remote:123' })).toBe(false);
  });

  test('bridge allows remote when allowlist includes subscriber', () => {
    const OnlineConnect = require('../../../src/online/bridge');
    const bridge = new OnlineConnect({
      projectRoot: process.cwd(),
      nickname: 'test',
      token: 'test-token',
      allowFrom: ['remote:123'],
    });
    expect(bridge.isRemoteTrusted({ from: 'remote:123' })).toBe(true);
  });

  test('bridge decorates remote message with ufoo-online source + full sender id', () => {
    const OnlineConnect = require('../../../src/online/bridge');
    const bridge = new OnlineConnect({
      projectRoot: process.cwd(),
      nickname: 'test',
      token: 'test-token',
      room: 'room_1',
      trustRemote: true,
    });
    bridge.eventBus = { send: jest.fn() };

    bridge.handleOnlineMessage(null, {
      type: 'event',
      from: 'codex-3:e8fef28e',
      payload: {
        kind: 'message',
        message: '@codex-4 please review ucode',
      },
    });

    expect(bridge.eventBus.send).toHaveBeenCalledWith(
      '*',
      '[ufoo-online] codex-3:e8fef28e: @codex-4 please review ucode',
      'remote:online'
    );
  });

  // Step 9: Token file permissions
  test('saveTokens creates files with restricted permissions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-tokens-'));
    const tokenFile = path.join(tmpDir, 'sub', 'tokens.json');

    const { saveTokens } = require('../../../src/online/tokens');
    saveTokens(tokenFile, { agents: { test: { token: 'abc' } } });

    const stat = fs.statSync(tokenFile);
    // Check file mode (last 3 octal digits)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bridge prefers token_hash when resolving tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-tokenhash-'));
    const tokenFile = path.join(tmpDir, 'tokens.json');
    const data = {
      agents: {
        'agent:1': {
          token: 'raw-token',
          token_hash: 'hashed-token',
          nickname: 'nick',
          server: '',
        },
      },
    };
    fs.writeFileSync(tokenFile, JSON.stringify(data, null, 2));

    const OnlineConnect = require('../../../src/online/bridge');
    const bridge = new OnlineConnect({
      projectRoot: tmpDir,
      nickname: 'nick',
      subscriberId: 'agent:1',
      tokenFile,
    });

    expect(bridge.tokenHash).toBe('hashed-token');
    expect(bridge.token).toBe('');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('drainOutbox processes drain files without loss', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-outbox-'));
    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const OnlineConnect = require('../../../src/online/bridge');
      const bridge = new OnlineConnect({
        projectRoot: tmpDir,
        nickname: 'test',
        token: 'tok',
      });
      const outboxDir = path.join(tmpDir, '.ufoo', 'online', 'outbox');
      fs.mkdirSync(outboxDir, { recursive: true });

      const drainFile = path.join(outboxDir, 'test.jsonl.1.drain');
      fs.writeFileSync(
        drainFile,
        JSON.stringify({ text: 'hello', channel: 'lobby' }) + '\n'
      );

      const sent = [];
      const client = {
        sendEvent: (payload) => sent.push(payload),
      };

      bridge.drainOutbox(client);

      expect(sent.length).toBe(1);
      expect(sent[0].payload.message).toBe('hello');
      expect(fs.existsSync(drainFile)).toBe(false);
    } finally {
      process.env.HOME = oldHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('drainOutbox requeues unsent lines when client send fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-outbox-fail-'));
    const oldHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const OnlineConnect = require('../../../src/online/bridge');
      const bridge = new OnlineConnect({
        projectRoot: tmpDir,
        nickname: 'test',
        token: 'tok',
      });
      const outboxDir = path.join(tmpDir, '.ufoo', 'online', 'outbox');
      fs.mkdirSync(outboxDir, { recursive: true });

      const drainFile = path.join(outboxDir, 'test.jsonl.1.drain');
      const line = JSON.stringify({ text: 'hello', channel: 'lobby' });
      fs.writeFileSync(drainFile, `${line}\n`);

      const ok = bridge.drainOutbox({ sendEvent: () => false });
      expect(ok).toBe(false);

      const outboxFile = path.join(outboxDir, 'test.jsonl');
      expect(fs.existsSync(drainFile)).toBe(false);
      expect(fs.readFileSync(outboxFile, 'utf8')).toContain(line);
    } finally {
      process.env.HOME = oldHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('syncLocalToOnline does not advance last_seq when send fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufoo-sync-fail-'));
    try {
      const eventsDir = path.join(tmpDir, '.ufoo', 'bus', 'events');
      fs.mkdirSync(eventsDir, { recursive: true });
      const event = {
        seq: 1,
        event: 'message',
        publisher: 'local:1',
        target: '*',
        data: { message: 'hello' },
      };
      fs.writeFileSync(path.join(eventsDir, '2026-02-11.jsonl'), `${JSON.stringify(event)}\n`);

      const OnlineConnect = require('../../../src/online/bridge');
      const bridge = new OnlineConnect({
        projectRoot: tmpDir,
        nickname: 'test',
        token: 'tok',
      });

      const ok = bridge.syncLocalToOnline({ sendEvent: () => false });
      expect(ok).toBe(false);
      expect(bridge.state.last_seq).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Security: connection limits
  test('rejects connections beyond maxConnections', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
      maxConnections: 2,
    });
    await server.start();

    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    // Third connection should be rejected
    const ws3 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const result = await new Promise((resolve) => {
      ws3.once('open', () => resolve('open'));
      ws3.once('error', () => resolve('error'));
      ws3.once('close', () => resolve('close'));
      setTimeout(() => resolve('timeout'), 2000);
    });
    expect(result).not.toBe('open');

    ws1.close();
    ws2.close();
    await server.stop();
  }, 15000);

  // Security: deferred nickname registration (no squatting)
  test('nickname not registered until auth completes', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
    });
    await server.start();

    // ws1 sends hello but does NOT auth
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next1 = createMessageQueue(ws1);
    await waitForOpen(ws1);
    ws1.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'squatter:1', nickname: 'target-nick', world: 'default' },
    }));
    await next1(); // hello_ack
    await next1(); // auth_required
    // Intentionally NOT sending auth

    // ws2 sends hello AND auth with same nickname — should succeed
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next2 = createMessageQueue(ws2);
    await waitForOpen(ws2);
    ws2.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'legit:2', nickname: 'target-nick', world: 'default' },
    }));
    await next2(); // hello_ack
    await next2(); // auth_required
    ws2.send(JSON.stringify({ type: 'auth', method: 'token', token: 'tok' }));
    const authResult = await next2();
    expect(authResult.type).toBe('auth_ok');

    ws1.close();
    ws2.close();
    await server.stop();
  }, 15000);

  // Security: room cap
  test('rejects room creation beyond maxRooms', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'], maxRooms: 2,
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;
    const authH = { Authorization: 'Bearer t' };

    await httpRequest({ method: 'POST', url: base, body: { name: 'r1', type: 'public' }, headers: authH });
    await httpRequest({ method: 'POST', url: base, body: { name: 'r2', type: 'public' }, headers: authH });
    const res = await httpRequest({ method: 'POST', url: base, body: { name: 'r3', type: 'public' }, headers: authH });
    expect(res.status).toBe(429);
    expect(res.data.error).toMatch(/Room limit/);

    await server.stop();
  }, 15000);

  // Security: channel cap
  test('rejects channel creation beyond maxChannels', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'], maxChannels: 1,
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/channels`;
    const authH = { Authorization: 'Bearer t' };

    await httpRequest({ method: 'POST', url: base, body: { name: 'c1' }, headers: authH });
    const res = await httpRequest({ method: 'POST', url: base, body: { name: 'c2' }, headers: authH });
    expect(res.status).toBe(429);
    expect(res.data.error).toMatch(/Channel limit/);

    await server.stop();
  }, 15000);

  // Security: input validation
  test('rejects subscriber_id with control characters', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
    });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next = createMessageQueue(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'evil\x00agent', nickname: 'nick', world: 'default' },
    }));

    const msg = await next();
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('HELLO_INVALID');
    expect(msg.error).toMatch(/invalid characters/);

    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    });
    await server.stop();
  }, 15000);

  test('rejects overly long nickname', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'], maxIdLength: 32,
    });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next = createMessageQueue(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({
      type: 'hello',
      client: { subscriber_id: 'agent:1', nickname: 'x'.repeat(64), world: 'default' },
    }));

    const msg = await next();
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('HELLO_INVALID');
    expect(msg.error).toMatch(/too long/);

    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    });
    await server.stop();
  }, 15000);

  // Security: event payload whitelist
  test('does not forward arbitrary fields in event payload', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;
    const roomRes = await httpRequest({
      method: 'POST', url: base,
      body: { name: 'whitelist-test', type: 'public' },
      headers: { Authorization: 'Bearer tok' },
    });
    const roomId = roomRes.data.room.room_id;

    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next1 = createMessageQueue(ws1);
    const next2 = createMessageQueue(ws2);
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    // Auth both
    for (const [ws, next, id, nick] of [[ws1, next1, 'a:1', 'alice'], [ws2, next2, 'b:2', 'bob']]) {
      ws.send(JSON.stringify({ type: 'hello', client: { subscriber_id: id, nickname: nick, world: 'default' } }));
      await next(); await next();
      ws.send(JSON.stringify({ type: 'auth', method: 'token', token: 'tok' }));
      await next();
      ws.send(JSON.stringify({ type: 'join', room: roomId }));
      await next();
    }

    // Send event with malicious extra fields
    ws1.send(JSON.stringify({
      type: 'event', room: roomId,
      payload: { kind: 'message', text: 'hi' },
      __proto__: { polluted: true },
      constructor: 'evil',
      dangerousField: 'should-not-forward',
    }));

    const received = await next2();
    expect(received.payload.text).toBe('hi');
    expect(received.dangerousField).toBeUndefined();
    expect(received).not.toHaveProperty('dangerousField');

    ws1.close();
    ws2.close();
    await server.stop();
  }, 15000);

  // Security: room password brute-force lockout
  test('locks out after too many failed room password attempts', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
      maxRoomAuthFailures: 3, roomAuthLockoutMs: 60000,
    });
    await server.start();

    // Create private room
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;
    const roomRes = await httpRequest({
      method: 'POST', url: base,
      body: { name: 'locked-room', type: 'private', password: 'secret123' },
      headers: { Authorization: 'Bearer tok' },
    });
    const roomId = roomRes.data.room.room_id;

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next = createMessageQueue(ws);
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'hello', client: { subscriber_id: 'brute:1', nickname: 'bruter', world: 'default' } }));
    await next(); await next();
    ws.send(JSON.stringify({ type: 'auth', method: 'token', token: 'tok' }));
    await next();

    // 3 failed attempts
    for (let i = 0; i < 3; i++) {
      ws.send(JSON.stringify({ type: 'join', room: roomId, password: 'wrong' }));
      const err = await next();
      expect(err.code).toBe('ROOM_PASSWORD_INVALID');
    }

    // 4th attempt should be locked out
    ws.send(JSON.stringify({ type: 'join', room: roomId, password: 'wrong' }));
    const locked = await next();
    expect(locked.code).toBe('ROOM_AUTH_LOCKED');

    // Correct password should also be blocked during lockout
    ws.send(JSON.stringify({ type: 'join', room: roomId, password: 'secret123' }));
    const stillLocked = await next();
    expect(stillLocked.code).toBe('ROOM_AUTH_LOCKED');

    ws.close();
    await server.stop();
  }, 15000);

  // Security: TLS warning on non-localhost
  test('server emits warning when binding non-localhost without TLS', async () => {
    const server = new OnlineServer({
      host: '0.0.0.0', port: 0, tokens: ['tok'],
    });

    const warnings = [];
    server.on('warning', (msg) => warnings.push(msg));

    await server.start();

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/SECURITY WARNING/);
    expect(warnings[0]).toMatch(/0\.0\.0\.0/);
    expect(warnings[0]).toMatch(/without TLS/);

    await server.stop();
  }, 15000);

  // Security: pre-auth connection deadline
  test('disconnects unauthenticated connections after auth deadline', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
      authDeadlineMs: 500, sweepIntervalMs: 200, idleTimeoutMs: 30000,
    });
    await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    await waitForOpen(ws);
    // Do NOT send hello or auth — just idle

    const closeReason = await new Promise((resolve) => {
      const next = createMessageQueue(ws);
      // Wait for server to send error + close
      next(3000).then((msg) => {
        if (msg.code === 'AUTH_DEADLINE') resolve('deadline');
        else resolve(msg.code || 'unknown');
      }).catch(() => resolve('timeout'));
    });

    expect(closeReason).toBe('deadline');

    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else ws.once('close', resolve);
    });
    await server.stop();
  }, 15000);

  // Security: roomAuthFailures cleanup
  test('roomAuthFailures entries are pruned after lockout expires', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['tok'],
      maxRoomAuthFailures: 2, roomAuthLockoutMs: 200,
      sweepIntervalMs: 100, idleTimeoutMs: 30000,
    });
    await server.start();

    // Create a private room
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;
    await httpRequest({
      method: 'POST', url: base,
      body: { name: 'prune-test', type: 'private', password: 'secret' },
      headers: { Authorization: 'Bearer tok' },
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ufoo/online`);
    const next = createMessageQueue(ws);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'hello', client: { subscriber_id: 'prune:1', nickname: 'pruner', world: 'default' } }));
    await next(); await next();
    ws.send(JSON.stringify({ type: 'auth', method: 'token', token: 'tok' }));
    await next();

    // Trigger lockout
    expect(server.roomAuthFailures.size).toBe(0);
    ws.send(JSON.stringify({ type: 'join', room: Array.from(server.rooms.keys())[0], password: 'wrong' }));
    await next();
    ws.send(JSON.stringify({ type: 'join', room: Array.from(server.rooms.keys())[0], password: 'wrong' }));
    await next();
    expect(server.roomAuthFailures.size).toBe(1);

    // Wait for sweep to prune (lockout 200ms + sweep 100ms)
    await new Promise((r) => setTimeout(r, 500));
    expect(server.roomAuthFailures.size).toBe(0);

    ws.close();
    await server.stop();
  }, 15000);

  // Security: room/channel name validation
  test('rejects room name with control characters', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'],
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;
    const res = await httpRequest({
      method: 'POST', url: base,
      body: { name: 'evil\x00room', type: 'public' },
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/invalid characters/);
    await server.stop();
  }, 15000);

  test('rejects channel name with control characters', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'],
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/channels`;
    const res = await httpRequest({
      method: 'POST', url: base,
      body: { name: 'evil\nroom' },
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/invalid characters/);
    await server.stop();
  }, 15000);

  test('rejects overly long channel name', async () => {
    const server = new OnlineServer({
      host: '127.0.0.1', port: 0, tokens: ['t'], maxIdLength: 32,
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/channels`;
    const res = await httpRequest({
      method: 'POST', url: base,
      body: { name: 'x'.repeat(64) },
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/too long/);
    await server.stop();
  }, 15000);

  // Step 10: Client TLS enforcement + warning
  test('client refuses ws:// to non-localhost unless allowed', async () => {
    const OnlineClient = require('../../../src/online/client');
    const client = new OnlineClient({
      url: 'ws://192.168.1.100:8787/ufoo/online',
      subscriberId: 'test:1',
      nickname: 'test',
      token: 'tok',
    });

    let err = null;
    try {
      await client.connect({ timeoutMs: 500 });
    } catch (e) {
      err = e;
    }

    expect(err).toBeTruthy();
    expect(err.message).toMatch(/Refusing to connect/);
  }, 10000);

  test('client emits warning for ws:// to non-localhost when allowed', async () => {
    const OnlineClient = require('../../../src/online/client');
    const client = new OnlineClient({
      url: 'ws://192.168.1.100:8787/ufoo/online',
      subscriberId: 'test:1',
      nickname: 'test',
      token: 'tok',
      allowInsecureWs: true,
    });

    const warnings = [];
    client.on('warning', (msg) => warnings.push(msg));

    // connect() will fail because no server, but warning should be emitted first
    try {
      await client.connect({ timeoutMs: 500 });
    } catch {
      // expected - no server running
    }

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/unencrypted ws:\/\//);
    expect(warnings[0]).toMatch(/192\.168\.1\.100/);
  }, 10000);

  test('client does not warn for ws:// to localhost', async () => {
    const OnlineClient = require('../../../src/online/client');
    const client = new OnlineClient({
      url: 'ws://127.0.0.1:8787/ufoo/online',
      subscriberId: 'test:2',
      nickname: 'test2',
      token: 'tok',
    });

    const warnings = [];
    client.on('warning', (msg) => warnings.push(msg));

    try {
      await client.connect({ timeoutMs: 500 });
    } catch {
      // expected
    }

    expect(warnings.length).toBe(0);
  }, 10000);
});
