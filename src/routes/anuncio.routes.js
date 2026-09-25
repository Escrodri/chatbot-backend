import { Router } from 'express';
import { anuncioController } from '../controllers/anuncio.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const anuncioRouter = Router();

// Ver el informe: todo el equipo. Nombrar: lo controla el controlador
// (solo administradores).
anuncioRouter.get('/', requireAuth, anuncioController.rendimiento);
anuncioRouter.get('/meta', requireAuth, anuncioController.estadoMeta);
anuncioRouter.post('/sincronizar', requireAuth, anuncioController.sincronizar);
anuncioRouter.post('/importar', requireAuth, anuncioController.importar);
anuncioRouter.patch('/:adId', requireAuth, anuncioController.nombrar);

export default anuncioRouter;
