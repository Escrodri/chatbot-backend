import { ofertaRepository } from '../repositories/oferta.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { soportaEquipos } from '../repositories/order.repository.js';
import { olvidarCampanas, idsDeAnuncios, fechaParaguay } from '../services/precio.service.js';
import { formatoGs, leerMontoPYG } from '../utils/comprobante.util.js';

/**
 * Campañas de precio: remarketing, promos con fecha.
 *
 * Se crean desde el panel y no desde el guion por una razón: el precio de una
 * promo decide cuánto se cobra, y eso lo tiene que poder cambiar el dueño sin
 * tocar n8n ni redesplegar nada. Y tiene que quedar escrito quién la creó.
 */

/**
 * Una fecha tal como la manda el panel.
 *
 * El campo de fecha y hora del navegador manda "2026-10-07T23:59", sin zona.
 * Esa hora es la de Paraguay —es la que el dueño escribió mirando su reloj—,
 * y Paraguay es UTC-3 todo el año. Si se la tomara como UTC, una promo "hasta
 * las 23:59" terminaría a las 20:59, justo cuando más gente escribe.
 */
function leerFecha(valor) {
  if (!valor) return null;
  // Lo que viene de la base ya es una fecha con zona: no hay nada que adivinar.
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  const texto = String(valor).trim();
  const conZona = /([zZ]|[+-]\d{2}:?\d{2})$/.test(texto);
  const d = new Date(conZona ? texto : `${texto.length === 16 ? texto + ':00' : texto}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function error(res, codigo, mensaje) {
  return res.status(codigo).json({ error: mensaje });
}

function esAdmin(req) {
  return ['admin', 'superadmin'].includes(req.user?.role);
}

/**
 * Valida y normaliza lo que manda el panel. Devuelve `{ datos }` o `{ problema }`.
 *
 * Cada regla está para que una campaña mal cargada no cobre mal:
 *   - el precio tiene que ser menor al de lista (una "promo" más cara es un
 *     error de tipeo, y cobrarla es cobrar de más);
 *   - tiene que terminar después de empezar, y después de ahora;
 *   - si es solo para invitados, tiene que tener por dónde entrar: un anuncio
 *     o una palabra clave. Sin eso nadie la recibiría nunca y nadie se daría
 *     cuenta de por qué.
 */
function validar(body, producto) {
  const nombre = String(body.nombre || '').trim().slice(0, 80);
  if (nombre.length < 3) return { problema: 'Ponele un nombre a la campaña (al menos 3 letras).' };

  // "15.000" es quince mil, como lo escribe cualquiera en Paraguay. Leerlo
  // como número de JavaScript lo convertía en 15 —el punto como decimal— y
  // la campaña quedaba cobrando quince guaraníes. Se lee con la misma regla
  // que los comprobantes.
  const precio = typeof body.precio === 'number'
    ? Math.round(body.precio)
    : (leerMontoPYG(body.precio).monto || 0);
  if (!(precio > 0)) return { problema: 'El precio de la campaña tiene que ser un número mayor a cero.' };

  const lista = Number(producto.price) || 0;
  if (lista && precio >= lista) {
    return { problema: `El precio de la campaña (${formatoGs(precio)}) tiene que ser menor al de lista (${formatoGs(lista)}).` };
  }

  // Un piso contra el cero que se cae: "1.500" en vez de "15.000" es una
  // promo al 8% que nadie quiso hacer. Menos de un cuarto del precio de
  // lista no es una promo, es un error de tipeo, y el panel no tiene cómo
  // preguntar "¿seguro?".
  if (lista && precio < lista * 0.25) {
    return { problema: `${formatoGs(precio)} es menos de un cuarto del precio de lista (${formatoGs(lista)}). Revisá que no falte un cero.` };
  }

  const desde = leerFecha(body.desde) || new Date();
  const hasta = leerFecha(body.hasta);
  if (!hasta) return { problema: 'Falta la fecha y hora en que termina.' };
  if (hasta <= desde) return { problema: 'La campaña tiene que terminar después de empezar.' };

  const alcance = body.alcance === 'todos' ? 'todos' : 'invitados';
  const anuncios = idsDeAnuncios(body.anuncios).join(',');
  const palabraClave = String(body.palabra_clave || '').trim().slice(0, 60);

  if (palabraClave && palabraClave.replace(/[^a-z0-9]/gi, '').length < 4) {
    return { problema: 'La palabra clave tiene que tener al menos 4 letras o números, para que no se active por casualidad.' };
  }
  if (alcance === 'invitados' && !anuncios && !palabraClave) {
    return { problema: 'Una campaña solo para invitados necesita el id de al menos un anuncio o una palabra clave. Si no, nadie podría entrar.' };
  }

  const gracia = body.gracia_horas === undefined || body.gracia_horas === '' ? 24 : Number(body.gracia_horas);
  if (!(gracia >= 0 && gracia <= 168)) return { problema: 'La tolerancia tiene que estar entre 0 y 168 horas.' };

  return {
    datos: {
      nombre,
      productId: producto.id,
      precio,
      desde,
      hasta,
      alcance,
      anuncios: anuncios || null,
      palabraClave: palabraClave || null,
      graciaHoras: Math.round(gracia),
      activa: body.activa === undefined ? true : Boolean(body.activa)
    }
  };
}

async function productoDelEquipo(req, productId) {
  const producto = await productRepository.findById(parseInt(productId, 10));
  if (!producto) return null;
  if (req.user?.role !== 'superadmin' && req.user?.team_id && await soportaEquipos()
      && producto.team_id && producto.team_id !== req.user.team_id) {
    return null;
  }
  return producto;
}

function presentar(c) {
  const ahora = Date.now();
  const estado = !c.activa
    ? 'apagada'
    : new Date(c.desde).getTime() > ahora
      ? 'programada'
      : new Date(c.hasta).getTime() < ahora
        ? 'terminada'
        : 'en_curso';
  return {
    ...c,
    estado,
    desde_texto: fechaParaguay(c.desde),
    hasta_texto: fechaParaguay(c.hasta),
    precio_formateado: formatoGs(c.precio)
  };
}

export const campanaController = {
  /** GET /api/campanas */
  async listar(req, res) {
    try {
      const teamId = req.user?.role === 'superadmin' ? null : (req.user?.team_id || null);
      const filas = await ofertaRepository.listarCampanas(teamId);
      return res.json(filas.map(presentar));
    } catch (err) {
      return error(res, 500, 'No se pudieron leer las campañas: ' + err.message);
    }
  },

  /** POST /api/campanas */
  async crear(req, res) {
    try {
      if (!esAdmin(req)) return error(res, 403, 'Solo un administrador puede crear campañas de precio.');

      const producto = await productoDelEquipo(req, req.body?.product_id);
      if (!producto) return error(res, 400, 'Elegí un producto de tu catálogo.');

      const { datos, problema } = validar(req.body || {}, producto);
      if (problema) return error(res, 400, problema);
      if (datos.hasta.getTime() <= Date.now()) return error(res, 400, 'Esa fecha de fin ya pasó.');

      const creada = await ofertaRepository.crearCampana({ ...datos, userId: req.user?.id || null });
      olvidarCampanas();

      console.log(
        `🏷️ [CAMPAÑA] ${req.user?.name || req.user?.email || 'alguien'} creó "${datos.nombre}": ` +
        `${formatoGs(datos.precio)} (${producto.name}) del ${fechaParaguay(datos.desde)} al ${fechaParaguay(datos.hasta)}, ` +
        `${datos.alcance === 'todos' ? 'para todos' : 'solo invitados'}.`
      );

      const completa = await ofertaRepository.buscarCampana(creada.id);
      return res.status(201).json(presentar({ ...completa, personas: 0, ventas: 0, recaudado: 0 }));
    } catch (err) {
      return error(res, 500, 'No se pudo crear la campaña: ' + err.message);
    }
  },

  /**
   * PATCH /api/campanas/:id
   *
   * Sirve para editar y para apagar ({ activa: false }). Apagar no borra: las
   * ofertas y las ventas quedan registradas, pero la campaña deja de dar
   * precio, también a los que ya habían entrado.
   */
  async actualizar(req, res) {
    try {
      if (!esAdmin(req)) return error(res, 403, 'Solo un administrador puede cambiar campañas de precio.');

      const id = parseInt(req.params.id, 10);
      const actual = await ofertaRepository.buscarCampana(id);
      if (!actual) return error(res, 404, 'Campaña no encontrada.');

      const producto = await productoDelEquipo(req, actual.product_id);
      if (!producto) return error(res, 404, 'Campaña no encontrada.');

      const b = req.body || {};
      const mezcla = {
        nombre: b.nombre ?? actual.nombre,
        precio: b.precio ?? actual.precio,
        desde: b.desde ?? actual.desde,
        hasta: b.hasta ?? actual.hasta,
        alcance: b.alcance ?? actual.alcance,
        anuncios: b.anuncios ?? actual.anuncios,
        palabra_clave: b.palabra_clave ?? actual.palabra_clave,
        gracia_horas: b.gracia_horas ?? actual.gracia_horas,
        activa: b.activa ?? actual.activa
      };

      // Apagar tiene que funcionar siempre, aunque la campaña ya haya
      // terminado o tenga algo que hoy no pasaría la validación.
      if (b.activa === false && Object.keys(b).length === 1) {
        const apagada = await ofertaRepository.actualizarCampana(id, {
          nombre: actual.nombre, precio: actual.precio, desde: actual.desde, hasta: actual.hasta,
          alcance: actual.alcance, anuncios: actual.anuncios, palabraClave: actual.palabra_clave,
          graciaHoras: actual.gracia_horas, activa: false
        });
        olvidarCampanas();
        console.log(`🏷️ [CAMPAÑA] "${actual.nombre}" apagada por ${req.user?.name || req.user?.email || 'alguien'}.`);
        return res.json(presentar({ ...actual, ...apagada, activa: false }));
      }

      const { datos, problema } = validar(mezcla, producto);
      if (problema) return error(res, 400, problema);

      const guardada = await ofertaRepository.actualizarCampana(id, datos);
      olvidarCampanas();
      return res.json(presentar({ ...actual, ...guardada }));
    } catch (err) {
      return error(res, 500, 'No se pudo actualizar la campaña: ' + err.message);
    }
  }
};

export default campanaController;
