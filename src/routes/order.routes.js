import { Router } from 'express';
import { orderController } from '../controllers/order.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireAuthOrService } from '../middlewares/service-auth.middleware.js';

export const orderRouter = Router();

// Tablero: quién pagó y quién no. Solo personas.
orderRouter.get('/', requireAuth, orderController.list);
orderRouter.get('/summary', requireAuth, orderController.summary);

// Abrir/recuperar pedido. Lo llama n8n: la respuesta trae `duplicado` y
// `ya_pago`, que es el "buscar duplicado" del flujo viejo resuelto de una.
orderRouter.post('/', requireAuthOrService, orderController.createOrGet);
orderRouter.get('/conversation/:conversationId', requireAuthOrService, orderController.byConversation);

// Cambio de estado. El controlador rechaza que un servicio marque 'pagado':
// esa transición la hace una persona mirando el banco.
orderRouter.patch('/:id/status', requireAuthOrService, orderController.updateStatus);

export default orderRouter;
