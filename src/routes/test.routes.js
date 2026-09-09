import { Router } from 'express';
import { testController } from '../controllers/test.controller.js';
import { requireAuth, requireAdmin } from '../middlewares/auth.middleware.js';

export const testRouter = Router();

// El simulador inyecta mensajes directamente en la bandeja: exige sesión de
// administrador además de no estar en producción (defensa en profundidad, A-01).
testRouter.use(requireAuth);
testRouter.use(requireAdmin);

// Endpoint de simulación local
testRouter.post('/simulate-inbound', testController.simulateInbound);

export default testRouter;
