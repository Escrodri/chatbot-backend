import { Router } from 'express';
import { webhookRouter } from './webhook.routes.js';
import { testRouter } from './test.routes.js';
import { dataDeletionRouter } from './data-deletion.routes.js';
import { authRouter } from './auth.routes.js';
import { settingsRouter } from './settings.routes.js';
import { teamsRouter } from './teams.routes.js';
import { conversationRouter } from './conversation.routes.js';
import { productRouter } from './product.routes.js';
import { orderRouter } from './order.routes.js';
import { analyticsRouter } from './analytics.routes.js';
import { contactRouter } from './contact.routes.js';
import { tagRouter } from './tag.routes.js';
import { mediaRouter } from './media.routes.js';
import { automationRouter } from './automation.routes.js';
import { campanaRouter } from './campana.routes.js';
import { config } from '../config/index.js';

export const apiRouter = Router();

// Montar endpoints de autenticación y sesiones
apiRouter.use('/auth', authRouter);

// Montar endpoints de administración y configuración
apiRouter.use('/settings', settingsRouter);

// Montar endpoints de gestión global de equipos (Superadmin)
apiRouter.use('/teams', teamsRouter);

// Montar endpoints de mensajería omnicanal
apiRouter.use('/conversations', conversationRouter);

// Catálogo de productos digitales (panel, web y bot de n8n)
apiRouter.use('/products', productRouter);

// Pedidos: estado de cada venta (interesado, comprobante, pagado, entregado)
apiRouter.use('/orders', orderRouter);

// Campañas de precio: remarketing y promos con fecha
apiRouter.use('/campanas', campanaRouter);

// Métricas de ventas, leads y rendimiento de productos y asesores
apiRouter.use('/analytics', analyticsRouter);

// Directorio de contactos (solo lectura sobre la tabla real)
apiRouter.use('/contacts', contactRouter);

// Etiquetas de conversación, compartidas por equipo
apiRouter.use('/tags', tagRouter);

// Entrega de archivos multimedia (con sesión y control por canal)
apiRouter.use('/media', mediaRouter);

// Estado de la automatización con n8n: lo consulta la bandeja para avisar
// cuando un mensaje entrante no llegó al flujo
apiRouter.use('/automation', automationRouter);

// Montar router de webhooks de Meta en /api/webhook
apiRouter.use('/webhook', webhookRouter);

// Montar endpoints de compliance de Meta (Data Deletion)
apiRouter.use('/', dataDeletionRouter);

// Montar simulador de eventos locales en desarrollo/testing
if (!config.isProd) {
  apiRouter.use('/test', testRouter);
}

export default apiRouter;
