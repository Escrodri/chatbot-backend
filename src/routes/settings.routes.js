import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller.js';
import { requireAuth, requireAdmin } from '../middlewares/auth.middleware.js';

export const settingsRouter = Router();

// Todas las rutas de administración exigen autenticación y rol 'admin'
settingsRouter.use(requireAuth);
settingsRouter.use(requireAdmin);

// Canales
settingsRouter.get('/channels', settingsController.getChannels);
settingsRouter.post('/channels', settingsController.createChannel);
settingsRouter.put('/channels/:id', settingsController.updateChannel);
settingsRouter.post('/channels/:id/test', settingsController.testChannel);
settingsRouter.delete('/channels/:id', settingsController.deleteChannel);
settingsRouter.post('/channels/scan-facebook-pages', settingsController.scanFacebookPages);
settingsRouter.post('/channels/connect-facebook-pages', settingsController.connectFacebookPages);
settingsRouter.get('/channels/meta-app-info', settingsController.getMetaAppInfo);
settingsRouter.get('/meta-app-info', settingsController.getMetaAppInfo);
settingsRouter.post('/channels/meta-config', settingsController.saveTeamMetaConfig);
settingsRouter.delete('/channels/meta-config', settingsController.clearTeamMetaConfig);
settingsRouter.post('/channels/facebook-exchange-code', settingsController.exchangeFacebookCode);
settingsRouter.post('/channels/instagram-lookup', settingsController.instagramLookup);

// Chatbot
settingsRouter.get('/bot', settingsController.getBotSettings);
settingsRouter.post('/bot', settingsController.saveBotSettings);

// Usuarios / Operadores
settingsRouter.get('/users', settingsController.getUsers);
settingsRouter.post('/users', settingsController.createUser);

// Canales que puede ver cada operador (A-03)
settingsRouter.get('/users/:id/channels', settingsController.getUserChannels);
settingsRouter.put('/users/:id/channels', settingsController.setUserChannels);

// Auditoría de Webhooks
settingsRouter.get('/logs', settingsController.getLogs);

export default settingsRouter;
