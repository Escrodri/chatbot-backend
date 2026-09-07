import { Router } from 'express';
import { webhookRouter } from './webhook.routes.js';
import { testRouter } from './test.routes.js';
import { config } from '../config/index.js';

export const apiRouter = Router();

// Montar router de webhooks de Meta en /api/webhook
apiRouter.use('/webhook', webhookRouter);

// Montar simulador de eventos locales en desarrollo/testing
if (!config.isProd) {
  apiRouter.use('/test', testRouter);
}

export default apiRouter;
