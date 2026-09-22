import { Router } from 'express';
import { analyticsController } from '../controllers/analytics.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const analyticsRouter = Router();

// Dashboard analítico: ventas del día, productos más/menos vendidos, leads y asesores
analyticsRouter.get('/dashboard', requireAuth, analyticsController.getDashboard);

export default analyticsRouter;
