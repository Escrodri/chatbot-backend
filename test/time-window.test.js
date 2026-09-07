import assert from 'node:assert/strict';
import test from 'node:test';
import { timeUtil } from '../src/utils/index.js';
import { graphApiService } from '../src/services/index.js';

test('T-16: timeUtil valida ventana estándar dentro de 24 horas', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  
  const wa = timeUtil.checkMessagingWindow(twoHoursAgo, 'whatsapp');
  assert.equal(wa.isOpen, true);
  assert.equal(wa.canSendFreeText, true);
  assert.equal(wa.requiresHumanAgentTag, false);
  assert.equal(wa.requiresTemplate, false);
  assert.equal(wa.windowType, 'standard_24h');

  const fb = timeUtil.checkMessagingWindow(twoHoursAgo, 'facebook');
  assert.equal(fb.isOpen, true);
  assert.equal(fb.requiresHumanAgentTag, false);
});

test('T-16: timeUtil activa HUMAN_AGENT en Messenger e Instagram entre 24h y 7 días', () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000); // 72 horas

  const fb = timeUtil.checkMessagingWindow(threeDaysAgo, 'facebook');
  assert.equal(fb.isOpen, true);
  assert.equal(fb.canSendFreeText, true);
  assert.equal(fb.requiresHumanAgentTag, true);
  assert.equal(fb.windowType, 'human_agent_7d');

  const ig = timeUtil.checkMessagingWindow(threeDaysAgo, 'instagram');
  assert.equal(ig.isOpen, true);
  assert.equal(ig.requiresHumanAgentTag, true);

  // En WhatsApp a las 72 horas NO se puede enviar texto libre
  const wa = timeUtil.checkMessagingWindow(threeDaysAgo, 'whatsapp');
  assert.equal(wa.isOpen, false);
  assert.equal(wa.canSendFreeText, false);
  assert.equal(wa.requiresTemplate, true);
});

test('T-16: timeUtil marca expirada cualquier ventana superados los 7 días (168h)', () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000); // 192 horas

  const fb = timeUtil.checkMessagingWindow(eightDaysAgo, 'facebook');
  assert.equal(fb.isOpen, false);
  assert.equal(fb.canSendFreeText, false);
  assert.equal(fb.windowType, 'expired');
});

test('T-16: graphApiService rechaza texto libre en WhatsApp fuera de 24h', async () => {
  const thirtyHoursAgo = new Date(Date.now() - 30 * 3600 * 1000);
  const mockChannel = {
    id: 1,
    name: 'WA Ventas',
    platform: 'whatsapp',
    channel_identifier: '123456',
    accessToken: 'EAAB_test_token'
  };

  await assert.rejects(
    async () => {
      await graphApiService.sendMessage({
        channel: mockChannel,
        recipientId: '5491112345678',
        text: 'Hola cliente',
        lastCustomerInteraction: thirtyHoursAgo
      });
    },
    (err) => {
      assert.equal(err.code, 'ERR_WHATSAPP_24H_WINDOW_EXPIRED');
      return true;
    }
  );
});
