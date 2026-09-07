import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';

test('T-11: GET /api/webhook handshake exitoso con hub.challenge', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const challengeText = 'challenge_test_code_123456789';
    const verifyToken = config.meta.verifyToken;

    const url = `http://127.0.0.1:${port}/api/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(challengeText)}`;
    const res = await fetch(url);

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body, challengeText, 'Debe devolver exactamente el string hub.challenge sin envolver en JSON');
  } finally {
    server.close();
  }
});

test('T-11: GET /api/webhook rechaza token incorrecto con 403 Forbidden', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const url = `http://127.0.0.1:${port}/api/webhook?hub.mode=subscribe&hub.verify_token=wrong_token_here&hub.challenge=123`;
    const res = await fetch(url);

    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'ERR_INVALID_VERIFY_TOKEN');
  } finally {
    server.close();
  }
});
