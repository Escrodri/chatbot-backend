import { Router } from 'express';
import { webhookRouter } from './webhook.routes.js';
import { testRouter } from './test.routes.js';
import { dataDeletionRouter } from './data-deletion.routes.js';
import { authRouter } from './auth.routes.js';
import { settingsRouter } from './settings.routes.js';
import { conversationRouter } from './conversation.routes.js';
import { mediaRouter } from './media.routes.js';
import { config } from '../config/index.js';

export const apiRouter = Router();

// Montar endpoints de autenticación y sesiones
apiRouter.use('/auth', authRouter);

// Montar endpoints de administración y configuración
apiRouter.use('/settings', settingsRouter);

// Montar endpoints de mensajería omnicanal
apiRouter.use('/conversations', conversationRouter);

// Entrega de archivos multimedia (con sesión y control por canal)
apiRouter.use('/media', mediaRouter);

// Montar router de webhooks de Meta en /api/webhook
apiRouter.use('/webhook', webhookRouter);

// Montar endpoints de compliance de Meta (Data Deletion)
apiRouter.use('/', dataDeletionRouter);

// Montar simulador de eventos locales en desarrollo/testing
if (!config.isProd) {
  apiRouter.use('/test', testRouter);
}

export default apiRouter;
