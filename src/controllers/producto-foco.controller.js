import { resolverProducto } from '../services/producto-foco.service.js';

/**
 * POST /api/conversations/:id/producto
 * { texto, boton_id, es_imagen, saludo, nombre }
 *
 * Lo llama el guion con cada mensaje, antes de todo lo demás: responde de qué
 * producto se está hablando o, si no se sabe, el mensaje para preguntárselo.
 */
export const productoFocoController = {
  async resolver(req, res) {
    try {
      const conversationId = parseInt(req.params.id, 10);
      if (isNaN(conversationId)) return res.status(400).json({ error: 'ID de conversación inválido' });
      const b = req.body || {};
      const r = await resolverProducto({
        conversationId,
        texto: String(b.texto || ''),
        botonId: String(b.boton_id || ''),
        esImagen: b.es_imagen === true || b.es_imagen === 'true',
        saludo: b.saludo ? String(b.saludo) : undefined,
        nombre: b.nombre ? String(b.nombre) : ''
      });
      return res.json(r);
    } catch (err) {
      return res.status(500).json({ error: 'No se pudo resolver el producto: ' + err.message });
    }
  }
};

export default productoFocoController;
