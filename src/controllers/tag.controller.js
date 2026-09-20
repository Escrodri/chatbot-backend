import { tagRepository } from '../repositories/tag.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { socketManager } from '../sockets/index.js';

export const tagController = {
  /** GET /api/tags — etiquetas del equipo (siembra un juego inicial si no hay). */
  async list(req, res) {
    try {
      const etiquetas = await tagRepository.listOrSeed(req.user.team_id || null);
      return res.json(etiquetas);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar etiquetas: ' + error.message });
    }
  },

  /**
   * POST /api/tags — crea una etiqueta del equipo.
   *
   * La puede crear cualquier asesor: la necesidad de una etiqueta nueva aparece
   * en medio de una conversación, y hacer que espere a un admin la mata.
   */
  async create(req, res) {
    try {
      const { name, color = '#6b7280', sort_order = 0 } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'La etiqueta necesita un nombre' });
      }
      if (String(name).trim().length > 60) {
        return res.status(400).json({ error: 'El nombre es demasiado largo (máximo 60)' });
      }

      const creada = await tagRepository.create({
        teamId: req.user.team_id || null,
        name: String(name).trim(),
        color,
        sortOrder: Number(sort_order) || 0
      });
      return res.status(201).json(creada);
    } catch (error) {
      return res.status(500).json({ error: 'Error al crear la etiqueta: ' + error.message });
    }
  },

  /** DELETE /api/tags/:id — solo administradores; se borra para todo el equipo. */
  async remove(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const borrada = await tagRepository.remove(id, req.user.team_id || null);
      if (!borrada) return res.status(404).json({ error: 'Etiqueta no encontrada en tu equipo' });

      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Error al borrar la etiqueta: ' + error.message });
    }
  },

  /** GET /api/conversations/:id/tags */
  async listForConversation(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
      return res.json(await tagRepository.listByConversation(id));
    } catch (error) {
      return res.status(500).json({ error: 'Error al leer las etiquetas: ' + error.message });
    }
  },

  /** POST /api/conversations/:id/tags  body: { tag_id } */
  async assign(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const tagId = parseInt(req.body?.tag_id, 10);
      if (isNaN(id) || isNaN(tagId)) {
        return res.status(400).json({ error: 'Faltan identificadores válidos' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

      const etiquetas = await tagRepository.assign(id, tagId, req.user.id || null);

      // El resto del equipo ve el cambio sin recargar.
      socketManager.emitConversationUpdated(conv.channel_id, { id, tags: etiquetas });

      return res.json(etiquetas);
    } catch (error) {
      return res.status(500).json({ error: 'Error al poner la etiqueta: ' + error.message });
    }
  },

  /** DELETE /api/conversations/:id/tags/:tagId */
  async unassign(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const tagId = parseInt(req.params.tagId, 10);
      if (isNaN(id) || isNaN(tagId)) return res.status(400).json({ error: 'Identificadores inválidos' });

      const conv = await conversationRepository.findById(id);
      if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

      const etiquetas = await tagRepository.unassign(id, tagId);
      socketManager.emitConversationUpdated(conv.channel_id, { id, tags: etiquetas });

      return res.json(etiquetas);
    } catch (error) {
      return res.status(500).json({ error: 'Error al quitar la etiqueta: ' + error.message });
    }
  }
};

export default tagController;
