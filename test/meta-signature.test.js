import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import express from 'express';
import { rawBodyJsonParser, verifyMetaSignature } from '../src/middlewares/index.js';
import { calculateHmacSha256 } from '../src/utils/index.js';
import { config } from '../src/config/index.js';

test('T-08: verifyMetaSignature valida y permite payloads legítimos de Meta', async () => {
  const app = express();
  app.use(rawBodyJsonParser);
  app.post('/webhook', verifyMetaSignature, (req, res) => {
    res.status(200).json({ status: 'EVENT_RECEIVED' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const rawBody = Buffer.from(payload);
    const signature = 'sha256=' + calculateHmacSha256(rawBody, config.meta.appSecret);

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature
      },
      body: payload
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'EVENT_RECEIVED');
  } finally {
    server.close();
  }
});

test('T-08: verifyMetaSignature rechaza firmas alteradas con 403 Forbidden', async () => {
  const app = express();
  app.use(rawBodyJsonParser);
  app.post('/webhook', verifyMetaSignature, (req, res) => {
    res.status(200).json({ status: 'SHOULD_NOT_REACH' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const payload = JSON.stringify({ object: 'page', entry: [] });
    // Firma inválida
    const fakeSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': fakeSignature
      },
      body: payload
    });

    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'ERR_INVALID_META_SIGNATURE');
  } finally {
    server.close();
  }
});
