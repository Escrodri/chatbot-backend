import { Router } from 'express';
import { mediaController } from '../controllers/media.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const mediaRouter = Router();

// Los archivos de los clientes son tan privados como sus mensajes: exigen sesión.
mediaRouter.use(requireAuth);

mediaRouter.get('/:messageId', mediaController.serve);

export default mediaRouter;
