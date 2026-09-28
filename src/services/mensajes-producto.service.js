import { conversationRepository } from '../repositories/conversation.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { graphApiService } from './graph-api.service.js';
import { socketManager } from '../sockets/index.js';
import { horaEnParaguay } from '../config/env.config.js';
import { precioParaPersona } from './precio.service.js';

/**
 * Lo que el bot le dice al cliente sobre cada producto.
 *
 * Los textos se cargan en el panel, dentro de cada producto, y se guardan en
 * `products.mensajes`. Acá no hay ni una frase de venta: este servicio solo
 * rellena las variables, arma los botones y manda los mensajes en orden. Un
 * producto nuevo se vende con lo que alguien escribió en Productos, sin tocar
 * código ni n8n.
 *
 * Forma de `products.mensajes`:
 *
 *   presentacion     1 a 3 mensajes. El último sale con los botones.
 *   boton_comprar    Texto del botón para comprar (hasta 20 caracteres).
 *   boton_muestras   Texto del botón para ver las muestras (hasta 20).
 *   muestras_intro   Lo que se dice antes de mandar las páginas de muestra.
 *   muestras_cierre  Lo que se dice después, con el botón de comprar.
 *   entrega          El mensaje con el que se entrega el material.
 */

/** Límites de WhatsApp. Meta rechaza el mensaje entero si uno se pasa. */
export const LIMITES = Object.freeze({
  conBotones: 1024,
  texto: 4096,
  boton: 20,
  partes: 3
});

/** Pausa entre dos mensajes del mismo paso: nadie escribe tres cosas en el mismo segundo. */
const PAUSA_MS = 3000;

/** Botones por si el producto no tiene los suyos. Son acciones, no copy de venta. */
const BOTON_COMPRAR = 'Lo quiero';
const BOTON_MUESTRAS = 'Ver muestras';

export const VARIABLES = Object.freeze([
  'saludo', 'nombre', 'producto', 'precio', 'precio_lista', 'precio_texto', 'links'
]);

