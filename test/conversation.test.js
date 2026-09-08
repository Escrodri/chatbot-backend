import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { signToken } from '../src/utils/jwt.util.js';
import { config } from '../src/config/index.js';
import { pool, query } from '../src/database/index.js';
import { channelRepository } from '../src/repositories/channel.repository.js';
import { contactRepository } from '../src/repositories/contact.repository.js';
import { conversationRepository } from '../src/repositories/conversation.repository.js';

const ADMIN_PAYLOAD = { id: 1, email: 'admin@empresa.com', name: 'Admin', role: 'admin' };
let adminToken;
let server;
let baseUrl;
let testChannelId;
let testContactId;
let testConversationId;

after(async () => {
  if (server) {
    server.close();
  }
  // Limpieza de datos de prueba
  if (testChannelId) {
    await query('DELETE FROM channels WHERE id = $1', [testChannelId]);
  }
  await pool.end();
});

test('T-24: Setup servidor y datos de prueba para conversaciones', async () => {
  adminToken = signToken(ADMIN_PAYLOAD, config.security.sessionSecret, 3600);

  const app = createApp();
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // 1. Crear canal de prueba
  const testIdentifier = `test_conv_ident_${Date.now()}`;
  const ch = await channelRepository.create({
    platform: 'whatsapp',
    name: 'WhatsApp Tarot Conv Test',
    channelIdentifier: testIdentifier,
    accessToken: 'EAAB_test_conversation_token_2026'
  });
  testChannelId = ch.id;

  // 2. Crear contacto de prueba
  const ct = await contactRepository.findOrCreate({
    channelId: testChannelId,
    platform: 'whatsapp',
    platformUserId: '+5491199887766',
    name: 'María Consultante Test',
    phoneOrUsername: '+5491199887766'
  });
  testContactId = ct.id;

  // 3. Crear conversación de prueba
  const conv = await conversationRepository.findOrCreateByContact(testChannelId, testContactId);
  testConversationId = conv.id;

  // Simular mensaje entrante del cliente
  await conversationRepository.touchCustomerInteraction(testConversationId, 'Hola, quiero una lectura de cartas', new Date());

  assert.ok(testConversationId);
});

test('T-24: Endpoints de conversaciones rechazan peticiones sin autenticación (401 Unauthorized)', async () => {
  const endpoints = [
    { path: '/api/conversations', method: 'GET' },
    { path: `/api/conversations/${testConversationId}`, method: 'GET' },
    { path: `/api/conversations/${testConversationId}/messages`, method: 'GET' },
    { path: `/api/conversations/${testConversationId}/messages`, method: 'POST', body: { text: 'test' } },
    { path: `/api/conversations/${testConversationId}/bot-toggle`, method: 'POST', body: { botStatus: 'active' } }
  ];

  for (const ep of endpoints) {
    const res = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: ep.body ? { 'Content-Type': 'application/json' } : {},
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.equal(res.status, 401, `Endpoint ${ep.method} ${ep.path} debió retornar 401`);
  }
});

test('T-24: GET /api/conversations lista chats con cálculo de ventana 24h y filtros', async () => {
  const res = await fetch(`${baseUrl}/api/conversations?platform=whatsapp`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));

  const found = list.find(c => c.id === testConversationId);
  assert.ok(found, 'La conversación de prueba debe estar presente en la lista');
  assert.equal(found.contact_name, 'María Consultante Test');
  assert.equal(found.platform, 'whatsapp');
  assert.ok(found.window_status);
  assert.equal(found.window_status.canSendFreeText, true);
});

test('T-24: POST /api/conversations/:id/messages inserta mensaje humano y activa Handover', async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${testConversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      text: 'Hola María, soy tu tarotista. Vamos a barajar los arcanos mayores.'
    })
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.message.id);
  assert.equal(data.message.sender_type, 'agent');
  assert.equal(data.message.direction, 'outbound');
  assert.equal(data.message.text, 'Hola María, soy tu tarotista. Vamos a barajar los arcanos mayores.');

  // Verificar que la conversación pasó a estado handed_over (Handover Protocol)
  const conv = await conversationRepository.findById(testConversationId);
  assert.equal(conv.bot_status, 'handed_over');
  assert.equal(conv.last_message_text, 'Hola María, soy tu tarotista. Vamos a barajar los arcanos mayores.');
});

test('T-24: GET /api/conversations/:id/messages devuelve historial Keyset y resetea no leídos', async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${testConversationId}/messages?limit=20`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.conversation_id, testConversationId);
  assert.ok(Array.isArray(data.messages));
  assert.ok(data.messages.length > 0);

  // Verificar reseteo de unread_count
  const conv = await conversationRepository.findById(testConversationId);
  assert.equal(conv.unread_count, 0, 'El contador de no leídos debe estar en 0 tras abrir el chat');
});

test('T-24: POST /api/conversations/:id/bot-toggle conmuta manualmente el estado del bot', async () => {
  const res = await fetch(`${baseUrl}/api/conversations/${testConversationId}/bot-toggle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ botStatus: 'active' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.botStatus, 'active');

  const conv = await conversationRepository.findById(testConversationId);
  assert.equal(conv.bot_status, 'active');
});
