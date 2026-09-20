import { contactRepository } from '../repositories/contact.repository.js';
import { userRepository } from '../repositories/user.repository.js';

/**
 * Directorio de contactos.
 *
 * Antes esta pantalla leía de localStorage: mostraba una lista que vivía solo
 * en el navegador de quien la abría y que nunca tuvo nada que ver con la gente
 * que realmente escribió. Ahora consulta la tabla `contacts`, que es la que se
 * llena sola cuando alguien manda un mensaje.
 */
export const contactController = {
  /** GET /api/contacts */
  async list(req, res) {
    try {
      const { platform = null, search = null, limit = 200, offset = 0 } = req.query;

      // Mismo aislamiento que el resto: un operador ve solo sus canales.
      let assignedChannelIds = null;
      if (req.user.role === 'agent') {
        assignedChannelIds = await userRepository.getAssignedChannelIds(req.user.id);
      }

      const contactos = await contactRepository.listWithFilters({
        teamId: req.user.team_id || null,
        platform,
        search,
        assignedChannelIds,
        limit: parseInt(limit, 10) || 200,
        offset: parseInt(offset, 10) || 0
      });

      return res.json(contactos);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar contactos: ' + error.message });
    }
  },

  /** GET /api/contacts/stats */
  async stats(req, res) {
    try {
      let assignedChannelIds = null;
      if (req.user.role === 'agent') {
        assignedChannelIds = await userRepository.getAssignedChannelIds(req.user.id);
      }

      const datos = await contactRepository.stats({
        teamId: req.user.team_id || null,
        assignedChannelIds
      });

      return res.json(datos);
    } catch (error) {
      return res.status(500).json({ error: 'Error al calcular totales: ' + error.message });
    }
  }
};

export default contactController;
