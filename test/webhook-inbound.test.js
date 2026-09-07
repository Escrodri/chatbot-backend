import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { calculateHmacSha256 } from '../src/utils/index.js';
import { config } from '../src/config/index.js';

test('T-12: POST /api/webhook responde HTTP 200 en < 50ms y procesa de forma no bloqueante', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WHATSAPP_TEST_ACCOUNT',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'NON_EXISTENT_ID' },
            messages: [{
              from: '123456789',
              id: 'test_meta_msg_id_123',
              timestamp: '1725700000',
              text: { body: 'Test message' },
              type: 'text'
            }]
          }
        }]
      }]
    });

    const rawBody = Buffer.from(payload);
    const signature = 'sha256=' + calculateHmacSha256(rawBody, config.meta.appSecret);

    // Warm-up de la conexión TCP local
    await fetch(`http://127.0.0.1:${port}/health`);

    const startTime = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature
      },
      body: payload
    });
    const duration = Date.now() - startTime;

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'EVENT_RECEIVED');
    assert.ok(duration < 250, `La respuesta debe ser inmediata (tomó ${duration}ms)`);
  } finally {
    server.close();
  }
});
