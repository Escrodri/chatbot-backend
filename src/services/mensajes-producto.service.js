import { conversationRepository } from '../repositories/conversation.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { orderRepository, posicionEtapa } from '../repositories/order.repository.js';
import { pedidoItemRepository } from '../repositories/pedido-item.repository.js';
import { graphApiService } from './graph-api.service.js';
import { datosPagoService } from './datos-pago.service.js';
import { socketManager } from '../sockets/index.js';
import { horaEnParaguay } from '../config/env.config.js';
import { precioParaPersona } from './precio.service.js';
import { eventosPedidoService } from './eventos-pedido.service.js';
import {
  LIMITES,
  VARIABLES,
  normalizarMensajes,
  normalizarBump,
  renderizar,
  linksDe
} from './producto-textos.js';

// Se siguen exportando desde acá para lo que ya los importaba de este archivo.
export { LIMITES, VARIABLES, normalizarMensajes, renderizar };

/**
 * Lo que el bot le dice al cliente sobre cada producto, paso por paso.
 *
 * Los textos se cargan en el panel, en la pantalla de cada producto, y se
 * guardan en `products.mensajes` y `products.bump`. Acá no hay frases de
 * venta de ningún producto: este servicio rellena las variables, arma los
 * botones, manda los mensajes en orden y anota en qué quedó el pedido.
 *
 * Los pasos, en el orden en que los vive el cliente:
 *
 *   presentacion  portada + 1 a 3 mensajes, con "Ver muestras" y "Comprar"
 *   muestras      las páginas de muestra y un cierre con "Comprar"
 *   comprar       si el producto tiene un extra, lo ofrece (una sola vez);
 *                 si no, manda los datos de pago
 *   bump_si       suma el extra al pedido y manda los datos con el total
 *   bump_no       sigue sin el extra y manda los datos
 *   datos_pago    manda (o repite) los datos de pago con el total
 *
 * Los textos que están en este archivo son solo los de respaldo, para un
 * producto que todavía no cargó los suyos: son de trámite, no de venta.
 */

/** Pausa entre dos mensajes del mismo paso: nadie escribe tres cosas en el mismo segundo. */
const PAUSA_MS = 3000;

/** Botones por si el producto no tiene los suyos. Son acciones, no copy de venta. */
const BOTON_COMPRAR = 'Lo quiero';
const BOTON_MUESTRAS = 'Ver muestras';
const BOTON_EXTRA_SI = 'Sí, sumalo';
const BOTON_EXTRA_NO = 'No, gracias';

/** Respaldo del mensaje del extra, si el producto no escribió el suyo. */
export const EXTRA_POR_DEFECTO =
  'Antes de pasarte los datos: podés sumar *{{extra}}* por {{precio_extra}}.\n\n' +
  'Con el extra: {{total_con_extra}}\nSolo {{producto}}: {{total_sin_extra}}\n\n¿Lo sumamos?';

/**
 * Respaldo del mensaje con los datos de pago.
 *
 * Es el mismo texto que mandaba n8n. Se mantienen las etiquetas "Alias",
 * "Titular" y "cuenta completa": `datosPagoService.leerDelChat` las busca en
 * este mensaje para saber a qué cuenta se le dijo a esta persona que pague.
 */
export const PAGO_POR_DEFECTO =
  '¡Perfecto! 🙌 Te paso los datos 👇\n\n{{datos_cuenta}}\n\n*Monto:* {{total}}{{detalle}}\n\n' +
  'Cuando transfieras mandame la captura por acá y te paso el enlace de descarga enseguida.\n\n' +
  'Cualquier cosa, escribime por este mismo chat.';

/** Cuando ya los tenía y los vuelve a pedir, o cambió el total. */
export const PAGO_DE_NUEVO =
  'Te paso los datos de nuevo así los tenés a mano 👇\n\n{{datos_cuenta}}\n\n*Monto:* {{total}}{{detalle}}\n\n' +
  'Apenas transfieras mandame la captura por acá y te paso el enlace de descarga.';

/** Tocó "sumar el extra" cuando el pedido ya tenía un comprobante en revisión. */
const EXTRA_TARDE =
  'Ese pedido ya está en revisión, así que el extra no lo puedo sumar ahí. Si lo querés, escribime y lo vemos aparte 🙌';

/** Un botón repetido llega a los pocos segundos. Más tarde, es alguien que volvió a tocar a propósito. */
const VENTANA_REPETIDO_MS = 60 * 1000;

