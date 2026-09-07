import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizerService } from '../src/services/index.js';

test('T-10: normalizerService procesa mensaje entrante de WhatsApp Cloud API', () => {
  const waPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: 'PHONE_NUMBER_ID_VENTAS'
          },
          contacts: [{
            profile: { name: 'Juan Perez' },
            wa_id: '5491198765432'
          }],
          messages: [{
            from: '5491198765432',
            id: 'wamid.HBgLNTQ5MTE5ODc2NTQzMhUCABEYEjA1M',
            timestamp: '1725700000',
            text: { body: 'Hola, quiero información sobre el producto' },
            type: 'text'
          }]
        }
      }]
    }]
  };

  const events = normalizerService.normalizeWebhookPayload(waPayload);
  assert.equal(events.length, 1);
  const ev = events[0];

  assert.equal(ev.platform, 'whatsapp');
  assert.equal(ev.channelIdentifier, 'PHONE_NUMBER_ID_VENTAS');
  assert.equal(ev.eventType, 'message');
  assert.equal(ev.isEcho, false);
  assert.equal(ev.sender.name, 'Juan Perez');
  assert.equal(ev.sender.id, '5491198765432');
  assert.equal(ev.message.text, 'Hola, quiero información sobre el producto');
  assert.equal(ev.message.id, 'wamid.HBgLNTQ5MTE5ODc2NTQzMhUCABEYEjA1M');
});

test('T-10: normalizerService detecta message_echoes en Facebook Messenger (Operador externo)', () => {
  const fbEchoPayload = {
    object: 'page',
    entry: [{
      id: 'PAGE_ID_SUCURSAL_CENTRO',
      time: 1725700010,
      messaging: [{
        sender: { id: 'PAGE_ID_SUCURSAL_CENTRO' },
        recipient: { id: 'CUSTOMER_PSID_777' },
        timestamp: 1725700010,
        message: {
          is_echo: true,
          mid: 'm_mid.$cAAEv123456',
          text: 'Hola, te habla el asesor desde Business Suite'
        }
      }]
    }]
  };

  const events = normalizerService.normalizeWebhookPayload(fbEchoPayload);
  assert.equal(events.length, 1);
  const ev = events[0];

  assert.equal(ev.platform, 'facebook');
  assert.equal(ev.channelIdentifier, 'PAGE_ID_SUCURSAL_CENTRO');
  assert.equal(ev.eventType, 'echo');
  assert.equal(ev.isEcho, true);
  assert.equal(ev.sender.id, 'CUSTOMER_PSID_777');
  assert.equal(ev.message.direction, 'outbound');
  assert.equal(ev.message.senderType, 'agent');
  assert.equal(ev.message.text, 'Hola, te habla el asesor desde Business Suite');
});

test('T-10: normalizerService procesa mensaje de Instagram Direct', () => {
  const igPayload = {
    object: 'instagram',
    entry: [{
      id: 'IG_ACCOUNT_ID_MODA',
      time: 1725700020,
      messaging: [{
        sender: { id: 'IG_USER_IGSID_888' },
        recipient: { id: 'IG_ACCOUNT_ID_MODA' },
        timestamp: 1725700020,
        message: {
          mid: 'm_a_ig_msg_999',
          text: '¿Tienen stock en talle M?'
        }
      }]
    }]
  };

  const events = normalizerService.normalizeWebhookPayload(igPayload);
  assert.equal(events.length, 1);
  const ev = events[0];

  assert.equal(ev.platform, 'instagram');
  assert.equal(ev.channelIdentifier, 'IG_ACCOUNT_ID_MODA');
  assert.equal(ev.eventType, 'message');
  assert.equal(ev.message.text, '¿Tienen stock en talle M?');
});
