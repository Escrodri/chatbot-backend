import { query } from '../database/index.js';
import { productRepository } from '../repositories/product.repository.js';
import { formatoGs } from '../utils/comprobante.util.js';

const formatearMonto = (valor, moneda = 'PYG') => (moneda && moneda !== 'PYG' ? `${moneda} ${Number(valor).toLocaleString('es-PY')}` : formatoGs(valor));

/**
 * De qué producto se está hablando en cada conversación.
 *
 * Con un solo producto no hacía falta preguntárselo a nadie. Con varios, el
 * guion adivinaba en cada mensaje buscando palabras del nombre en el texto, y
 * si no encontraba ninguna agarraba el primero del catálogo. Un "bueno" o la
 * foto del comprobante (una imagen no tiene texto) cambiaban de producto solos:
 * el pago se contaba para el pedido equivocado y se entregaba el libro que no
 * era.
 *
 * Ahora la conversación tiene un producto fijo, que cambia solo por algo que
 * la persona hizo a propósito, en este orden:
 *
 *   1. tocó un botón que lleva el producto adentro ("comprar:12", "prod:12");
 *   2. escribió el nombre de un producto (el mensaje automático del anuncio
 *      "Quiero el PDF de Grandes Historias de la Biblia" es justamente eso);
 *   3. si no, sigue el que ya tenía la conversación;
 *   4. si mandó una imagen y no tenía ninguno, el de su pedido sin pagar;
 *   5. si el catálogo tiene uno solo, ese;
 *   6. si no, hay que preguntarle cuál quiere. También a quien ya compró y
 *      vuelve a escribir sin nombrar nada: es la oportunidad de mostrarle
 *      los otros materiales.
 */

// Palabras que están en casi todos los nombres y no distinguen un producto
// de otro: con ellas, "quiero el pdf" coincidiría con todo el catálogo.
const COMUNES = new Set([
  'pdf', 'libro', 'libros', 'para', 'colorear', 'pintar', 'material', 'materiales',
  'quiero', 'hola', 'info', 'informacion', 'precio', 'como', 'este', 'esta', 'ese',
  'digital', 'imprimir', 'imprimible', 'ninos', 'nino', 'ninas', 'nina', 'chicos',
  'grandes', 'mejores', 'completo', 'completa', 'desde', 'hasta', 'sobre', 'todo', 'todos'
]);

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palabrasClave(p) {
  const base = normalizar(`${p.name} ${(p.slug || '').split('-').join(' ')}`);
  return [...new Set(base.split(' ').filter(w => w.length > 3 && !COMUNES.has(w)))];
}

/**
 * El producto que nombra el texto, si nombra a uno solo sin dudas.
 * Hace falta que coincidan al menos dos palabras propias del nombre (o todas,
 * si tiene una sola), y que ningún otro producto empate.
 */
export function productoDelTexto(texto, productos) {
  const t = ` ${normalizar(texto)} `;
  if (t.trim().length < 3) return null;

  const puntajes = productos.map(p => {
    const claves = palabrasClave(p);
    const acierto = claves.filter(w => t.includes(` ${w} `)).length;
    const nombreEntero = normalizar(p.name).length > 6 && t.includes(` ${normalizar(p.name)} `);
    const minimo = Math.min(2, claves.length || 1);
    return { p, acierto, ok: nombreEntero || (claves.length > 0 && acierto >= minimo), extra: nombreEntero ? 100 : 0 };
  }).filter(x => x.ok).sort((a, b) => (b.acierto + b.extra) - (a.acierto + a.extra));

  if (!puntajes.length) return null;
  if (puntajes[1] && (puntajes[1].acierto + puntajes[1].extra) === (puntajes[0].acierto + puntajes[0].extra)) return null;
  return puntajes[0].p;
}

/** El id de producto que viaja dentro de un botón: "comprar:12", "prod:12". */
export function productoDelBoton(botonId) {
  const m = String(botonId || '').match(/^(comprar|ver_paginas|prod):(\d+)$/);
  return m ? Number(m[2]) : null;
}

/** Hasta 24 letras para el título de una opción de lista de WhatsApp. */
export function nombreCorto(nombre, max = 24) {
  const base = String(nombre || '').split(/\s+[—–-]\s+|\s*\(/)[0].trim() || String(nombre || '').trim();
  if (base.length <= max) return base;
  const corte = base.slice(0, max - 1);
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > 8 ? corte.slice(0, espacio) : corte).trim()}…`;
}

async function catalogoDe(conv) {
  const todos = await productRepository.list({ soloActivos: true });
  const equipo = conv.team_id || null;
  return todos.filter(p => !equipo || !p.team_id || p.team_id === equipo);
}

async function guardarFoco(conversationId, productId) {
  await query(
    `UPDATE conversations SET producto_foco_id = $1 WHERE id = $2 AND producto_foco_id IS DISTINCT FROM $1`,
    [productId, conversationId]
  );
}

/** El pedido sin pagar más reciente de la conversación, si hay uno. */
async function pedidoPendiente(conversationId) {
  const { rows } = await query(
    `SELECT product_id FROM orders
      WHERE conversation_id = $1 AND product_id IS NOT NULL
        AND status IN ('interesado', 'comprobante_recibido')
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [conversationId]
  );
  return rows[0]?.product_id || null;
}