function reciente(fecha) {
  const t = fecha ? new Date(fecha).getTime() : 0;
  return Boolean(t) && Date.now() - t < VENTANA_REPETIDO_MS;
}

function texto(valor) {
  return String(valor ?? '').replace(/\r\n/g, '\n').trim();
}

export function formatearMonto(valor, moneda = 'PYG') {
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
 * Los datos de la cuenta, con las etiquetas que el sistema después busca.
 * Solo aparece lo que está cargado: una línea "Banco:" vacía no le sirve a nadie.
 */
export function bloqueCuenta(d = {}) {
  const lineas = [];
  const alias = d.alias || d.documento;
  if (alias) lineas.push(`⚡ *Alias:* ${alias}`);
  if (d.titular) lineas.push(`*Titular:* ${d.titular}`);
  if (d.banco) lineas.push(`*Banco:* ${d.banco}`);
  if (d.cuenta && d.cuenta !== alias) {
    lineas.push('', `Con el alias es un campo y listo. Si tu app te pide la cuenta completa, es *${d.cuenta}*, mismo titular.`);
  }
  return lineas.join('\n');
}

/**
 * Los links de entrega de todo lo que se compró, listos para el mensaje.
 *
 * Con un solo link queda solo la dirección, como siempre. Con varios, cada
 * uno con su etiqueta; y cada extra en su propio bloque con su nombre, para
 * que la persona sepa qué es cada archivo.
 *
 * @param {{ entregables?: any, delivery_url?: string }} principal
 * @param {object[]} items Filas de `pedidoItemRepository.listar`
 */
export function bloqueLinks(principal, items = []) {
  const lineasDe = (links) => links.map(l => (l.etiqueta ? `${l.etiqueta}: ${l.url}` : l.url)).join('\n');
  const partes = [lineasDe(linksDe(principal))];
  for (const item of items) {
    const links = linksDe(item);
    if (!links.length) continue;
    partes.push(`📄 *${item.nombre || item.product_name || 'Extra'}*\n${lineasDe(links)}`);
  }
  return partes.filter(Boolean).join('\n\n');
}

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

/** La respuesta del endpoint a partir de lo que se mandó. */
function respuesta(paso, producto, resultados, extra = {}) {
  const fallidos = resultados.filter(r => !r.ok);
  return {
    status: resultados.length && fallidos.length === resultados.length ? 502 : 200,
    cuerpo: {
      ok: fallidos.length === 0,
      paso,
      product_id: producto.id,
      enviados: resultados.length - fallidos.length,
      fallidos: fallidos.map(f => f.detalle),
      mensajes: resultados,
      ...extra
    }
  };
}

const PASOS = Object.freeze(['presentacion', 'muestras', 'comprar', 'bump_si', 'bump_no', 'datos_pago']);

export const mensajesProductoService = {
  LIMITES,
  VARIABLES,
  PASOS,
  normalizarMensajes,
  renderizar,

  /** El precio de esta persona para este producto (lista, campaña o recuperación). */
  async precioDe(conv, producto) {
    const lista = Number(producto.price) || 0;
    try {
      const pp = await precioParaPersona({
        conversationId: conv.id,
        productId: producto.id,
        precioLista: lista,
        momentos: [Date.now()]
      });
      const precio = Number(pp.precio) || lista;
      return { precio, lista, esPromo: Boolean(pp.es_promo) && precio < lista };
    } catch {
      // Sin ofertas legibles se usa el precio de lista, que es el lado seguro.
      return { precio: lista, lista, esPromo: false };
    }
  },

  /** Los valores de las variables para esta persona y este producto. */
  async variables(conv, producto, pp = null) {
    const moneda = producto.currency || 'PYG';
    const { precio, lista, esPromo } = pp || await this.precioDe(conv, producto);

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
   * El extra que corresponde ofrecer con este producto, o null.
   *
   * Se ofrece solo si está encendido y el producto extra existe, está activo
   * y tiene con qué entregarse: cobrar algo que no se puede dar es peor que
   * no ofrecerlo.
   */
  async ofertaExtra(producto) {
    const { bump } = normalizarBump(producto?.bump);
    if (!bump.activo || !bump.product_id || !bump.precio) return null;
    if (Number(bump.product_id) === Number(producto.id)) return null;

    const extra = await productRepository.findById(bump.product_id);
    if (!extra || extra.is_active === false || !linksDe(extra).length) return null;
    return { bump, extra };
  },

  /** El pedido de este producto en esta conversación; lo abre si no existe. */
  async pedidoDe(conv, producto) {
    const existente = await orderRepository.findByConversationAndProduct(conv.id, producto.id);
    if (existente) return existente;
    return orderRepository.crearOObtener({
      conversationId: conv.id,
      productId: producto.id,
      contactPhone: conv.platform_user_id || conv.contact_phone || null,
      contactName: conv.contact_name || null,
      amount: Number(producto.price) || null,
      currency: producto.currency || 'PYG'
    });
  },

  /**
   * Cuánto tiene que pagar esta persona: su precio del producto más lo que sumó.
   *
   * @returns {Promise<{ precio:number, extras:number, total:number, items:object[], pp:object }>}
   */
  async totalDe(conv, producto, pedido) {
    const pp = await this.precioDe(conv, producto);
    const items = pedido ? await pedidoItemRepository.listar(pedido.id) : [];
    const extras = items.reduce((s, i) => s + (Number(i.precio) || 0), 0);
    return { precio: pp.precio, extras, total: pp.precio + extras, items, pp };
  },

  /**
   * Manda un paso del guion de un producto.
   *
   * @param {{ conversationId: number, paso: string, productId: number, repetir?: boolean }} p
   * @returns {Promise<{ status: number, cuerpo: object }>}
   */
  async enviarPaso({ conversationId, paso, productId, repetir = false }) {
    if (!PASOS.includes(paso)) {
      return { status: 400, cuerpo: { error: `Paso desconocido: "${paso}". Pasos válidos: ${PASOS.join(', ')}.` } };
    }

    const conv = await conversationRepository.findById(conversationId);
    if (!conv) return { status: 404, cuerpo: { error: 'Conversación no encontrada' } };

    const producto = await productRepository.findById(productId);
    if (!producto) return { status: 404, cuerpo: { error: 'Producto no encontrado' } };

    const canal = await channelRepository.findById(conv.channel_id);
    if (!canal || !canal.accessToken) {
      return { status: 409, cuerpo: { error: 'El canal de esta conversación no tiene token de Meta.' } };
    }

    if (paso === 'presentacion' || paso === 'muestras') {
      return this.presentarOMostrar({ conv, canal, producto, paso });
    }

    const pedido = await this.pedidoDe(conv, producto);

    // Quien ya pagó no vuelve a recibir ofertas ni datos de pago. El guion
    // tampoco llega acá en ese caso; es la segunda llave.
    if (['pagado', 'entregado'].includes(pedido.status)) {
      return { status: 200, cuerpo: { ok: true, paso, accion: 'ya_pago', enviados: 0, order_id: pedido.id } };
    }

    if (paso === 'comprar') return this.comprar({ conv, canal, producto, pedido });
    if (paso === 'bump_si' || paso === 'bump_no') {
      return this.responderExtra({ conv, canal, producto, pedido, acepta: paso === 'bump_si' });
    }
    return this.mandarDatos({ conv, canal, producto, pedido, repetir, paso });
  },

  async presentarOMostrar({ conv, canal, producto, paso }) {
    const { mensajes } = normalizarMensajes(producto.mensajes);
    const vars = await this.variables(conv, producto);
    const muestras = separarLineas(producto.preview_urls);
    const comprar = { id: `comprar:${producto.id}`, title: mensajes.boton_comprar || BOTON_COMPRAR };

    const envios = [];

    if (paso === 'presentacion') {
      const tieneMuestras = muestras.length > 0 || Boolean(mensajes.muestras_intro) || Boolean(mensajes.boton_muestras);
      const botones = [
        comprar,
        ...(tieneMuestras ? [{ id: `ver_paginas:${producto.id}`, title: mensajes.boton_muestras || BOTON_MUESTRAS }] : [])
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
      if (mensajes.muestras_intro) {
        const textoIntro = renderizar(mensajes.muestras_intro, vars);
        const partesIntro = textoIntro.split(/\n\s*---\s*\n/).map(t => t.trim()).filter(Boolean);
        for (const p of partesIntro) {
          envios.push({ texto: p });
        }
      }
      for (const url of muestras) envios.push({ imagen: url });

      const cierre = mensajes.muestras_cierre || '*{{producto}}* — {{precio_texto}}';
      envios.push({ texto: renderizar(cierre, vars), botones: [comprar] });
    }

    const resultados = await mandarEnOrden(conv, canal, envios);
    return respuesta(paso, producto, resultados);
  },

  /**
   * Tocó comprar. Si el producto tiene un extra que todavía no se le ofreció,
   * se le ofrece; si no, van los datos de pago.
   */
  async comprar({ conv, canal, producto, pedido }) {
    // Ya tenía los datos: se los repite con el total de hoy, sin volver a
    // ofrecerle nada.
    if (posicionEtapa(pedido.etapa) >= posicionEtapa('recibio_datos')) {
      return this.mandarDatos({ conv, canal, producto, pedido, repetir: true, paso: 'comprar' });
    }

    // El mismo toque que llega dos veces: la oferta ya salió hace segundos,
    // no se le mandan los datos encima.
    if (pedido.bump_estado === 'ofrecido' && reciente(pedido.bump_at)) {
      return { status: 200, cuerpo: { ok: true, paso: 'comprar', accion: 'repetido', enviados: 0, order_id: pedido.id } };
    }

    const oferta = await this.ofertaExtra(producto);
    if (oferta && !pedido.bump_estado) {
      // Se marca antes de mandar: dos toques seguidos en "comprar" no pueden
      // mandar la oferta dos veces. El segundo encuentra 'ofrecido' y sigue
      // de largo a los datos.
      const marcado = await orderRepository.marcarBump(pedido.id, 'ofrecido');
      if (marcado) return this.ofrecerExtra({ conv, canal, producto, pedido, ...oferta });
    }

    return this.mandarDatos({ conv, canal, producto, pedido, paso: 'comprar' });
  },

  async ofrecerExtra({ conv, canal, producto, pedido, bump, extra }) {
    const moneda = producto.currency || 'PYG';
    const { precio, pp, extras } = await this.totalDe(conv, producto, pedido);
    const vars = {
      ...(await this.variables(conv, producto, pp)),
      extra: extra.name || '',
      precio_extra: formatearMonto(bump.precio, moneda),
      total_con_extra: formatearMonto(precio + extras + bump.precio, moneda),
      total_sin_extra: formatearMonto(precio + extras, moneda)
    };

    const botones = [
      { id: `bump_si:${producto.id}`, title: bump.boton_si || BOTON_EXTRA_SI },
      { id: `bump_no:${producto.id}`, title: bump.boton_no || BOTON_EXTRA_NO }
    ];

    const envios = [];
    if (extra.cover_url) envios.push({ imagen: extra.cover_url });
    const textoCompleto = renderizar(bump.texto || EXTRA_POR_DEFECTO, vars);
    const partesBump = textoCompleto.split(/\n\s*---\s*\n/).map(t => t.trim()).filter(Boolean);
    if (partesBump.length > 1) {
      partesBump.forEach((t, i) => {
        envios.push({ texto: t, botones: i === partesBump.length - 1 ? botones : [] });
      });
    } else {
      envios.push({ texto: textoCompleto, botones });
    }

    const resultados = await mandarEnOrden(conv, canal, envios);
    await orderRepository.marcarEtapa(pedido.id, 'pidio_comprar').catch(() => {});

    // El botón de comprar ya lo tocó: si la oferta no salió, no puede quedarse
    // sin los datos. Se deshace la marca y se manda lo de siempre.
    if (!resultados.some(r => r.ok && r.botones?.length)) {
      await orderRepository.marcarBump(pedido.id, 'rechazado').catch(() => {});
      return this.mandarDatos({ conv, canal, producto, pedido, paso: 'comprar' });
    }

    return respuesta('comprar', producto, resultados, {
      accion: 'extra_ofrecido',
      order_id: pedido.id,
      extra_id: extra.id
    });
  },

  async responderExtra({ conv, canal, producto, pedido, acepta }) {
    const paso = acepta ? 'bump_si' : 'bump_no';

    // Con un comprobante ya en revisión, sumar algo cambiaría lo que tenía
    // que pagar después de haber pagado.
    if (pedido.status !== 'interesado') {
      const resultados = acepta ? [await mandar(conv, canal, { texto: EXTRA_TARDE })] : [];
      return respuesta(paso, producto, resultados, { accion: 'extra_tarde', order_id: pedido.id });
    }

    // Mismo botón dos veces en unos segundos: la primera ya contestó.
    if (pedido.bump_estado === (acepta ? 'aceptado' : 'rechazado') && reciente(pedido.bump_at)) {
      return { status: 200, cuerpo: { ok: true, paso, accion: 'repetido', enviados: 0, order_id: pedido.id } };
    }

    if (acepta) {
      // Solo se suma si el extra se sigue pudiendo vender y entregar hoy.
      const oferta = await this.ofertaExtra(producto);
      if (oferta) {
        await orderRepository.marcarBump(pedido.id, 'aceptado');
        await pedidoItemRepository.agregar({
          orderId: pedido.id,
          productId: oferta.extra.id,
          nombre: oferta.extra.name,
          precio: oferta.bump.precio
        });
      }
    } else {
      // "No" siempre saca lo que haya: aunque el extra se haya cambiado o
      // apagado en el panel, nadie paga algo a lo que dijo que no.
      await orderRepository.marcarBump(pedido.id, 'rechazado');
      await pedidoItemRepository.quitarExtras(pedido.id);
    }

    // Si ya tenía los datos, cambió el total: se los repite con el nuevo.
    const yaTenia = posicionEtapa(pedido.etapa) >= posicionEtapa('recibio_datos');
    return this.mandarDatos({ conv, canal, producto, pedido, repetir: yaTenia, paso });
  },

  /**
   * Los datos para transferir, con el total de esta persona.
   *
   * Si no hay una cuenta cargada (ni en el panel ni en el servidor) no se
   * manda nada y se avisa con `fallback: true`, para que el guion use su
   * propio mensaje. Mandar "Alias: " vacío sería peor que no mandar.
   */
  async mandarDatos({ conv, canal, producto, pedido, repetir = false, paso = 'datos_pago' }) {
    const moneda = producto.currency || 'PYG';
    const { precio, total, items, pp } = await this.totalDe(conv, producto, pedido);

    const cuenta = await datosPagoService.leer();
    if (!cuenta.configurado) {
      // El total va igual: el guion lo usa como "Monto" en su propio mensaje.
      return {
        status: 409,
        cuerpo: {
          ok: false,
          fallback: true,
          motivo: 'sin_datos_pago',
          error: 'No hay una cuenta cargada para cobrar. Cargala en Pedidos → Revisión automática → Datos de pago.',
          order_id: pedido.id,
          total,
          total_formateado: formatearMonto(total, moneda)
        }
      };
    }

    const { mensajes } = normalizarMensajes(producto.mensajes);

    const detalle = items.length
      ? `\n(${producto.name} ${formatearMonto(precio, moneda)} + ` +
        `${items.map(i => `${i.nombre} ${formatearMonto(i.precio, moneda)}`).join(' + ')})`
      : '';

    const vars = {
      ...(await this.variables(conv, producto, pp)),
      datos_cuenta: bloqueCuenta(cuenta),
      total: formatearMonto(total, moneda),
      detalle
    };

    const plantilla = repetir ? PAGO_DE_NUEVO : (mensajes.pago || PAGO_POR_DEFECTO);
    const resultados = [await mandar(conv, canal, { texto: renderizar(plantilla, vars) })];

    if (resultados[0].ok) {
      await orderRepository.marcarEtapa(pedido.id, 'recibio_datos').catch(() => {});
      // A Meta: empezó a pagar, con el total que se le pidió. Una vez por pedido.
      eventosPedidoService.avisar(pedido.id, 'checkout', { valor: total });
    }

    return respuesta(paso, producto, resultados, {
      accion: repetir ? 'datos_repetidos' : 'datos',
      order_id: pedido.id,
      total,
      total_formateado: formatearMonto(total, moneda),
      extras: items.map(i => ({ product_id: i.product_id, nombre: i.nombre, precio: Number(i.precio) }))
    });
  },

  /**
   * El mensaje de entrega del producto, si tiene uno cargado.
   *
   * @param {object} pedido Fila de `findConEntrega` (trae `product_mensajes` y `product_entregables`)
   * @param {object[]} items Lo que se sumó al pedido
   * @returns {string|null} null si el producto no tiene mensaje de entrega propio
   */
  armarEntrega(pedido, items = []) {
    const { mensajes } = normalizarMensajes(pedido.product_mensajes);
    if (!mensajes.entrega) return null;

    const links = bloqueLinks({ entregables: pedido.product_entregables, delivery_url: pedido.delivery_url }, items);
    const conLinks = /\{\{\s*links\s*\}\}/i.test(mensajes.entrega);
    const cuerpo = renderizar(mensajes.entrega, {
      saludo: saludoSegunHora(),
      nombre: primerNombre(pedido.contact_name),
      producto: pedido.product_name || '',
      links
    });

    // Los links son lo que se pagó: si el texto no los incluye, van al final igual.
    return conLinks ? cuerpo : `${cuerpo}\n\n${links}`.trim();
  }
};

export default mensajesProductoService;
