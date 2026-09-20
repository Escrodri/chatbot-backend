import { Router } from 'express';
import { teamsController } from '../controllers/teams.controller.js';
import { requireAuth, requireSuperAdmin } from '../middlewares/auth.middleware.js';

export const teamsRouter = Router();

// Todas las rutas de gestión de equipos exigen ser Superadministrador
teamsRouter.use(requireAuth);
teamsRouter.use(requireSuperAdmin);

teamsRouter.get('/', teamsController.getTeams);
teamsRouter.post('/', teamsController.createTeam);

export default teamsRouter;
