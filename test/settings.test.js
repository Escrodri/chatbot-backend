import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { signToken } from '../src/utils/jwt.util.js';
import { config } from '../src/config/index.js';
import { pool, query } from '../src/database/index.js';

const ADMIN_PAYLOAD = { id: 1, email: 'admin@empresa.com', name: 'Admin', role: 'admin' };
const AGENT_PAYLOAD = { id: 2, email: 'operador@empresa.com', name: 'Operador', role: 'agent' };

let adminToken;
let agentToken;
let server;
let baseUrl;

after(async () => {
  if (server) {
    server.close();
  }
  // Limpiar canales o usuarios creados durante tests
  await query("DELETE FROM channels WHERE channel_identifier LIKE 'test_identifier_sdd_%'");
  await query("DELETE FROM users WHERE email LIKE 'test_sdd_%'");
  await pool.end();
});

test('T-22: Setup servidor de pruebas para Settings', async () => {
  adminToken = signToken(ADMIN_PAYLOAD, config.security.sessionSecret, 3600);
  agentToken = signToken(AGENT_PAYLOAD, config.security.sessionSecret, 3600);

  const app = createApp();
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  assert.ok(baseUrl);
});

test('T-22: Settings endpoints rechazan peticiones sin autenticación (401 Unauthorized)', async () => {
  const endpoints = [
    { path: '/api/settings/channels', method: 'GET' },
    { path: '/api/settings/channels', method: 'POST', body: {} },
    { path: '/api/settings/bot', method: 'GET' },
    { path: '/api/settings/bot', method: 'POST', body: {} },
    { path: '/api/settings/users', method: 'GET' },
    { path: '/api/settings/users', method: 'POST', body: {} },
    { path: '/api/settings/logs', method: 'GET' }
  ];

  for (const ep of endpoints) {
    const res = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: ep.body ? { 'Content-Type': 'application/json' } : {},
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.equal(res.status, 401, `Endpoint ${ep.method} ${ep.path} debió rechazar con 401`);
  }
});

test('T-22: Settings endpoints rechazan peticiones con rol agent (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/api/settings/channels`, {
    headers: { 'Authorization': `Bearer ${agentToken}` }
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'Acceso restringido a administradores');
});

