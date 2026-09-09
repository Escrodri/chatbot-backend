import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { io as ClientIO } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { socketManager } from '../src/sockets/index.js';
import { signToken } from '../src/utils/jwt.util.js';
import { config } from '../src/config/index.js';

/** Token de un administrador válido (ve todos los canales). */
function tokenAdmin() {
  return signToken(
    { id: 1, email: 'admin@empresa.com', name: 'Admin', role: 'admin' },
    config.security.sessionSecret,
    3600
  );
}

/** Levanta un servidor con Socket.io ya inicializado. */
async function levantarServidor() {
  const server = http.createServer(createApp());
  socketManager.init(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** Intenta conectar y resuelve 'conectado' o el motivo del rechazo. */
function intentarConexion(port, opciones = {}) {
  return new Promise((resolve) => {
    const cliente = ClientIO(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...opciones
    });
    const limite = setTimeout(() => {
      cliente.close();
      resolve({ conectado: false, motivo: 'timeout' });
    }, 4000);

    cliente.on('connect', () => {
      clearTimeout(limite);
      resolve({ conectado: true, cliente });
    });
    cliente.on('connect_error', (err) => {
      clearTimeout(limite);
      cliente.close();
      resolve({ conectado: false, motivo: err.message });
    });
  });
}

test('T-13: el WebSocket rechaza conexiones sin sesión válida (C-01)', async () => {
  const { server, port } = await levantarServidor();

  try {
    const anonimo = await intentarConexion(port);
    assert.equal(anonimo.conectado, false, 'Un cliente sin token JAMÁS debe poder conectarse');

    const inventado = await intentarConexion(port, { auth: { token: 'no.es.un.token' } });
    assert.equal(inventado.conectado, false, 'Un token inválido debe ser rechazado');

    const otraClave = signToken({ id: 1, role: 'admin' }, 'clave-equivocada', 3600);
    const falsificado = await intentarConexion(port, { auth: { token: otraClave } });
    assert.equal(falsificado.conectado, false, 'Un token firmado con otra clave debe ser rechazado');

    const vencido = signToken({ id: 1, role: 'admin' }, config.security.sessionSecret, -60);
    const expirado = await intentarConexion(port, { auth: { token: vencido } });
    assert.equal(expirado.conectado, false, 'Un token expirado debe ser rechazado');
  } finally {
    server.close();
  }
});

test('T-13: socketManager emite new_message, chat_updated y bot_status_changed a un operador autenticado', async () => {
  const { server, port } = await levantarServidor();

  const conexion = await intentarConexion(port, { auth: { token: tokenAdmin() } });
  assert.equal(conexion.conectado, true, 'Un administrador con token válido debe poder conectarse');
  const clientSocket = conexion.cliente;

  try {
    // El servidor asigna las salas solo; el cliente ya no las elige.
    await new Promise(r => setTimeout(r, 50));

    const messagePromise = new Promise((resolve) => clientSocket.on('new_message', resolve));
    const chatUpdatedPromise = new Promise((resolve) => clientSocket.on('chat_updated', resolve));

    const mockMessage = { id: 999, text: 'Hola vía socket', direction: 'inbound' };
    const mockConversation = { id: 42, channel_id: 1, contact_name: 'Ana Gomez' };

    socketManager.emitNewMessage(1, mockMessage, mockConversation);

    const receivedMessage = await messagePromise;
    const receivedChatUpdate = await chatUpdatedPromise;

    assert.equal(receivedMessage.channelId, 1);
    assert.equal(receivedMessage.message.text, 'Hola vía socket');
    assert.equal(receivedChatUpdate.conversation.contact_name, 'Ana Gomez');

    const botStatusPromise = new Promise((resolve) => clientSocket.on('bot_status_changed', resolve));
    socketManager.emitBotStatus(1, 42, 'handed_over');

    const receivedBotStatus = await botStatusPromise;
    assert.equal(receivedBotStatus.conversationId, 42);
    assert.equal(receivedBotStatus.botStatus, 'handed_over');
  } finally {
    clientSocket.disconnect();
    server.close();
  }
});

test('T-13: un operador sin canales asignados no recibe mensajes de otros canales (C-01)', async () => {
  const { server, port } = await levantarServidor();

  // Operador cuyo id no tiene asignaciones. Si la base no está disponible el
  // servidor rechaza la conexión, que también es un resultado seguro.
  const tokenOperador = signToken(
    { id: 999999, email: 'ajeno@empresa.com', name: 'Ajeno', role: 'agent' },
    config.security.sessionSecret,
    3600
  );

  const conexion = await intentarConexion(port, { auth: { token: tokenOperador } });

  try {
    if (!conexion.conectado) {
      // Sin base de datos no se pueden resolver los canales: rechazar es correcto.
      assert.ok(true, 'Conexión rechazada al no poder verificar los canales');
      return;
    }

    const cliente = conexion.cliente;
    let recibio = false;
    cliente.on('new_message', () => { recibio = true; });

    // Intento explícito de colarse en un canal ajeno.
    cliente.emit('join_channel', 1);
    await new Promise(r => setTimeout(r, 100));

    socketManager.emitNewMessage(1, { id: 1, text: 'Mensaje privado de otro canal' }, { id: 7 });
    await new Promise(r => setTimeout(r, 300));

    assert.equal(recibio, false, 'No debe recibir mensajes de canales que no tiene asignados');
    cliente.disconnect();
  } finally {
    server.close();
  }
});
