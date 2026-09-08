import { Server as SocketIOServer } from 'socket.io';

/**
 * Gestor de WebSockets en Tiempo Real (Socket.io)
 * Mantiene la sincronización bidireccional instantánea con la bandeja estilo WhatsApp Web.
 */
class SocketManager {
  constructor() {
    this.io = null;
  }

  /**
   * Inicializa la instancia de Socket.io sobre el servidor HTTP existente.
   * @param {import('http').Server} httpServer
   */
  init(httpServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: '*', // Configurable según entorno
        methods: ['GET', 'POST'],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.io.on('connection', (socket) => {
      // Manejo de unirse a canales específicos (para operadores con permisos IDOR)
      socket.on('join_channel', (channelId) => {
        if (channelId) {
          socket.join(`channel_${channelId}`);
        }
      });

      socket.on('leave_channel', (channelId) => {
        if (channelId) {
          socket.leave(`channel_${channelId}`);
        }
      });

      // Sala global de operadores autenticados
      socket.on('join_inbox', () => {
        socket.join('inbox_global');
      });
    });

    console.log('⚡ [SOCKET.IO] Servidor de WebSockets en tiempo real inicializado.');
    return this.io;
  }

  /**
   * Emite un nuevo mensaje entrante o saliente a los operadores conectados.
   * 
   * @param {number} channelId ID del canal receptivo
   * @param {object} messageData Mensaje normalizado
   * @param {object} conversationData Cabecera de conversación actualizada (para subir al tope de la lista)
   */
  emitNewMessage(channelId, messageData, conversationData = null) {
    if (!this.io) return;

    // 1. Emitir a la sala del canal puntual
    this.io.to(`channel_${channelId}`).emit('new_message', {
      channelId,
      message: messageData,
      conversation: conversationData
    });

    // 2. Emitir a la sala global del inbox para actualizar la lista de chats y badges
    this.io.to('inbox_global').emit('chat_updated', {
      channelId,
      conversation: conversationData,
      lastMessage: messageData
    });
  }

  /**
   * Emite la actualización de estado de entrega de un mensaje (sent, delivered, read, failed).
   * 
   * @param {number} channelId
   * @param {string} metaMessageId
   * @param {'delivered'|'read'|'failed'} status
   */
  emitMessageStatus(channelId, metaMessageId, status) {
    if (!this.io) return;
    this.io.to(`channel_${channelId}`).emit('message_status_updated', {
      channelId,
      metaMessageId,
      status
    });
  }

  /**
   * Emite el cambio de estado del bot (Protocolo Handover: active <-> handed_over).
   * 
   * @param {number} channelId
   * @param {number} conversationId
   * @param {'active'|'handed_over'|'disabled'} botStatus
   */
  emitBotStatus(channelId, conversationId, botStatus) {
    if (!this.io) return;
    this.io.to(`channel_${channelId}`).emit('bot_status_changed', {
      channelId,
      conversationId,
      botStatus
    });
    this.io.to('inbox_global').emit('bot_status_changed', {
      channelId,
      conversationId,
      botStatus
    });
  }

  emitMessageSent(messageData) {
    if (!this.io) return;
    this.io.to('inbox_global').emit('message:sent', messageData);
  }

  emitConversationUpdated(conversationData) {
    if (!this.io) return;
    this.io.to('inbox_global').emit('conversation:updated', conversationData);
  }

  emitMessageStatusUpdated(data) {
    if (!this.io) return;
    this.io.to('inbox_global').emit('message:status_updated', data);
  }
}

export const socketManager = new SocketManager();
export default socketManager;