/** ¿Ya pagó el pedido de este producto? */
async function yaPagado(conversationId, productId) {
  const { rows } = await query(
    `SELECT 1 FROM orders WHERE conversation_id = $1 AND product_id = $2
        AND status IN ('pagado', 'entregado') LIMIT 1`,
    [conversationId, productId]
  );
  return rows.length > 0;
}

const NO_ES_NOMBRE = /^(solo|dios|amor|bendecida|bendecido|mama|mami|papa|papi|hola|feliz|princesa|reina|negra|negro|gorda|flaca|gordo|lic|dra|dr|sra|sr|profe|senora|señora|la|el|mi|tu|su|yo|fe|ser|by|the|mrs|mr)$/i;

/** El primer nombre, si parece un nombre: nada de ".", emojis ni "solo Dios juzga". */
export function nombrePila(nombre) {
  const n = String(nombre || '').trim();
  if (!n || /^usuario\s*\d*$/i.test(n)) return '';
  const w = (n.split(/\s+/)[0] || '').replace(/[^\p{L}'-]/gu, '');
  if (w.replace(/[^\p{L}]/gu, '').length < 2 || NO_ES_NOMBRE.test(w)) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function armarPregunta(productos, { saludo = 'Hola', nombre = '', esImagen = false } = {}) {
  const lineas = productos.map(p => `• *${p.name}* — ${formatearMonto(p.price, p.currency)}`).join('\n');
  const texto = esImagen
    ? `¡Gracias! 🙌 ¿Para cuál de estos materiales es el pago?\n\n${lineas}\n\nElegilo acá abajo y mandame la captura de nuevo, así lo reviso para ese.`
    : `${saludo}${nombre ? `, ${nombre}` : ''}! 👋 ¿Cuál de estos materiales te interesa?\n\n${lineas}`;

  // Hasta tres entran como botones, que se tocan sin abrir nada. Más de tres
  // van en una lista: WhatsApp no permite más botones que eso.
  if (productos.length <= 3) {
    return {
      text: texto,
      buttons: productos.map(p => ({ id: `prod:${p.id}`, title: nombreCorto(p.name, 20) }))
    };
  }
  return {
    text: texto,
    lista: {
      boton: 'Ver materiales',
      opciones: productos.slice(0, 10).map(p => ({
        id: `prod:${p.id}`,
        title: nombreCorto(p.name, 24),
        description: `${formatearMonto(p.price, p.currency)} · ${p.name}`.slice(0, 72)
      }))
    }
  };
}

/**
 * @param {{ conversationId:number, texto?:string, botonId?:string, esImagen?:boolean,
 *           saludo?:string, nombre?:string }} p
 * @returns {Promise<{ product_id:number|null, origen:string, elegir:boolean, pregunta?:object, cantidad:number }>}
 */
export async function resolverProducto({ conversationId, texto = '', botonId = '', esImagen = false, saludo, nombre }) {
  const { rows } = await query(
    `SELECT c.id, c.producto_foco_id, ch.team_id
       FROM conversations c LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1`,
    [conversationId]
  );
  const conv = rows[0];
  if (!conv) return { product_id: null, origen: 'sin_conversacion', elegir: false, cantidad: 0 };

  const productos = await catalogoDe(conv);
  const existe = (id) => productos.some(p => Number(p.id) === Number(id));
  const listo = async (id, origen) => {
    await guardarFoco(conversationId, Number(id));
    return { product_id: Number(id), origen, elegir: false, cantidad: productos.length };
  };

  const deBoton = productoDelBoton(botonId);
  if (deBoton && existe(deBoton)) return listo(deBoton, 'boton');

  if (!esImagen) {
    const delTexto = productoDelTexto(texto, productos);
    if (delTexto) return listo(delTexto.id, 'texto');
  }

  if (conv.producto_foco_id && existe(conv.producto_foco_id)) {
    // Una captura de pago cuando el producto en foco ya está pagado y hay
    // otro pedido esperando: el pago es para el que falta.
    if (esImagen && await yaPagado(conversationId, conv.producto_foco_id)) {
      const pendiente = await pedidoPendiente(conversationId);
      if (pendiente && existe(pendiente)) return listo(pendiente, 'pedido_pendiente');
    }
    return { product_id: Number(conv.producto_foco_id), origen: 'conversacion', elegir: false, cantidad: productos.length };
  }

  const pendiente = await pedidoPendiente(conversationId);
  if (pendiente && existe(pendiente)) return listo(pendiente, 'pedido_pendiente');

  if (productos.length === 1) return listo(productos[0].id, 'unico');

  if (!productos.length) return { product_id: null, origen: 'catalogo_vacio', elegir: false, cantidad: 0 };

  return {
    product_id: null,
    origen: 'preguntar',
    elegir: true,
    cantidad: productos.length,
    pregunta: armarPregunta(productos, { saludo: saludo || 'Hola', nombre: nombrePila(nombre), esImagen })
  };
}

export default { resolverProducto, productoDelTexto, productoDelBoton, nombreCorto, nombrePila };
