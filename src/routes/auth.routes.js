import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const authRouter = Router();

// Rutas públicas de autenticación
authRouter.post('/login', authController.login);
authRouter.post('/logout', authController.logout);

// Rutas protegidas por sesión
authRouter.get('/me', requireAuth, authController.me);

export default authRouter;
