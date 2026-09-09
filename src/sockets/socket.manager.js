import { Server as SocketIOServer } from 'socket.io';
import { verifyToken } from '../utils/jwt.util.js';
import { userRepository } from '../repositories/user.repository.js';
import { config } from '../config/index.js';

/**
 * Gestor de WebSockets en Tiempo Real (Socket.io)
 *
 * SEGURIDAD (C-01):
 * 1. Ninguna conexión se acepta sin un JWT válido, el mismo que usa la API HTTP.
 *    El token puede llegar por la cookie `session_token` o por `auth.token` en el handshake.
 * 2. Las salas no las elige el cliente. Al conectarse, el servidor decide a qué salas
 *    entra según el rol y los canales asignados al usuario. Un operador nunca recibe
 *    eventos de un canal que no le corresponde.
 */

const ROOM_ADMINS = 'admins';
const roomForChannel = (channelId) => `channel_${channelId}`;

/** Extrae el valor de una cookie concreta de la cabecera Cookie. */
function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

/** Busca el token de sesión en el handshake: cookie, auth o cabecera Authorization. */
function extractToken(handshake) {
  const fromCookie = readCookie(handshake.headers?.cookie, 'session_token');
  if (fromCookie) return fromCookie;

  const fromAuth = handshake.auth?.token;
  if (fromAuth && typeof fromAuth === 'string') return fromAuth.replace(/^Bearer\s+/i, '').trim();

  const header = handshake.headers?.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

class SocketManager {
  constructor() {
    this.io = null;
  }

  /**
   * Inicializa Socket.io sobre el servidor HTTP existente.
   * @param {import('http').Server} httpServer
   */
  init(httpServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: config.security.allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // ---------- 1. Autenticación obligatoria antes de aceptar la conexión ----------
    this.io.use(async (socket, next) => {
      const token = extractToken(socket.handshake);

      if (!token) {
        console.warn('🚫 [SOCKET REJECTED] Conexión sin token de sesión.');
        return next(new Error('No autorizado: sesión requerida'));
      }

      const payload = verifyToken(token, config.security.sessionSecret);
      if (!payload) {
        console.warn('🚫 [SOCKET REJECTED] Conexión con token inválido o expirado.');
        return next(new Error('Sesión inválida o expirada'));
      }

      socket.data.user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        role: payload.role
      };

      // Los canales visibles se resuelven en el servidor, no los pide el cliente.
      try {
        socket.data.channelIds = payload.role === 'admin'
          ? null // null = todos los canales
          : await userRepository.getAssignedChannelIds(payload.id);
      } catch (err) {
        console.error('❌ [SOCKET] No se pudieron resolver los canales asignados:', err.message);
        return next(new Error('No se pudo verificar el acceso a los canales'));
      }

      return next();
    });

    // ---------- 2. Alta de salas decidida por el servidor ----------
    this.io.on('connection', (socket) => {
      const { user, channelIds } = socket.data;

      if (user.role === 'admin') {
        socket.join(ROOM_ADMINS);
      } else {
        for (const channelId of channelIds || []) {
          socket.join(roomForChannel(channelId));
        }
      }

      console.log(
        `⚡ [SOCKET] ${user.email} (${user.role}) conectado. ` +
        `Canales: ${user.role === 'admin' ? 'todos' : (channelIds || []).join(', ') || 'ninguno'}`
      );

      // Compatibilidad: el cliente puede seguir emitiendo estos eventos, pero ya no
      // otorgan acceso a nada. Las salas se asignaron arriba.
      socket.on('join_inbox', () => {});
      socket.on('join_channel', (channelId) => {
        const permitido = user.role === 'admin' || (channelIds || []).includes(Number(channelId));
        if (!permitido) {
          console.warn(`🚫 [SOCKET] ${user.email} intentó unirse al canal ${channelId} sin permiso.`);
        }
      });
      socket.on('leave_channel', (channelId) => {
        if (channelId) socket.leave(roomForChannel(channelId));
      });

      socket.on('disconnect', (motivo) => {
        console.log(`👋 [SOCKET] ${user.email} desconectado (${motivo}).`);
      });
    });

    console.log('⚡ [SOCKET.IO] Servidor de WebSockets inicializado con autenticación JWT.');
    return this.io;
  }

  /**
   * Destinatarios de un evento: los operadores del canal, más los administradores.
   * @private
   */
  _audience(channelId) {
    if (!this.io) return null;
    const target = this.io.to(ROOM_ADMINS);
    return channelId ? target.to(roomForChannel(channelId)) : target;
  }

  /**
   * Emite un mensaje entrante o saliente a los operadores del canal.
   *
   * @param {number} channelId
   * @param {object} messageData
   * @param {object} conversationData Cabecera actualizada para subir el chat al tope
   */
  emitNewMessage(channelId, messageData, conversationData = null) {
    const audience = this._audience(channelId);
    if (!audience) return;

    audience.emit('new_message', {
      channelId,
      message: messageData,
      conversation: conversationData
    });

    audience.emit('chat_updated', {
      channelId,
      conversation: conversationData,
      lastMessage: messageData
    });
  }

  /**
   * Emite el cambio de estado de entrega de un mensaje.
   *
   * @param {number} channelId
   * @param {string} metaMessageId
   * @param {'delivered'|'read'|'failed'} status
   */
  emitMessageStatus(channelId, metaMessageId, status) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('message_status_updated', { channelId, metaMessageId, status });
  }

  /**
   * Emite el cambio de estado del bot (Handover).
   *
   * @param {number} channelId
   * @param {number} conversationId
   * @param {'active'|'handed_over'|'disabled'} botStatus
   */
  emitBotStatus(channelId, conversationId, botStatus) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('bot_status_changed', { channelId, conversationId, botStatus });
  }

  /**
   * Emite un mensaje recién enviado por un operador.
   * @param {number} channelId
   * @param {object} messageData
   */
  emitMessageSent(channelId, messageData) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('message:sent', messageData);
  }

  /**
   * Emite la actualización de la cabecera de una conversación.
   * @param {number} channelId
   * @param {object} conversationData
   */
  emitConversationUpdated(channelId, conversationData) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('conversation:updated', conversationData);
  }

  /**
   * Emite que los mensajes de una conversación fueron leídos por un operador.
   * @param {number} channelId
   * @param {object} data
   */
  emitMessageStatusUpdated(channelId, data) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('message:status_updated', data);
  }

  /**
   * Avisa de un cambio de estado de un canal (por ejemplo, token revocado por Meta).
   * Solo lo reciben los administradores y los operadores de ese canal.
   *
   * @param {number} channelId
   * @param {'active'|'error'|'paused'} status
   * @param {string|null} errorMessage
   */
  emitChannelStatus(channelId, status, errorMessage = null) {
    const audience = this._audience(channelId);
    if (!audience) return;
    audience.emit('channel_status_changed', { channelId, status, errorMessage });
  }
}

export const socketManager = new SocketManager();
export default socketManager;
