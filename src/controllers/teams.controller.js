import bcrypt from 'bcryptjs';
import { teamRepository } from '../repositories/team.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';

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
   * Obtiene la información completa de un equipo, sus operadores y sus canales.
   * GET /api/teams/:id
   */
  async getTeamDetails(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      const team = await teamRepository.findById(teamId);
      if (!team) return res.status(404).json({ error: 'Equipo no encontrado.' });

      const users = await userRepository.listAll(teamId);
      const channels = await channelRepository.listAll(teamId);

      return res.json({
        team,
        users,
        channels
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al obtener detalle del equipo: ' + error.message });
    }
  },

  /**
   * Lista los operadores y administradores de un equipo.
   * GET /api/teams/:id/users
   */
  async getTeamUsers(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      const users = await userRepository.listAll(teamId);
      return res.json(users);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar usuarios del equipo: ' + error.message });
    }
  },

  /**
   * Registra un nuevo operador o administrador dentro de un equipo.
   * POST /api/teams/:id/users
   */
  async createTeamUser(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      const team = await teamRepository.findById(teamId);
      if (!team) return res.status(404).json({ error: 'Equipo no encontrado.' });

      const { email, password, name, role = 'agent', channelIds } = req.body || {};

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Correo electrónico inválido.' });
      }
      if (!password || password.length < 12) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 12 caracteres.' });
      }
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'El nombre del operador es obligatorio.' });
      }
      if (!['admin', 'agent'].includes(role)) {
        return res.status(400).json({ error: 'Rol inválido. Debe ser admin o agent.' });
      }

      const existing = await userRepository.findByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'Ya existe un usuario con ese correo electrónico.' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const newUser = await userRepository.create({
        teamId,
        email,
        passwordHash,
        name: String(name).trim(),
        role,
        isActive: true
      });

      if (Array.isArray(channelIds) && channelIds.length > 0) {
        newUser.channel_ids = await userRepository.setAssignedChannels(newUser.id, channelIds);
      } else {
        newUser.channel_ids = [];
      }

      return res.status(201).json({
        success: true,
        message: `Usuario "${newUser.name}" registrado correctamente en el equipo "${team.name}".`,
        user: newUser
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al crear usuario del equipo: ' + error.message });
    }
  },

  /**
   * Actualiza los datos de un operador (nombre, email, rol, contraseña, canales).
   * PUT /api/teams/:id/users/:userId
   */
  async updateTeamUser(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      const userId = parseInt(req.params.userId, 10);
      if (!teamId || !userId) return res.status(400).json({ error: 'IDs inválidos.' });

      const user = await userRepository.findById(userId);
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

      const { name, email, role, isActive, password, channelIds } = req.body || {};

      if (email && email.toLowerCase().trim() !== user.email.toLowerCase()) {
        if (!email.includes('@')) {
          return res.status(400).json({ error: 'Correo electrónico inválido.' });
        }
        const existing = await userRepository.findByEmail(email);
        if (existing && existing.id !== userId) {
          return res.status(409).json({ error: 'Ya existe otro usuario con ese correo electrónico.' });
        }
      }

      let passwordHash = undefined;
      if (password && String(password).trim()) {
        if (String(password).trim().length < 12) {
          return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 12 caracteres.' });
        }
        passwordHash = await bcrypt.hash(String(password).trim(), 12);
      }

      const updateData = {};
      if (name !== undefined && String(name).trim()) updateData.name = String(name).trim();
      if (email !== undefined && String(email).trim()) updateData.email = String(email).toLowerCase().trim();
      if (role !== undefined && ['admin', 'agent', 'superadmin'].includes(role)) updateData.role = role;
      if (isActive !== undefined) updateData.isActive = Boolean(isActive);
      if (passwordHash) updateData.passwordHash = passwordHash;

      const updated = await userRepository.updateUser(userId, updateData);

      if (Array.isArray(channelIds)) {
        updated.channel_ids = await userRepository.setAssignedChannels(userId, channelIds);
      } else {
        updated.channel_ids = await userRepository.getAssignedChannelIds(userId);
      }

      return res.json({
        success: true,
        message: `Usuario "${updated.name}" actualizado correctamente.`,
        user: updated
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al actualizar usuario: ' + error.message });
    }
  },

  /**
   * Alterna el estado activo/inactivo de un operador (soft toggle).
   * PATCH /api/teams/:id/users/:userId/status
   */
  async toggleTeamUserStatus(req, res) {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!userId) return res.status(400).json({ error: 'ID de usuario inválido.' });

      const user = await userRepository.findById(userId);
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

      if (user.role === 'superadmin') {
        return res.status(400).json({ error: 'El Superadministrador no puede ser desactivado.' });
      }

      const updated = await userRepository.toggleStatus(userId);
      const accion = updated.is_active ? 'activado' : 'desactivado';
      return res.json({
        success: true,
        message: `Usuario "${updated.name}" ${accion} exitosamente.`,
        user: updated
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al cambiar estado del usuario: ' + error.message });
    }
  },

  /**
   * Lista los canales vinculados a un equipo.
   * GET /api/teams/:id/channels
   */
  async getTeamChannels(req, res) {
    try {
      const teamId = parseInt(req.params.id, 10);
      if (!teamId) return res.status(400).json({ error: 'ID de equipo inválido.' });

      const channels = await channelRepository.listAll(teamId);
      return res.json(channels);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar canales del equipo: ' + error.message });
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
