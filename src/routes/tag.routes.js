import { Router } from 'express';
import { tagController } from '../controllers/tag.controller.js';
import { requireAuth, requireAdmin } from '../middlewares/auth.middleware.js';

export const tagRouter = Router();

// Catálogo de etiquetas del equipo
tagRouter.get('/', requireAuth, tagController.list);

// Cualquier asesor puede crear: la necesidad aparece en medio de un chat.
tagRouter.post('/', requireAuth, tagController.create);

// Borrar afecta a todo el equipo, así que queda para administradores.
tagRouter.delete('/:id', requireAuth, requireAdmin, tagController.remove);

export default tagRouter;
