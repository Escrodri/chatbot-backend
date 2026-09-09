import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { signToken, verifyToken } from '../src/utils/jwt.util.js';
import { requireAuth, requireAdmin } from '../src/middlewares/auth.middleware.js';
import { pool, query } from '../src/database/index.js';
import bcrypt from 'bcryptjs';
import express from 'express';

after(async () => {
  await pool.end();
});

const TEST_SECRET = 'test_jwt_secret_key_antigravity_sdd_2026_abcdef123456';

// Usuario propio de la suite. Los tests no deben depender de la contraseña
// del administrador sembrado: esa ahora es aleatoria o viene del entorno.
const TEST_ADMIN_EMAIL = 'test-admin@pruebas.local';
const TEST_ADMIN_PASSWORD = 'contrasena-de-prueba-12345';

/** Crea (o actualiza) el administrador de pruebas y devuelve sus credenciales. */
async function ensureTestAdmin() {
  const hash = await bcrypt.hash(TEST_ADMIN_PASSWORD, 10);
  await query(
    `INSERT INTO users (email, password_hash, name, role, is_active)
     VALUES ($1, $2, 'Admin de Pruebas', 'admin', true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true`,
    [TEST_ADMIN_EMAIL, hash]
  );
  return { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD };
}

test('T-20: signToken y verifyToken generan y validan tokens JWT estándar', () => {
  const payload = { id: 1, email: 'tarotista@lecturasdetarte.online', role: 'admin' };
  const token = signToken(payload, TEST_SECRET, 3600);

  assert.ok(typeof token === 'string');
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT debe tener 3 partes (header.payload.signature)');

  const verified = verifyToken(token, TEST_SECRET);
  assert.ok(verified, 'El token debe ser verificado correctamente');
  assert.equal(verified.id, 1);
  assert.equal(verified.email, 'tarotista@lecturasdetarte.online');
  assert.equal(verified.role, 'admin');
  assert.ok(verified.exp > verified.iat);
});

test('T-20: verifyToken rechaza firmas alteradas y manipulaciones (Tampering Protection)', () => {
  const payload = { id: 1, email: 'admin@empresa.com', role: 'admin' };
  const token = signToken(payload, TEST_SECRET, 3600);
  const parts = token.split('.');

  // Alterar payload
  const tamperedPayload = Buffer.from(JSON.stringify({ id: 1, email: 'hacker@empresa.com', role: 'admin' })).toString('base64url');
  const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

  const verified = verifyToken(tamperedToken, TEST_SECRET);
  assert.equal(verified, null, 'Un token con payload alterado debe retornar null');

  // Clave secreta incorrecta
  const verifiedWrongSecret = verifyToken(token, 'wrong_secret_1234567890');
  assert.equal(verifiedWrongSecret, null, 'Un token verificado con clave errónea debe retornar null');
});

test('T-20: verifyToken rechaza tokens expirados', () => {
  const payload = { id: 2, email: 'expirado@empresa.com', role: 'agent' };
  // Expira hace 10 segundos (-10)
  const token = signToken(payload, TEST_SECRET, -10);

  const verified = verifyToken(token, TEST_SECRET);
  assert.equal(verified, null, 'Un token con exp en el pasado debe retornar null');
});

test('T-20: POST /api/auth/login valida email y password obligatorios (400)', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@empresa.com' }) // falta password
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('T-20: POST /api/auth/login rechaza credenciales erróneas con 401', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password: 'password_invalida_999' })
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'Credenciales inválidas');
  } finally {
    server.close();
  }
});

test('T-20: POST /api/auth/login con credenciales válidas retorna 200 y Set-Cookie', async () => {
  const { email, password } = await ensureTestAdmin();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.email, email);
    assert.equal(body.user.role, 'admin');
    assert.ok(body.token);

    // Verificar cabecera Set-Cookie
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'Debe incluir cabecera Set-Cookie');
    assert.ok(setCookie.includes('session_token='), 'La cookie debe contener session_token');
    assert.ok(setCookie.includes('HttpOnly'), 'La cookie debe ser HttpOnly');
  } finally {
    server.close();
  }
});

test('T-20: GET /api/auth/me sin autenticación rechaza con 401 Unauthorized', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('T-20: GET /api/auth/me con cookie de sesión válida retorna datos del usuario', async () => {
  const { email, password } = await ensureTestAdmin();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    // 1. Iniciar sesión para obtener cookie
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('set-cookie');

    // 2. Consultar /me enviando la cookie
    const meRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: {
        Cookie: setCookie
      }
    });

    assert.equal(meRes.status, 200);
    const meBody = await meRes.json();
    assert.equal(meBody.user.email, email);
    assert.equal(meBody.user.role, 'admin');
    assert.equal(meBody.user.password_hash, undefined, 'Jamás debe exponer el hash de la contraseña');
  } finally {
    server.close();
  }
});

test('T-20: requireAdmin restringe acceso a usuarios con rol agent (403 Forbidden)', async () => {
  const app = express();
  app.use(express.json());

  // Simular middleware inyectando usuario rol 'agent'
  app.get('/admin-only', (req, res, next) => {
    req.user = { id: 99, email: 'tarotista_junior@lecturasdetarte.online', role: 'agent' };
    next();
  }, requireAdmin, (req, res) => {
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin-only`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'Acceso restringido a administradores');
  } finally {
    server.close();
  }
});

test('T-20: POST /api/auth/logout limpia la cookie session_token con 200', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: 'POST'
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie);
    // Cookie debe estar expirada o vaciada
    assert.ok(setCookie.includes('session_token=;') || setCookie.includes('Max-Age=0') || setCookie.includes('Expires='));
  } finally {
    server.close();
  }
});
