import { productRepository } from '../repositories/product.repository.js';

/** Formatea un monto con separadores locales (Gs. 35.000). */
function formatearMonto(valor, moneda = 'PYG') {
  const numero = Number(valor) || 0;
  const locales = { PYG: 'es-PY', USD: 'en-US', ARS: 'es-AR', BRL: 'pt-BR' };
  const simbolos = { PYG: 'Gs.', USD: 'US$', ARS: '$', BRL: 'R$' };

  const formateado = new Intl.NumberFormat(locales[moneda] || 'es-PY', {
    maximumFractionDigits: moneda === 'PYG' ? 0 : 2
  }).format(numero);

  return `${simbolos[moneda] || ''} ${formateado}`.trim();
}

/**
 * Arma el texto del catálogo tal como va a salir por WhatsApp.
 *
 * Se genera acá y no en n8n a propósito: el día que cambie el formato, cambia
 * en un solo lugar y no hay que tocar el flujo ni volver a publicarlo.
 */
function construirTextoCatalogo(productos) {
  if (!productos.length) return 'Por el momento no tenemos productos disponibles.';

  return productos
    .map(p => {
      const precio = formatearMonto(p.price, p.currency);
      const desc = (p.description || '').trim();
      return desc
        ? `▸ *${p.name}* — ${precio}\n   ${desc}`
        : `▸ *${p.name}* — ${precio}`;
    })
    .join('\n\n');
}

export const productController = {
  /**
   * Catálogo. Lo consumen la web, el panel y el bot de n8n.
   * GET /api/products
   */
  async list(req, res) {
    try {
      const incluirInactivos = req.query.all === 'true' &&
        (req.user?.role === 'admin' || req.user?.role === 'superadmin');

      const teamId = req.user?.team_id || null;

      const productos = await productRepository.list({
        teamId,
        soloActivos: !incluirInactivos
      });

      // El bot nunca debería recibir el link de entrega junto al catálogo:
      // ese link es lo que se paga, y el catálogo se manda antes de cobrar.
      const publicos = productos.map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        price_formatted: formatearMonto(p.price, p.currency),
        currency: p.currency,
        cover_url: p.cover_url,
        is_active: p.is_active
      }));

      return res.json({
        products: publicos,
        catalog_text: construirTextoCatalogo(productos)
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar productos: ' + error.message });
    }
  },

  /**
   * Datos de entrega de un producto. Solo con token de servicio o sesión,
   * y pensado para llamarse DESPUÉS de confirmar el pago.
   * GET /api/products/:id/delivery
   */
  async getDelivery(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const producto = await productRepository.findById(id);
      if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

      return res.json({
        id: producto.id,
        name: producto.name,
        delivery_url: producto.delivery_url,
        delivery_note: producto.delivery_note
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al obtener la entrega: ' + error.message });
    }
  },

  /**
   * POST /api/products  (solo administradores)
   */
  async create(req, res) {
    try {
      const { slug, name, description, price, currency, delivery_url,
              delivery_note, cover_url, is_active, sort_order } = req.body || {};

      if (!slug || !name) {
        return res.status(400).json({ error: 'El producto necesita al menos slug y nombre' });
      }

      const monto = Number(price);
      if (!Number.isFinite(monto) || monto < 0) {
        return res.status(400).json({ error: 'El precio no es un número válido' });
      }

      if (await productRepository.findBySlug(slug)) {
        return res.status(409).json({ error: `Ya existe un producto con el slug "${slug}"` });
      }

      const creado = await productRepository.create({
        teamId: req.user?.team_id || null,
        slug: String(slug).trim(),
        name: String(name).trim(),
        description: description || '',
        price: monto,
        currency: currency || 'PYG',
        deliveryUrl: delivery_url || null,
        deliveryNote: delivery_note || null,
        coverUrl: cover_url || null,
        isActive: is_active !== false,
        sortOrder: Number(sort_order) || 0
      });

      return res.status(201).json(creado);
    } catch (error) {
      return res.status(500).json({ error: 'Error al crear el producto: ' + error.message });
    }
  },

  /**
   * PUT /api/products/:id  (solo administradores)
   */
  async update(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const existente = await productRepository.findById(id);
      if (!existente) return res.status(404).json({ error: 'Producto no encontrado' });

      const b = req.body || {};
      const cambios = {};

      if (b.slug !== undefined) cambios.slug = String(b.slug).trim();
      if (b.name !== undefined) cambios.name = String(b.name).trim();
      if (b.description !== undefined) cambios.description = b.description;
      if (b.currency !== undefined) cambios.currency = b.currency;
      if (b.delivery_url !== undefined) cambios.deliveryUrl = b.delivery_url;
      if (b.delivery_note !== undefined) cambios.deliveryNote = b.delivery_note;
      if (b.cover_url !== undefined) cambios.coverUrl = b.cover_url;
      if (b.is_active !== undefined) cambios.isActive = Boolean(b.is_active);
      if (b.sort_order !== undefined) cambios.sortOrder = Number(b.sort_order) || 0;

      if (b.price !== undefined) {
        const monto = Number(b.price);
        if (!Number.isFinite(monto) || monto < 0) {
          return res.status(400).json({ error: 'El precio no es un número válido' });
        }
        cambios.price = monto;
      }

      const actualizado = await productRepository.update(id, cambios);
      return res.json(actualizado);
    } catch (error) {
      return res.status(500).json({ error: 'Error al actualizar el producto: ' + error.message });
    }
  },

  /**
   * DELETE /api/products/:id  — baja lógica (solo administradores)
   */
  async remove(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const desactivado = await productRepository.desactivar(id);
      if (!desactivado) return res.status(404).json({ error: 'Producto no encontrado' });

      return res.json({ success: true, product: desactivado });
    } catch (error) {
      return res.status(500).json({ error: 'Error al desactivar el producto: ' + error.message });
    }
  }
};

export default productController;
