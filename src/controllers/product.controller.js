import { productRepository } from '../repositories/product.repository.js';
import { mediaService } from '../services/media.service.js';
import { config } from '../config/index.js';

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
 * Parte un texto de varias líneas en una lista, sin vacíos.
 *
 * Las páginas de muestra se cargan pegando URLs en un cuadro de texto, que es
 * como lo hace una persona, y se entregan partidas, que es como lo necesita el
 * flujo. Tolera líneas en blanco y espacios de más porque siempre los hay.
 *
 * @param {string|null|undefined} texto
 * @returns {string[]}
 */
function separarLineas(texto) {
  return String(texto || '')
    .split(/[\n,]+/)
    .map(l => l.trim())
    .filter(Boolean);
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

      // El bot nunca debería recibir el link de entrega junto al catálogo: ese
      // link es lo que se paga, y el catálogo se manda antes de cobrar.
      //
      // Pero el panel sí lo necesita, y por no dárselo se estaba perdiendo:
      // el formulario cargaba el campo vacío porque nunca le llegaba, y al
      // guardar cualquier otro cambio mandaba ese vacío de vuelta y borraba el
      // enlace. El síntoma aparecía mucho después, al confirmar un pago, con
      // un "este producto no tiene enlace cargado" que no se parecía en nada a
      // su causa. Se entrega solo a una persona con sesión de administrador,
      // nunca al token de servicio que usa el bot.
      const esAdmin = req.user?.role === 'admin' || req.user?.role === 'superadmin';

      const publicos = productos.map(p => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,

        // La versión corta para la tarjeta de WhatsApp. Si está vacía se cae a
        // la descripción larga recortada, que es peor pero no deja el mensaje
        // sin contenido mientras nadie escribió el resumen todavía.
        resumen: (p.resumen && p.resumen.trim()) || String(p.description || '').slice(0, 220),

        price: Number(p.price),
        price_formatted: formatearMonto(p.price, p.currency),
        currency: p.currency,
        cover_url: p.cover_url,
        is_active: p.is_active,

        // Precio de recuperación, para insistirle a quien se quedó a mitad de
        // camino. Va null cuando el campo está vacío, y entonces el flujo
        // insiste al precio de siempre: es así como se apaga el descuento, sin
        // tocar nada del guion.
        precio_recuperacion: p.precio_recuperacion !== null && p.precio_recuperacion !== undefined
          ? Number(p.precio_recuperacion)
          : null,
        precio_recuperacion_formatted: p.precio_recuperacion !== null && p.precio_recuperacion !== undefined
          ? formatearMonto(p.precio_recuperacion, p.currency)
          : null,

        // Las páginas de muestra se guardan como texto, una URL por línea,
        // porque así es como una persona las carga. Se entregan ya partidas
        // para que el flujo no tenga que saber cómo están guardadas.
        preview_urls: separarLineas(p.preview_urls),

        ...(esAdmin ? {
          delivery_url: p.delivery_url || '',
          delivery_note: p.delivery_note || ''
        } : {})
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
   * Sube la imagen de portada de un producto.
   *
   * Reusa exactamente la misma tuberia que las imagenes del chat
   * (mediaService.saveBase64Media + respaldar), en vez de pedirle al admin que
   * consiga una URL publica por su cuenta. Si hay Cloudinary configurado el
   * archivo termina ahi; si no, queda en /uploads, que ya se sirve publico
   * porque Meta necesita poder descargarlo.
   *
   * POST /api/products/upload-image
   */
  async uploadImage(req, res) {
    try {
      const { fileBase64, fileName, mimeType } = req.body || {};

      if (!fileBase64) {
        return res.status(400).json({ error: 'No se recibió ninguna imagen' });
      }

      // La portada la termina mostrando WhatsApp: solo imagenes, y solo los
      // formatos que Meta acepta sin convertir.
      const tipo = String(mimeType || '').toLowerCase();
      if (!tipo.startsWith('image/')) {
        return res.status(400).json({ error: 'El archivo debe ser una imagen' });
      }
      if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(tipo)) {
        return res.status(400).json({ error: 'Formato no admitido. Usá JPG, PNG o WebP.' });
      }

      let guardado = await mediaService.saveBase64Media({ fileBase64, fileName, mimeType });
      guardado = await mediaService.respaldar(guardado);

      // n8n y Meta descargan esta imagen desde afuera: tiene que ser absoluta.
      const url = /^https?:\/\//i.test(guardado.localUrl)
        ? guardado.localUrl
        : `${(config.publicUrl || '').replace(/\/+$/, '')}${guardado.localUrl}`;

      return res.status(201).json({
        url,
        fileName: guardado.fileName || fileName,
        mimeType: guardado.mimeType || mimeType,
        enCloudinary: Boolean(guardado.remoteUrl)
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al subir la imagen: ' + error.message });
    }
  },

  /**
   * POST /api/products  (solo administradores)
   */
  async create(req, res) {
    try {
      const { slug, name, description, resumen, price, currency, delivery_url,
              delivery_note, cover_url, is_active, sort_order,
              precio_recuperacion, preview_urls } = req.body || {};

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
        resumen: resumen || null,
        price: monto,
        currency: currency || 'PYG',
        deliveryUrl: delivery_url || null,
        deliveryNote: delivery_note || null,
        coverUrl: cover_url || null,
        isActive: is_active !== false,
        sortOrder: Number(sort_order) || 0,
        // Vacío, cero o algo que no es número significan "sin precio de
        // recuperación". Guardar un cero haría que el bot ofrezca el material
        // gratis, así que se trata igual que si no estuviera.
        precioRecuperacion: Number(precio_recuperacion) > 0 ? Number(precio_recuperacion) : null,
        previewUrls: separarLineas(preview_urls).join('\n') || null
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
      if (b.resumen !== undefined) cambios.resumen = b.resumen || null;
      if (b.currency !== undefined) cambios.currency = b.currency;
      if (b.delivery_url !== undefined) cambios.deliveryUrl = b.delivery_url;
      if (b.delivery_note !== undefined) cambios.deliveryNote = b.delivery_note;
      if (b.cover_url !== undefined) cambios.coverUrl = b.cover_url;
      if (b.is_active !== undefined) cambios.isActive = Boolean(b.is_active);
      if (b.sort_order !== undefined) cambios.sortOrder = Number(b.sort_order) || 0;

      // Vaciar el campo es cómo se apaga el descuento de recuperación, así que
      // un valor vacío tiene que poder llegar hasta la base como null.
      if (b.precio_recuperacion !== undefined) {
        cambios.precioRecuperacion = Number(b.precio_recuperacion) > 0
          ? Number(b.precio_recuperacion)
          : null;
      }

      if (b.preview_urls !== undefined) {
        cambios.previewUrls = separarLineas(b.preview_urls).join('\n') || null;
      }

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
