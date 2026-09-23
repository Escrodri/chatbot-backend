import { Router } from 'express';
import { orderController } from '../controllers/order.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { requireAuthOrService } from '../middlewares/service-auth.middleware.js';

export const orderRouter = Router();

// Tablero: quién pagó y quién no. Solo personas.
orderRouter.get('/', requireAuth, orderController.list);
orderRouter.get('/summary', requireAuth, orderController.summary);

// El embudo: cuánta gente llegó a cada paso, en total y abierto por anuncio.
// Es lo que contesta cuál anuncio trae gente que compra y no solo gente que
// escribe. Va antes de /:id para que "embudo" no se lea como un id.
orderRouter.get('/embudo', requireAuth, orderController.embudo);

// El interruptor de "salgo un rato, que apruebe solo": modo noche, siempre o
// apagado, con vencimiento opcional. Va antes de /:id por la misma razón que
// el embudo: si no, "revision-config" se leería como un id de pedido.
orderRouter.get('/revision-config', requireAuth, orderController.configRevision);
orderRouter.patch('/revision-config', requireAuth, orderController.cambiarConfigRevision);

// Abrir/recuperar pedido. Lo llama n8n: la respuesta trae `duplicado` y
// `ya_pago`, que es el "buscar duplicado" del flujo viejo resuelto de una.
orderRouter.post('/', requireAuthOrService, orderController.createOrGet);
orderRouter.get('/conversation/:conversationId', requireAuthOrService, orderController.byConversation);

// Cambio de estado. El controlador rechaza que un servicio marque 'pagado':
// esa transición la hace una persona mirando el banco.
orderRouter.patch('/:id/status', requireAuthOrService, orderController.updateStatus);

// Comprobante llegado de madrugada: el backend decide si lo puede aprobar y
// entregar solo. Es la única puerta por la que un pago se confirma sin una
// persona, y está cerrada salvo que se cumpla todo: horario nocturno, monto
// que llega al precio, cuenta propia y número de operación que no se usó antes.
orderRouter.post('/:id/revision-automatica', requireAuthOrService, orderController.revisionAutomatica);

// Hasta dónde llegó la persona. Lo marca el guion paso a paso y solo avanza.
orderRouter.post('/:id/etapa', requireAuthOrService, orderController.marcarEtapa);

export default orderRouter;
