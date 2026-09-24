import { Router } from 'express';
import { campanaController } from '../controllers/campana.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const campanaRouter = Router();

// Cualquiera del equipo las puede ver: el asesor tiene que saber qué precio
// está corriendo para contestar bien. Crear y cambiar lo controla el
// controlador, que exige administrador.
campanaRouter.get('/', requireAuth, campanaController.listar);
campanaRouter.post('/', requireAuth, campanaController.crear);
campanaRouter.patch('/:id', requireAuth, campanaController.actualizar);

export default campanaRouter;
