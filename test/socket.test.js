import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { io as ClientIO } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { socketManager } from '../src/sockets/index.js';

test('T-13: socketManager emite eventos new_message, chat_updated y bot_status_changed en tiempo real', async () => {
  const app = createApp();
  const server = http.createServer(app);
  
  // Inicializar sockets sobre el servidor HTTP de test
  socketManager.init(server);

  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  // Conectar cliente Socket.io
  const clientSocket = ClientIO(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true
  });

  await new Promise((resolve) => clientSocket.on('connect', resolve));

  // Unirse a las salas
  clientSocket.emit('join_channel', 1);
  clientSocket.emit('join_inbox');

  await new Promise(r => setTimeout(r, 50)); // Breve espera para que el handshake de salas se complete

  // 1. Probar recepción de new_message y chat_updated
  const messagePromise = new Promise((resolve) => {
    clientSocket.on('new_message', (data) => {
      resolve(data);
    });
  });

  const chatUpdatedPromise = new Promise((resolve) => {
    clientSocket.on('chat_updated', (data) => {
      resolve(data);
    });
  });

  const mockMessage = { id: 999, text: 'Hola vía socket', direction: 'inbound' };
  const mockConversation = { id: 42, channel_id: 1, contact_name: 'Ana Gomez' };

  socketManager.emitNewMessage(1, mockMessage, mockConversation);

  const receivedMessage = await messagePromise;
  const receivedChatUpdate = await chatUpdatedPromise;

  assert.equal(receivedMessage.channelId, 1);
  assert.equal(receivedMessage.message.text, 'Hola vía socket');
  assert.equal(receivedChatUpdate.conversation.contact_name, 'Ana Gomez');

  // 2. Probar recepción de bot_status_changed
  const botStatusPromise = new Promise((resolve) => {
    clientSocket.on('bot_status_changed', (data) => {
      resolve(data);
    });
  });

  socketManager.emitBotStatus(1, 42, 'handed_over');

  const receivedBotStatus = await botStatusPromise;
  assert.equal(receivedBotStatus.conversationId, 42);
  assert.equal(receivedBotStatus.botStatus, 'handed_over');

  // Limpieza
  clientSocket.disconnect();
  server.close();
});
