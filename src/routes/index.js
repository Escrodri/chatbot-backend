import { Router } from 'express';
import { webhookRouter } from './webhook.routes.js';

export const apiRouter = Router();

// Montar router de webhooks de Meta en /api/webhook
apiRouter.use('/webhook', webhookRouter);

export default apiRouter;
