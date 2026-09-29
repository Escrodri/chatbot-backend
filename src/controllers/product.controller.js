import { productRepository } from '../repositories/product.repository.js';
import { mediaService } from '../services/media.service.js';
import {
  normalizarMensajes,
  normalizarBump,
  normalizarEntregables,
  linksDe
} from '../services/producto-textos.js';
import { config } from '../config/index.js';

const esAdminDe = (req) => req.user?.role === 'admin' || req.user?.role === 'superadmin';

/**
 * Un identificador a partir del nombre: "Recetario Mesa Llena" → "recetario-mesa-llena".
 * El cliente nunca lo ve; existe para que n8n y los reportes tengan algo estable.
 */
function slugDesde(nombre) {
  return String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'producto';
}

/** El primero libre entre "slug", "slug-2", "slug-3"… */
async function slugLibre(base, exceptoId = null) {
  let candidato = base;
  for (let n = 2; n < 200; n++) {
    const otro = await productRepository.findBySlug(candidato);
    if (!otro || (exceptoId && Number(otro.id) === Number(exceptoId))) return candidato;
    candidato = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Revisa el producto extra contra la base: que exista, sea del mismo equipo y
 * tenga con qué entregarse. Un extra sin link cobraría algo que no se puede dar.
 *
 * @returns {Promise<string[]>} errores
 */
async function revisarExtraEnBase(bump, { productId = null, teamId = null } = {}) {
  if (!bump.product_id) return [];
  const extra = await productRepository.findById(bump.product_id);
  if (!extra) return ['El producto elegido como extra ya no existe.'];
  if (productId && Number(extra.id) === Number(productId)) return ['Un producto no se puede ofrecer como extra de sí mismo.'];
  if (teamId && extra.team_id && Number(extra.team_id) !== Number(teamId)) return ['El producto extra tiene que ser de este mismo negocio.'];
  if (bump.activo && !linksDe(extra).length) {
    return [`"${extra.name}" no tiene link de entrega. Cargáselo antes de ofrecerlo como extra: si no, se cobraría algo que no se puede entregar.`];
  }
  return [];
}

/** Lo que se devuelve de un producto. El link de entrega solo a administradores. */
function publico(p, esAdmin) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,

    // La versión corta para la tarjeta de WhatsApp. Si está vacía se cae a
    // la descripción larga recortada, que es peor pero no deja el mensaje
    // sin contenido mientras nadie escribió el resumen todavía.
    resumen: (p.resumen && p.resumen.trim()) || String(p.description || '').slice(0, 1024),

    price: Number(p.price),
    price_formatted: formatearMonto(p.price, p.currency),
    currency: p.currency,
    cover_url: p.cover_url,
    is_active: p.is_active,
    team_id: p.team_id || null,
    sort_order: p.sort_order ?? 0,
    solo_extra: Boolean(p.solo_extra),

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

    // Lo que el bot dice sobre este producto, tal como se cargó en el panel.
    mensajes: normalizarMensajes(p.mensajes).mensajes,

    // El producto extra que se ofrece al comprar este.
    bump: normalizarBump(p.bump).bump,

    ...(esAdmin ? {
      delivery_url: p.delivery_url || '',
      delivery_note: p.delivery_note || '',
      entregables: linksDe(p)
    } : {
      // Al bot le alcanza con saber si hay con qué entregar, no con qué.
      tiene_entrega: linksDe(p).length > 0
    })
  };
}

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
      const esAdmin = esAdminDe(req);
      const incluirInactivos = req.query.all === 'true' && esAdmin;

      const teamId = req.user?.team_id || null;

      // El bot recibe solo lo que se vende suelto. Los productos que solo se
      // venden como extra de otro los ve el panel, no el catálogo.
      const productos = await productRepository.list({
        teamId,
        soloActivos: !incluirInactivos,
        soloVendibles: !esAdmin
      });

      // El bot nunca debería recibir el link de entrega junto al catálogo: ese
      // link es lo que se paga, y el catálogo se manda antes de cobrar.
      //
      // Pero el panel sí lo necesita, y por no dárselo se estaba perdiendo:
      // el formulario cargaba el campo vacío porque nunca le llegaba, y al
      // guardar cualquier otro cambio mandaba ese vacío de vuelta y borraba el
      // enlace. Se entrega solo a una persona con sesión de administrador,
      // nunca al token de servicio que usa el bot.
      const publicos = productos.map(p => publico(p, esAdmin));

      return res.json({
        products: publicos,
        catalog_text: construirTextoCatalogo(productos.filter(p => !p.solo_extra))
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar productos: ' + error.message });
    }
  },

  /**
   * Un producto con todo lo que hace falta para editarlo.
   * GET /api/products/:id  (solo administradores)
   */
  async getOne(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
      if (!esAdminDe(req)) {
        return res.status(403).json({ error: 'Solo un administrador puede editar productos.' });
      }

      const producto = await productRepository.findById(id);
      if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
      if (req.user?.team_id && producto.team_id && producto.team_id !== req.user.team_id) {
        return res.status(404).json({ error: 'Producto no encontrado' });
      }

      return res.json({ product: publico(producto, true) });
    } catch (error) {
      return res.status(500).json({ error: 'Error al leer el producto: ' + error.message });
    }
  },

  /**
   * Datos de entrega de un producto.
   *
   * El enlace de entrega ES el producto: es exactamente lo que el cliente paga.
   * Esta dirección lo devolvía a cualquiera con sesión y al token de servicio,
   * sin mirar si había un pedido detrás ni de qué equipo era. Con un usuario
   * cualquiera y un bucle sobre los ids se bajaba el catálogo completo gratis.
   *
   * La entrega de verdad no pasa por acá: la hace `deliveryService` después de
   * que alguien confirma el pago, leyendo el enlace directo de la base. Así que
   * esto queda solo para el panel, y solo para administradores.
   *
   * GET /api/products/:id/delivery
   */
  async getDelivery(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      if (req.user?.role !== 'admin' && req.user?.role !== 'superadmin') {
        return res.status(403).json({ error: 'Solo un administrador puede ver el enlace de entrega.' });
      }

      const producto = await productRepository.findById(id);
      if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });

      // Aislamiento por equipo: un administrador de un equipo no tiene por qué
      // ver el material que vende otro.
      if (req.user?.team_id && producto.team_id && producto.team_id !== req.user.team_id) {
        return res.status(404).json({ error: 'Producto no encontrado' });
      }

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
              precio_recuperacion, preview_urls, mensajes,
              entregables, bump, solo_extra } = req.body || {};

      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'El producto necesita un nombre.' });
      }

      const monto = Number(price);
      if (!Number.isFinite(monto) || monto < 0) {
        return res.status(400).json({ error: 'El precio no es un número válido' });
      }

      const revisados = normalizarMensajes(mensajes);
      // Los productos de antes mandaban un solo link; los nuevos, la lista.
      const links = normalizarEntregables(
        entregables !== undefined ? entregables : (delivery_url ? [{ etiqueta: '', url: delivery_url }] : [])
      );
      const extra = normalizarBump(bump);
      const errores = [...new Set([
        ...revisados.errores,
        ...links.errores,
        ...extra.errores,
        ...(await revisarExtraEnBase(extra.bump, { teamId: req.user?.team_id || null }))
      ])];
      if (errores.length) {
        return res.status(400).json({ error: errores.join(' '), errores });
      }

      // El identificador ya no lo tiene que inventar nadie: sale del nombre.
      const pedido = String(slug || '').trim();
      if (pedido && await productRepository.findBySlug(pedido)) {
        return res.status(409).json({ error: `Ya existe un producto con el identificador "${pedido}".` });
      }
      const slugFinal = pedido || await slugLibre(slugDesde(name));

      const creado = await productRepository.create({
        teamId: req.user?.team_id || (req.body?.team_id ? Number(req.body.team_id) : 1),
        slug: slugFinal,
        name: String(name).trim(),
        description: description || '',
        resumen: resumen || null,
        price: monto,
        currency: currency || 'PYG',
        deliveryUrl: links.entregables[0]?.url || null,
        deliveryNote: delivery_note || null,
        coverUrl: cover_url || null,
        isActive: is_active !== false,
        sortOrder: Number(sort_order) || 0,
        // Vacío, cero o algo que no es número significan "sin precio de
        // recuperación". Guardar un cero haría que el bot ofrezca el material
        // gratis, así que se trata igual que si no estuviera.
        precioRecuperacion: Number(precio_recuperacion) > 0 ? Number(precio_recuperacion) : null,
        previewUrls: separarLineas(preview_urls).join('\n') || null,
        mensajes: revisados.mensajes,
        entregables: links.entregables,
        bump: extra.bump,
        soloExtra: solo_extra === true
      });

      return res.status(201).json(publico(creado, true));
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

      if (b.slug !== undefined) {
        const pedido = String(b.slug || '').trim();
        if (pedido) {
          const otro = await productRepository.findBySlug(pedido);
          if (otro && Number(otro.id) !== id) {
            return res.status(409).json({ error: `Ya existe un producto con el identificador "${pedido}".` });
          }
          cambios.slug = pedido;
        }
      }
      if (b.name !== undefined) cambios.name = String(b.name).trim();
      if (b.description !== undefined) cambios.description = b.description;
      if (b.resumen !== undefined) cambios.resumen = b.resumen || null;
      if (b.currency !== undefined) cambios.currency = b.currency;
      // Los links de entrega. `delivery_url` queda siempre como copia del
      // primero, porque es lo que mira todo el resto del sistema para saber si
      // un producto se puede entregar. Si llega solo `delivery_url` (el panel
      // de antes), pasa a ser la lista entera.
      if (b.entregables !== undefined || b.delivery_url !== undefined) {
        const links = normalizarEntregables(
          b.entregables !== undefined ? b.entregables : (b.delivery_url ? [{ etiqueta: '', url: b.delivery_url }] : [])
        );
        if (links.errores.length) {
          return res.status(400).json({ error: links.errores.join(' '), errores: links.errores });
        }
        cambios.entregables = links.entregables;
        cambios.deliveryUrl = links.entregables[0]?.url || null;
      }

      if (b.bump !== undefined) {
        const extra = normalizarBump(b.bump, { productId: id });
        const errores = [...new Set([
          ...extra.errores,
          ...(await revisarExtraEnBase(extra.bump, { productId: id, teamId: existente.team_id || req.user?.team_id || null }))
        ])];
        if (errores.length) {
          return res.status(400).json({ error: errores.join(' '), errores });
        }
        cambios.bump = extra.bump;
      }

      if (b.solo_extra !== undefined) cambios.soloExtra = b.solo_extra === true;
      if (b.team_id !== undefined) cambios.teamId = b.team_id ? Number(b.team_id) : null;
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

      if (b.mensajes !== undefined) {
        const revisados = normalizarMensajes(b.mensajes);
        if (revisados.errores.length) {
          return res.status(400).json({ error: revisados.errores.join(' '), errores: revisados.errores });
        }
        cambios.mensajes = revisados.mensajes;
      }

      if (b.price !== undefined) {
        const monto = Number(b.price);
        if (!Number.isFinite(monto) || monto < 0) {
          return res.status(400).json({ error: 'El precio no es un número válido' });
        }
        cambios.price = monto;
      }

      const actualizado = await productRepository.update(id, cambios);
      return res.json(publico(actualizado, true));
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
