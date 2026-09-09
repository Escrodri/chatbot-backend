import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { signToken } from '../src/utils/jwt.util.js';
import { config } from '../src/config/index.js';

// El simulador ahora exige sesión de administrador (A-01).
const adminToken = signToken(
  { id: 1, email: 'admin@empresa.com', name: 'Admin', role: 'admin' },
  config.security.sessionSecret,
  3600
);
const authHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${adminToken}`
};

test('T-12: POST /api/test/simulate-inbound encola mensaje simulado con 200 OK', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const payload = {
      platform: 'whatsapp',
      channelIdentifier: 'MOCK_WA_123',
      senderId: '5491112345678',
      senderName: 'Usuario Simulado',
      text: 'Mensaje de prueba para el inbox'
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/test/simulate-inbound`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.simulated.metaMessageId);
  } finally {
    server.close();
  }
});

test('T-12: POST /api/test/simulate-inbound valida channelIdentifier requerido', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/test/simulate-inbound`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: 'Sin canal' })
    });

    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('T-12: POST /api/test/simulate-inbound rechaza peticiones sin sesión (A-01)', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/test/simulate-inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelIdentifier: 'MOCK_WA_123', text: 'Intento anónimo' })
    });

    assert.equal(res.status, 401, 'Sin sesión debe responder 401, no simular nada');
  } finally {
    server.close();
  }
});

test('T-12: POST /api/test/simulate-inbound rechaza a operadores sin rol admin (A-01)', async () => {
  const agentToken = signToken(
    { id: 2, email: 'operador@empresa.com', name: 'Operador', role: 'agent' },
    config.security.sessionSecret,
    3600
  );

  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/test/simulate-inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ channelIdentifier: 'MOCK_WA_123', text: 'Intento de operador' })
    });

    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
