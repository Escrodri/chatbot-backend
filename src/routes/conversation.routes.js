import { Router } from 'express';
import { conversationController } from '../controllers/conversation.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const conversationRouter = Router();

// Todas las rutas de mensajería requieren autenticación (operadores y administradores)
conversationRouter.use(requireAuth);

// Listado de chats con filtros por plataforma, canal y búsqueda
conversationRouter.get('/', conversationController.list);

// Detalle de una conversación
conversationRouter.get('/:id', conversationController.getById);

// Historial de mensajes paginado por cursor (Keyset)
conversationRouter.get('/:id/messages', conversationController.getMessages);

// Envío de respuesta humana (Handover)
conversationRouter.post('/:id/messages', conversationController.sendMessage);

// Reintentar el envío de un mensaje que Meta rechazó (conserva el adjunto)
conversationRouter.post('/:id/messages/:messageId/retry', conversationController.retryMessage);

// Alternar estado del bot (active, handed_over, disabled)
conversationRouter.post('/:id/bot-toggle', conversationController.toggleBot);

export default conversationRouter;
