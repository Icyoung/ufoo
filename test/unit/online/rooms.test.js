const OnlineServer = require('../../../src/online');

function httpRequest({ method, url, body }) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
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

describe('OnlineServer rooms (HTTP)', () => {
  test('create + list rooms', async () => {
    const server = new OnlineServer({ host: '127.0.0.1', port: 0, tokens: ['x'] });
    await server.start();
    const base = `http://127.0.0.1:${server.port}/ufoo/online/rooms`;

    const createPublic = await httpRequest({
      method: 'POST',
      url: base,
      body: { name: 'lobby', type: 'public' },
    });
    expect(createPublic.status).toBe(200);
    expect(createPublic.data.ok).toBe(true);
    expect(createPublic.data.room.room_id).toMatch(/^room_\d{6}$/);

    const createPrivate = await httpRequest({
      method: 'POST',
      url: base,
      body: { name: 'secret', type: 'private', password: 'pwd' },
    });
    expect(createPrivate.status).toBe(200);
    expect(createPrivate.data.ok).toBe(true);
    expect(createPrivate.data.room.room_id).toMatch(/^room_\d{6}$/);

    const list = await httpRequest({ method: 'GET', url: base });
    expect(list.status).toBe(200);
    expect(list.data.rooms.length).toBe(2);
    expect(list.data.rooms[0].room_id).toBeDefined();

    await server.stop();
  }, 15000);
});
