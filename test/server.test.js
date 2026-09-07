import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';

test('T-07: Servidor Express responde a /health con 200 OK', async () => {
  const app = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
    assert.ok(body.timestamp);
  } finally {
    server.close();
  }
});

test('T-07: rawBodyJsonParser preserva req.rawBody como Buffer exacto', async () => {
  const app = createApp();
  
  // Ruta de prueba para verificar captura de rawBody
  app.post('/test-raw-body', (req, res) => {
    assert.ok(Buffer.isBuffer(req.rawBody), 'req.rawBody debe ser una instancia de Buffer');
    assert.equal(req.rawBody.toString('utf8'), JSON.stringify(req.body));
    res.json({ ok: true, rawLength: req.rawBody.length });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const payload = { hello: 'meta_webhook_payload_test', count: 42 };
    const res = await fetch(`http://127.0.0.1:${port}/test-raw-body`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.rawLength > 0);
  } finally {
    server.close();
  }
});
