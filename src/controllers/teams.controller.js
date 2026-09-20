import bcrypt from 'bcryptjs';
import { teamRepository } from '../repositories/team.repository.js';
import { userRepository } from '../repositories/user.repository.js';

export const teamsController = {
  /**
   * Lista todos los equipos y empresas con sus métricas.
   * GET /api/teams
   */
  async getTeams(req, res) {
    try {
      const teams = await teamRepository.listAllWithMetrics();
      return res.json(teams);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar equipos: ' + error.message });
    }
  },

  /**
   * Crea un nuevo equipo / empresa y opcionalmente su Administrador principal.
   * POST /api/teams
   */
  async createTeam(req, res) {
    try {
      const { name, metaAppId, metaAppSecret, adminEmail, adminPassword, adminName } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'El nombre del equipo o empresa es obligatorio.' });
      }

      // 1. Crear registro de equipo
      const team = await teamRepository.createTeam({
        name: String(name).trim(),
        metaAppId,
        metaAppSecret
      });

      let adminUser = null;

      // 2. Si se ingresaron credenciales para un Administrador inicial de este equipo
      if (adminEmail && adminPassword) {
        if (!adminEmail.includes('@')) {
          return res.status(400).json({ error: 'Email del administrador inválido.' });
        }
        if (adminPassword.length < 12) {
          return res.status(400).json({ error: 'La contraseña del administrador debe tener al menos 12 caracteres.' });
        }

        const existingUser = await userRepository.findByEmail(adminEmail);
        if (existingUser) {
          return res.status(400).json({ error: 'Ya existe un usuario registrado con ese correo electrónico.' });
        }

        const passwordHash = await bcrypt.hash(adminPassword, 12);
        adminUser = await userRepository.create({
          teamId: team.id,
          email: adminEmail.toLowerCase().trim(),
          passwordHash,
          name: adminName ? String(adminName).trim() : `Admin ${team.name}`,
          role: 'admin',
          isActive: true
        });
      }

      return res.status(201).json({
        success: true,
        message: `Equipo "${team.name}" creado exitosamente.`,
        team,
        adminUser: adminUser ? { id: adminUser.id, email: adminUser.email, name: adminUser.name } : null
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al crear el equipo: ' + error.message });
    }
  },

  /**
   * Actualiza el nombre y/o credenciales de Meta de un equipo.
   * PUT /api/teams/:id
   */
  async updateTeam(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      const { name, metaAppId, metaAppSecret } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'El nombre del equipo es obligatorio.' });
      }

      const updated = await teamRepository.updateTeam(teamId, {
        name: String(name).trim(),
        metaAppId,
        metaAppSecret
      });

      return res.json({
        success: true,
        message: 'Equipo actualizado correctamente.',
        team: updated
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al actualizar el equipo: ' + error.message });
    }
  },

  /**
   * Desactiva o reactiva un equipo (soft toggle, nunca borra filas).
   * PATCH /api/teams/:id/status
   */
  async toggleTeamStatus(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      if (teamId === 1) {
        return res.status(400).json({ error: 'El Equipo Principal no puede ser desactivado.' });
      }

      const updated = await teamRepository.toggleStatus(teamId);
      if (!updated) return res.status(404).json({ error: 'Equipo no encontrado.' });

      const accion = updated.status === 'active' ? 'reactivado' : 'desactivado';
      return res.json({
        success: true,
        message: `Equipo "${updated.name}" ${accion} exitosamente.`,
        team: updated
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al cambiar estado del equipo: ' + error.message });
    }
  }
};

export default teamsController;
