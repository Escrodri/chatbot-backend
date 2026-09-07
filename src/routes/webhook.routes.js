import { Router } from 'express';
import { webhookController } from '../controllers/index.js';
import { verifyMetaSignature } from '../middlewares/index.js';

export const webhookRouter = Router();

// 1. Verificación inicial de Meta Developers (Handshake hub.challenge)
webhookRouter.get('/', webhookController.handleVerification);

// 2. Ingesta multi-canal con validación obligatoria HMAC-SHA256
webhookRouter.post('/', verifyMetaSignature, webhookController.handleInbound);

export default webhookRouter;
