import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { parseSignedRequest } from '../src/controllers/data-deletion.controller.js';

test('T-19: parseSignedRequest decodifica y valida correctamente payload firmado de Meta', () => {
  const secret = config.meta.appSecret;
  const payloadData = {
    user_id: '123456789012345',
    algorithm: 'HMAC-SHA256',
    issued_at: Math.floor(Date.now() / 1000)
  };

  const encodedPayload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
  const expectedSig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const validSignedRequest = `${expectedSig}.${encodedPayload}`;

  const result = parseSignedRequest(validSignedRequest, secret);
  assert.ok(result, 'Debe decodificar el signed_request válido');
  assert.equal(result.user_id, '123456789012345');
  assert.equal(result.algorithm, 'HMAC-SHA256');
});

test('T-19: parseSignedRequest rechaza firmas adulteradas (Tampering Protection)', () => {
  const secret = config.meta.appSecret;
  const payloadData = {
    user_id: '123456789012345',
    algorithm: 'HMAC-SHA256'
  };

  const encodedPayload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
  const forgedSig = crypto.createHmac('sha256', 'wrong_secret').update(encodedPayload).digest('base64url');
  const forgedSignedRequest = `${forgedSig}.${encodedPayload}`;

  const result = parseSignedRequest(forgedSignedRequest, secret);
  assert.equal(result, null, 'Debe retornar null ante firma manipulada');
});

test('T-19: POST /api/compliance/data-deletion responde con confirmation_code y url conforme a Meta', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const secret = config.meta.appSecret;
    const payloadData = {
      user_id: '9988776655',
      algorithm: 'HMAC-SHA256',
      issued_at: Math.floor(Date.now() / 1000)
    };
    const encodedPayload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
    const expectedSig = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    const validSignedRequest = `${expectedSig}.${encodedPayload}`;

    const res = await fetch(`http://127.0.0.1:${port}/api/compliance/data-deletion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_request: validSignedRequest })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.confirmation_code, 'Debe incluir confirmation_code');
    assert.ok(data.url, 'Debe incluir url de seguimiento');
    assert.match(data.url, new RegExp(data.confirmation_code));
  } finally {
    server.close();
  }
});
