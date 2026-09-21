import { Router } from 'express';
import { automationController } from '../controllers/automation.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const automationRouter = Router();

// Estado de la automatización. Lo consulta la bandeja para decidir si muestra
// el aviso de que n8n no está contestando.
automationRouter.get('/health', requireAuth, automationController.health);

// Apagar el aviso después de leerlo.
automationRouter.post('/ack', requireAuth, automationController.ack);

export default automationRouter;
