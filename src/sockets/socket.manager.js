import { Server as SocketIOServer } from 'socket.io';
import { verifyToken } from '../utils/jwt.util.js';
import { userRepository } from '../repositories/user.repository.js';
import { config } from '../config/index.js';
import { pool } from '../database/pool.js';

/**
 * Gestor de WebSockets en Tiempo Real (Socket.io)
 *
 * SEGURIDAD & MULTI-TENANCY (C-01):
 * 1. Ninguna conexión se acepta sin un JWT válido, el mismo que usa la API HTTP.
 * 2. Aislamiento estricto de salas:
 *    - Los administradores de una empresa entran a su sala de equipo `team_${teamId}_admins`.
 *    - Los operadores entran a las salas de los canales que tienen asignados `channel_${channelId}`.
 *    - NUNCA se transmiten mensajes de una empresa a los administradores de otra empresa.
 */

const roomForTeamAdmins = (teamId) => teamId ? `team_${teamId}_admins` : 'team_global_admins';
const roomForChannel = (channelId) => `channel_${channelId}`;

const channelTeamCache = new Map();

async function resolveTeamIdForChannel(channelId) {
  if (!channelId) return null;
  const cId = Number(channelId);
  if (channelTeamCache.has(cId)) return channelTeamCache.get(cId);
  try {
    const { rows } = await pool.query('SELECT team_id FROM channels WHERE id = $1', [cId]);
    if (rows.length > 0 && rows[0].team_id) {
      channelTeamCache.set(cId, rows[0].team_id);
      return rows[0].team_id;
    }
  } catch {}
  return null;
}

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
        team_id: payload.team_id || null,
        email: payload.email,
        name: payload.name,
        role: payload.role
      };

      // Los canales visibles se resuelven en el servidor, no los pide el cliente.
      try {
        socket.data.channelIds = payload.role === 'admin'
          ? null // null = todos los canales de su equipo
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
        if (user.team_id) {
          socket.join(roomForTeamAdmins(user.team_id));
        }
      } else {
        for (const channelId of channelIds || []) {
          socket.join(roomForChannel(channelId));
        }
      }

      console.log(
        `⚡ [SOCKET] ${user.email} (${user.role}) conectado. ` +
        `Equipo: #${user.team_id || 'global'} | Canales: ${user.role === 'admin' ? 'todos del equipo' : (channelIds || []).join(', ') || 'ninguno'}`
      );

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

    console.log('⚡ [SOCKET.IO] Servidor de WebSockets inicializado con autenticación JWT y aislamiento multi-tenant.');
    return this.io;
  }

  /**
   * Destinatarios de un evento: los operadores del canal, más los administradores de su equipo.
   * @private
   */
  _audience(channelId, teamId = null) {
    if (!this.io) return null;
    let target = this.io;
    if (channelId) {
      target = target.to(roomForChannel(channelId));
    }
    const effectiveTeamId = teamId || (channelId ? channelTeamCache.get(Number(channelId)) : null);
    if (effectiveTeamId) {
      target = target.to(roomForTeamAdmins(effectiveTeamId));
    }
    return target;
  }

  /**
   * Emite un mensaje entrante o saliente a los operadores del canal y admins del equipo.
   */
  async emitNewMessage(channelId, messageData, conversationData = null) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
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
   */
  async emitMessageStatus(channelId, metaMessageId, status) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('message_status_updated', { channelId, metaMessageId, status });
  }

  /**
   * Emite el cambio de estado del bot (Handover).
   */
  async emitBotStatus(channelId, conversationId, botStatus) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('bot_status_changed', { channelId, conversationId, botStatus });
  }

  /**
   * Emite un mensaje recién enviado por un operador.
   */
  async emitMessageSent(channelId, messageData) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('message:sent', messageData);
  }

  /**
   * Emite que una imagen de una sola vista fue abierta/visualizada.
   */
  async emitMessageViewed(channelId, data) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('message_viewed', data);
  }

  /**
   * Emite la actualización de la cabecera de una conversación.
   */
  async emitConversationUpdated(channelId, conversationData) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('conversation:updated', conversationData);
  }

  /**
   * Emite que los mensajes de una conversación fueron leídos por un operador.
   */
  async emitMessageStatusUpdated(channelId, data) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('message:status_updated', data);
  }

  /**
   * Avisa de un cambio de estado de un canal.
   */
  async emitChannelStatus(channelId, status, errorMessage = null) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('channel_status_changed', { channelId, status, errorMessage });
  }

  /**
   * Avisa a la bandeja que un mensaje entrante no pudo llegar a n8n.
   *
   * Es un aviso para el equipo, no para el cliente: el mensaje ya está guardado
   * y a la vista, lo que falta es que alguien lo conteste a mano mientras la
   * automatización esté caída.
   *
   * @param {number} channelId
   * @param {{conversationId: number, motivo: string, mensaje: string|null, detalle: string|null, en: string}} data
   */
  async emitAutomationAlert(channelId, data) {
    const effectiveTeamId = await resolveTeamIdForChannel(channelId);
    const audience = this._audience(channelId, effectiveTeamId);
    if (!audience) return;
    audience.emit('automation:alert', { channelId, ...data });
  }
}

export const socketManager = new SocketManager();
export default socketManager;
