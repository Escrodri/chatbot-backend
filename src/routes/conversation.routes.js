import { Router } from 'express';
import { conversationController } from '../controllers/conversation.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireAuthOrService } from '../middlewares/service-auth.middleware.js';
import { tagController } from '../controllers/tag.controller.js';

export const conversationRouter = Router();

// Antes había un `conversationRouter.use(requireAuth)` que cubría todo. Se quitó
// porque dos rutas las consume también el bot de n8n, que no tiene sesión sino
// token de servicio. El resto sigue exigiendo sesión humana, declarada ruta por
// ruta: es más verboso, pero deja a la vista quién entra a cada cosa.

// Listado de chats con filtros por plataforma, canal y búsqueda
conversationRouter.get('/', requireAuth, conversationController.list);

// Detalle de una conversación
conversationRouter.get('/:id', requireAuth, conversationController.getById);

// Historial de mensajes paginado por cursor (Keyset)
conversationRouter.get('/:id/messages', requireAuth, conversationController.getMessages);

// Envío de mensaje. Lo usan el asesor (sesión) y el bot de n8n (token de
// servicio). El controlador los distingue: el del bot se guarda con
// sender_type 'bot' y NO dispara el handover.
conversationRouter.post('/:id/messages', requireAuthOrService, conversationController.sendMessage);

// El bot levanta la mano y le pasa el chat a una persona
conversationRouter.post('/:id/handover', requireAuthOrService, conversationController.handover);

// Reintentar el envío de un mensaje que Meta rechazó (conserva el adjunto)
conversationRouter.post('/:id/messages/:messageId/retry', requireAuth, conversationController.retryMessage);

// Marcar que la conversación terminó en venta e informárselo a Meta
conversationRouter.post('/:id/sale', requireAuthOrService, conversationController.registerSale);

// Ventas ya registradas en la conversación
conversationRouter.get('/:id/sales', requireAuth, conversationController.listSales);

// Etiquetas puestas a mano por el equipo (distintas del estado de venta)
conversationRouter.get('/:id/tags', requireAuth, tagController.listForConversation);
conversationRouter.post('/:id/tags', requireAuth, tagController.assign);
conversationRouter.delete('/:id/tags/:tagId', requireAuth, tagController.unassign);

// Alternar estado del bot (active, handed_over, disabled)
conversationRouter.post('/:id/bot-toggle', requireAuth, conversationController.toggleBot);

// Dejar una conversación de prueba en cero para volver a correr el flujo desde
// el saludo. Borra mensajes y pedido, así que el controlador rechaza cualquier
// conversación cuyo número no esté declarado en TEST_PHONES.
conversationRouter.post('/:id/reset', requireAuth, conversationController.reiniciarPrueba);

export default conversationRouter;