test('T-22: GET /api/settings/channels con admin retorna 200 y omite tokens', async () => {
  const res = await fetch(`${baseUrl}/api/settings/channels`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  assert.equal(res.status, 200);
  const channels = await res.json();
  assert.ok(Array.isArray(channels));

  // Verificar que ningún canal exponga secretos criptográficos
  for (const ch of channels) {
    assert.equal(ch.access_token_encrypted, undefined);
    assert.equal(ch.token_iv, undefined);
    assert.equal(ch.token_tag, undefined);
    assert.equal(ch.accessToken, undefined);
  }
});

test('T-22: POST, PUT y DELETE /api/settings/channels gestiona canales con cifrado AES-256-GCM', async () => {
  const testIdentifier = `test_identifier_sdd_${Date.now()}`;
  const rawToken = 'EAAB_test_token_sdd_super_secret_tarot_2026';

  // 1. POST: Crear canal
  const createRes = await fetch(`${baseUrl}/api/settings/channels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      platform: 'whatsapp',
      name: 'WhatsApp Tarot Test',
      channelIdentifier: testIdentifier,
      accessToken: rawToken,
      colorTag: '#D4AF37'
    })
  });

  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.ok(created.id);
  assert.equal(created.name, 'WhatsApp Tarot Test');
  assert.equal(created.channel_identifier, testIdentifier);
  assert.equal(created.platform, 'whatsapp');

  const channelId = created.id;

  // 2. Verificar en BD que el token se almacenó CIFRADO con AES-256-GCM
  const { rows } = await query('SELECT * FROM channels WHERE id = $1', [channelId]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].access_token_encrypted, rawToken, 'El token nunca debe estar en texto plano en la BD');
  assert.ok(rows[0].token_iv);
  assert.ok(rows[0].token_tag);

  // 3. PUT: Actualizar nombre y color
  const updateRes = await fetch(`${baseUrl}/api/settings/channels/${channelId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      name: 'WhatsApp Tarot Test Renombrado',
      colorTag: '#9333EA',
      status: 'paused'
    })
  });

  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.equal(updated.name, 'WhatsApp Tarot Test Renombrado');
  assert.equal(updated.color_tag, '#9333EA');
  assert.equal(updated.status, 'paused');

  // 4. DELETE: Eliminar canal
  const deleteRes = await fetch(`${baseUrl}/api/settings/channels/${channelId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  assert.equal(deleteRes.status, 200);
  const deleteBody = await deleteRes.json();
  assert.equal(deleteBody.success, true);

  // 5. Verificar que ya no existe (soft-deleted)
  const { rows: afterDelete } = await query('SELECT id FROM channels WHERE id = $1 AND deleted_at IS NULL', [channelId]);
  assert.equal(afterDelete.length, 0);
});

test('T-22: GET y POST /api/settings/bot consulta y persiste configuración de bienvenida', async () => {
  // 1. GET inicial
  const getRes = await fetch(`${baseUrl}/api/settings/bot`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  assert.equal(getRes.status, 200);
  const botSettings = await getRes.json();
  assert.ok('is_enabled' in botSettings);
  assert.ok('welcome_message' in botSettings);

  // 2. POST guardar mensaje místico
  const testMessage = `¡Saludos de luz {{cliente}}! Bienvenido a Lecturas de Tarot. Un tarotista leerá tus cartas a la brevedad.`;
  const postRes = await fetch(`${baseUrl}/api/settings/bot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      isEnabled: true,
      welcomeMessage: testMessage,
      inactivityHours: 12
    })
  });

  assert.equal(postRes.status, 200);
  const saved = await postRes.json();
  assert.equal(saved.welcome_message, testMessage);
  assert.equal(saved.inactivity_hours, 12);
  assert.equal(saved.is_enabled, true);
});

test('T-22: GET y POST /api/settings/users lista y crea operadores con hash seguro', async () => {
  // 1. GET lista
  const getRes = await fetch(`${baseUrl}/api/settings/users`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  assert.equal(getRes.status, 200);
  const users = await getRes.json();
  assert.ok(Array.isArray(users));
  assert.ok(users.length > 0);
  // Verificar que ningún usuario exponga password_hash
  for (const u of users) {
    assert.equal(u.password_hash, undefined);
  }

  // 2. POST crear nuevo operador
  const uniqueEmail = `test_sdd_${Date.now()}@lecturasdetarte.online`;
  const postRes = await fetch(`${baseUrl}/api/settings/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      email: uniqueEmail,
      name: 'Tarotista Estrella',
      password: 'passwordSeguro123',
      role: 'agent'
    })
  });

  assert.equal(postRes.status, 201);
  const created = await postRes.json();
  assert.equal(created.email, uniqueEmail);
  assert.equal(created.name, 'Tarotista Estrella');
  assert.equal(created.role, 'agent');
  assert.equal(created.password_hash, undefined);
});

test('T-22: GET /api/settings/logs retorna registros de auditoría de webhooks', async () => {
  const res = await fetch(`${baseUrl}/api/settings/logs?limit=10`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  assert.equal(res.status, 200);
  const logs = await res.json();
  assert.ok(Array.isArray(logs));
});

test('T-22: POST /api/settings/channels/scan-facebook-pages valida token obligatorio', async () => {
  const res = await fetch(`${baseUrl}/api/settings/channels/scan-facebook-pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ userToken: '' })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('obligatorio'));
});

test('T-22: POST /api/settings/channels/connect-facebook-pages conecta lista de páginas seleccionadas', async () => {
  const pageId = `fb_page_test_${Date.now()}`;
  const res = await fetch(`${baseUrl}/api/settings/channels/connect-facebook-pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      pages: [
        {
          id: pageId,
          name: 'Fan Page Tarot Test',
          accessToken: 'EAAB_test_page_token_mock_2026',
          connectInstagram: false
        }
      ]
    })
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.channels));
  assert.equal(data.channels[0].channel_identifier, pageId);
});
