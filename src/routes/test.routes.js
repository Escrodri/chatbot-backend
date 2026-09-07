import { Router } from 'express';
import { testController } from '../controllers/test.controller.js';

export const testRouter = Router();

// Endpoint de simulación local
testRouter.post('/simulate-inbound', testController.simulateInbound);

export default testRouter;
