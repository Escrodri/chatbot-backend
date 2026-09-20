import { Router } from 'express';
import { teamsController } from '../controllers/teams.controller.js';
import { requireAuth, requireSuperAdmin } from '../middlewares/auth.middleware.js';

export const teamsRouter = Router();

// Todas las rutas de gestión de equipos exigen ser Superadministrador
teamsRouter.use(requireAuth);
teamsRouter.use(requireSuperAdmin);

teamsRouter.get('/', teamsController.getTeams);
teamsRouter.post('/', teamsController.createTeam);
teamsRouter.get('/:id', teamsController.getTeamDetails);
teamsRouter.put('/:id', teamsController.updateTeam);
teamsRouter.patch('/:id/status', teamsController.toggleTeamStatus);

// Gestión de Operadores y Canales del Equipo por el Superadmin
teamsRouter.get('/:id/users', teamsController.getTeamUsers);
teamsRouter.post('/:id/users', teamsController.createTeamUser);
teamsRouter.put('/:id/users/:userId', teamsController.updateTeamUser);
teamsRouter.patch('/:id/users/:userId/status', teamsController.toggleTeamUserStatus);
teamsRouter.get('/:id/channels', teamsController.getTeamChannels);

export default teamsRouter;
