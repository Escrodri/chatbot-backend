import assert from 'node:assert/strict';
import test from 'node:test';
import { webhookService } from '../src/services/webhook.service.js';

test('T-17: webhookService.processPayload procesa payloads vacíos o desconocidos sin lanzar error', async () => {
  // Payload nulo
  await assert.doesNotReject(async () => {
    await webhookService.processPayload(null);
  });

  // Payload desconocido
  await assert.doesNotReject(async () => {
    await webhookService.processPayload({ object: 'unknown_object', entry: [] });
  });
});
