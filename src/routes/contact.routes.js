import { Router } from 'express';
import { contactController } from '../controllers/contact.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

export const contactRouter = Router();

// Solo lectura: los contactos los crea la gente al escribirte, no se dan de alta a mano.
contactRouter.get('/', requireAuth, contactController.list);
contactRouter.get('/stats', requireAuth, contactController.stats);

export default contactRouter;
