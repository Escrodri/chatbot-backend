import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { loginRateLimitPorIp, loginRateLimitPorCuenta } from '../middlewares/rate-limit.middleware.js';

export const authRouter = Router();

// Rutas públicas de autenticación.
// El login está limitado por IP y por cuenta para frenar la fuerza bruta (A-05).
authRouter.post('/login', loginRateLimitPorIp, loginRateLimitPorCuenta, authController.login);
authRouter.post('/logout', authController.logout);

// Rutas protegidas por sesión
authRouter.get('/me', requireAuth, authController.me);

export default authRouter;