function texto(valor) {
  return String(valor ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * Deja `products.mensajes` en su forma y dice qué está fuera de los límites.
 *
 * Se usa al guardar (para rechazar lo que WhatsApp no va a aceptar) y al leer
 * (para no confiar en que la base tenga siempre la forma esperada).
 *
 * @param {object|null} entrada
 * @returns {{ mensajes: object, errores: string[] }}
 */
export function normalizarMensajes(entrada) {
  const e = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const errores = [];

  const presentacion = (Array.isArray(e.presentacion) ? e.presentacion : [])
    .map(texto)
    .filter(Boolean);

  if (presentacion.length > LIMITES.partes) {
    errores.push(`La presentación puede tener hasta ${LIMITES.partes} mensajes.`);
  }

  presentacion.slice(0, LIMITES.partes).forEach((t, i, lista) => {
    const conBotones = i === lista.length - 1;
    const tope = conBotones ? LIMITES.conBotones : LIMITES.texto;
    if (t.length > tope) {
      errores.push(
        `El mensaje ${i + 1} de la presentación tiene ${t.length} caracteres y el máximo es ${tope}` +
        (conBotones ? ' porque sale con los botones.' : '.')
      );
    }
  });

  const mensajes = {
    presentacion: presentacion.slice(0, LIMITES.partes),
    boton_comprar: texto(e.boton_comprar),
    boton_muestras: texto(e.boton_muestras),
    muestras_intro: texto(e.muestras_intro),
    muestras_cierre: texto(e.muestras_cierre),
    entrega: texto(e.entrega)
  };

  for (const [clave, nombre] of [['boton_comprar', 'El botón para comprar'], ['boton_muestras', 'El botón para ver muestras']]) {
    if (mensajes[clave].length > LIMITES.boton) {
      errores.push(`${nombre} tiene ${mensajes[clave].length} caracteres y WhatsApp acepta hasta ${LIMITES.boton}.`);
    }
  }
  if (mensajes.muestras_intro.length > LIMITES.texto) {
    errores.push(`El texto antes de las muestras pasa de ${LIMITES.texto} caracteres.`);
  }
  if (mensajes.muestras_cierre.length > LIMITES.conBotones) {
    errores.push(`El texto después de las muestras tiene ${mensajes.muestras_cierre.length} caracteres y el máximo es ${LIMITES.conBotones} porque sale con el botón.`);
  }
  if (mensajes.entrega.length > LIMITES.texto) {
    errores.push(`El mensaje de entrega pasa de ${LIMITES.texto} caracteres.`);
  }

  return { mensajes, errores };
}

/**
 * Reemplaza {{variables}} y acomoda lo que queda raro cuando una viene vacía.
 *
 * El caso típico es el nombre: "¡{{saludo}}, {{nombre}}!" sin nombre daría
 * "¡Buen día, !". Una coma pegada a un signo de cierre no la escribe nadie.
 */
export function renderizar(plantilla, vars = {}) {
  let salida = String(plantilla || '');
  for (const clave of VARIABLES) {
    salida = salida.replace(new RegExp(`\\{\\{\\s*${clave}\\s*\\}\\}`, 'gi'), vars[clave] ?? '');
  }
  return salida
    .replace(/,\s*([!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function formatearMonto(valor, moneda = 'PYG') {
  const numero = Number(valor) || 0;
  const locales = { PYG: 'es-PY', USD: 'en-US', ARS: 'es-AR', BRL: 'pt-BR' };
  const simbolos = { PYG: 'Gs.', USD: 'US$', ARS: '$', BRL: 'R$' };
  const formateado = new Intl.NumberFormat(locales[moneda] || 'es-PY', {
    maximumFractionDigits: moneda === 'PYG' ? 0 : 2
  }).format(numero);
  return `${simbolos[moneda] || ''} ${formateado}`.trim();
}

function saludoSegunHora(fecha = new Date()) {
  const h = horaEnParaguay(fecha);
  if (h < 5) return 'Hola';
  if (h < 12) return 'Buen día';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** El nombre de pila, o vacío si Meta no lo dio ("Usuario 4821" no es un nombre). */
function primerNombre(bruto) {
  const limpio = String(bruto || '').trim();
  if (!limpio || /^usuario\s*\d*$/i.test(limpio)) return '';
  return limpio.split(/\s+/)[0];
}

function separarLineas(valor) {
  if (Array.isArray(valor)) return valor.map(v => String(v).trim()).filter(Boolean);
  return String(valor || '').split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

/**
 * Manda un mensaje como bot, lo guarda en la bandeja y avisa por socket.
 *
 * No pasa el chat a una persona: es el bot hablando, igual que cuando n8n
 * llama a /messages con el token de servicio.
 */
async function mandar(conv, canal, { texto: cuerpo = '', botones = [], imagen = null }) {
  const contentType = imagen ? 'image' : 'text';
  const guardado = await messageRepository.insertMessage({
    conversationId: conv.id,
    channelId: conv.channel_id,
    direction: 'outbound',
    senderType: 'bot',
    contentType,
    text: cuerpo,
    mediaUrl: imagen,
    mediaMime: imagen ? 'image/jpeg' : null,
    status: 'pending'
  });
  if (guardado) guardado.sender_user_name = 'Asistente';

  const resumen = cuerpo || '📷 Imagen';

  try {
    const r = await graphApiService.sendMessage({
      channel: canal,
      recipientId: conv.platform_user_id || conv.contact_phone,
      text: cuerpo,
      mediaUrl: imagen,
      contentType,
      lastCustomerInteraction: conv.last_customer_interaction,
      buttons: botones
    });

    const metaId = r?.metaMessageId || null;
    if (guardado) {
      await messageRepository.updateStatus(guardado.id, 'sent', metaId);
      guardado.status = 'sent';
      guardado.meta_message_id = metaId;
      socketManager.emitMessageSent(conv.channel_id, guardado);
    }
    await conversationRepository.updateOutboundMessage(conv.id, resumen);
    socketManager.emitConversationUpdated(conv.channel_id, {
      id: conv.id,
      last_message_text: resumen,
      last_message_time: new Date()
    });
    return { ok: true, tipo: contentType, texto: cuerpo, botones: botones.map(b => b.title) };
  } catch (err) {
    const detalle = err.message || 'Meta rechazó el envío.';
    if (guardado) {
      const fallido = await messageRepository.markFailed(guardado.id, { code: err.code || 'ERR_PASO', message: detalle });
      if (fallido) Object.assign(guardado, fallido);
      guardado.status = 'failed';
      socketManager.emitMessageSent(conv.channel_id, guardado);
    }
    return { ok: false, tipo: contentType, texto: cuerpo, detalle };
  }
}

/**
 * Manda una lista de mensajes en orden, con una pausa entre uno y otro.
 *
 * Si uno falla se sigue con el resto: una foto de muestra que Meta no pudo
 * bajar no justifica dejar a la persona sin el mensaje con los botones.
 */
async function mandarEnOrden(conv, canal, envios) {
  const resultados = [];
  for (let i = 0; i < envios.length; i++) {
    if (i > 0) await esperar(PAUSA_MS);
    resultados.push(await mandar(conv, canal, envios[i]));
  }
  return resultados;
}

export const mensajesProductoService = {
  LIMITES,
  VARIABLES,
  normalizarMensajes,
  renderizar,

  /** Los valores de las variables para esta persona y este producto. */
  async variables(conv, producto) {
    const moneda = producto.currency || 'PYG';
    const lista = Number(producto.price) || 0;

    let precio = lista;
    let esPromo = false;
    try {
      const pp = await precioParaPersona({
        conversationId: conv.id,
        productId: producto.id,
        precioLista: lista,
        momentos: [Date.now()]
      });
      precio = Number(pp.precio) || lista;
      esPromo = Boolean(pp.es_promo) && precio < lista;
    } catch {
      // Sin ofertas legibles se usa el precio de lista, que es el lado seguro.
    }

    const precioTexto = formatearMonto(precio, moneda);
    const listaTexto = formatearMonto(lista, moneda);

    return {
      saludo: saludoSegunHora(),
      nombre: primerNombre(conv.contact_name),
      producto: producto.name || '',
      precio: precioTexto,
      precio_lista: listaTexto,
      // Solo dice "en vez de" cuando esta persona tiene de verdad un precio más bajo.
      precio_texto: esPromo ? `${precioTexto} (en vez de ${listaTexto})` : precioTexto,
      links: ''
    };
  },

  /**
   * Manda un paso del guion de un producto.
   *
   * @param {{ conversationId: number, paso: string, productId: number }} p
   * @returns {Promise<{ status: number, cuerpo: object }>}
   */
  async enviarPaso({ conversationId, paso, productId }) {
    if (!['presentacion', 'muestras'].includes(paso)) {
      return { status: 400, cuerpo: { error: `Paso desconocido: "${paso}". Pasos válidos: presentacion, muestras.` } };
    }

    const conv = await conversationRepository.findById(conversationId);
    if (!conv) return { status: 404, cuerpo: { error: 'Conversación no encontrada' } };

    const producto = await productRepository.findById(productId);
    if (!producto) return { status: 404, cuerpo: { error: 'Producto no encontrado' } };

    const canal = await channelRepository.findById(conv.channel_id);
    if (!canal || !canal.accessToken) {
      return { status: 409, cuerpo: { error: 'El canal de esta conversación no tiene token de Meta.' } };
    }

    const { mensajes } = normalizarMensajes(producto.mensajes);
    const vars = await this.variables(conv, producto);
    const muestras = separarLineas(producto.preview_urls);
    const comprar = { id: `comprar:${producto.id}`, title: mensajes.boton_comprar || BOTON_COMPRAR };

    const envios = [];

    if (paso === 'presentacion') {
      const botones = [
        ...(muestras.length ? [{ id: `ver_paginas:${producto.id}`, title: mensajes.boton_muestras || BOTON_MUESTRAS }] : []),
        comprar
      ];

      // Sin mensajes cargados todavía, el producto se presenta con sus propios
      // datos: nombre, precio y resumen. Nunca con un texto de otro producto.
      const partes = mensajes.presentacion.length
        ? mensajes.presentacion
        : [['*{{producto}}*', '{{precio_texto}}', texto(producto.resumen || producto.description)].filter(Boolean).join('\n\n')];

      if (producto.cover_url) envios.push({ imagen: producto.cover_url });
      partes.forEach((t, i) => {
        envios.push({ texto: renderizar(t, vars), botones: i === partes.length - 1 ? botones : [] });
      });
    } else {
      if (mensajes.muestras_intro) envios.push({ texto: renderizar(mensajes.muestras_intro, vars) });
      for (const url of muestras) envios.push({ imagen: url });

      const cierre = mensajes.muestras_cierre || '*{{producto}}* — {{precio_texto}}';
      envios.push({ texto: renderizar(cierre, vars), botones: [comprar] });
    }

    const resultados = await mandarEnOrden(conv, canal, envios);
    const fallidos = resultados.filter(r => !r.ok);

    return {
      status: fallidos.length === resultados.length ? 502 : 200,
      cuerpo: {
        ok: fallidos.length === 0,
        paso,
        product_id: producto.id,
        enviados: resultados.length - fallidos.length,
        fallidos: fallidos.map(f => f.detalle),
        mensajes: resultados
      }
    };
  },

  /**
   * El mensaje de entrega del producto, si tiene uno cargado.
   *
   * @param {object} pedido Fila de `findConEntrega` (trae `product_mensajes`)
   * @returns {string|null} null si el producto no tiene mensaje de entrega propio
   */
  armarEntrega(pedido) {
    const { mensajes } = normalizarMensajes(pedido.product_mensajes);
    if (!mensajes.entrega) return null;

    const conLinks = /\{\{\s*links\s*\}\}/i.test(mensajes.entrega);
    const cuerpo = renderizar(mensajes.entrega, {
      saludo: saludoSegunHora(),
      nombre: primerNombre(pedido.contact_name),
      producto: pedido.product_name || '',
      links: pedido.delivery_url || ''
    });

    // El link es lo que se pagó: si el texto no lo incluye, va al final igual.
    return conLinks ? cuerpo : `${cuerpo}\n\n${pedido.delivery_url}`.trim();
  }
};

export default mensajesProductoService;
