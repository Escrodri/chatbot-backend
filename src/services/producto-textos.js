/**
 * Reglas de lo que se carga en cada producto: textos del bot, producto extra
 * (order bump) y links de entrega.
 *
 * Este archivo no habla con la base ni con WhatsApp: solo dice qué forma
 * tienen los datos y qué está fuera de los límites. Lo usan el controlador al
 * guardar, los servicios al leer y el panel repite las mismas reglas para
 * avisar antes de guardar.
 *
 * Forma de `products.mensajes`:
 *
 *   presentacion     1 a 3 mensajes. El último sale con los botones.
 *   boton_comprar    Texto del botón para comprar (hasta 20 caracteres).
 *   boton_muestras   Texto del botón para ver las muestras (hasta 20).
 *   muestras_intro   Lo que se dice antes de mandar las páginas de muestra.
 *   muestras_cierre  Lo que se dice después, con el botón de comprar.
 *   pago             El mensaje con los datos para transferir.
 *   entrega          El mensaje con el que se entrega el material.
 *   guia_ia          Lo que la IA tiene que saber para vender este producto:
 *                    a quién le sirve, cómo contestar las dudas típicas, qué
 *                    no prometer. No se le manda al cliente: lo lee la IA.
 *   seguimiento      { activo, textos: { nivel_1_decidido, … } } — los
 *                    mensajes para quien se quedó a mitad de camino.
 *
 * Forma de `products.bump` (el producto extra que se ofrece al comprar):
 *
 *   { activo, product_id, precio, texto, boton_si, boton_no }
 *
 * Forma de `products.entregables`: [{ etiqueta, url }, …]
 */

/** Límites de WhatsApp. Meta rechaza el mensaje entero si uno se pasa. */
export const LIMITES = Object.freeze({
  conBotones: 1024,
  texto: 4096,
  boton: 20,
  partes: 3,
  links: 10,
  guia: 6000
});

/** Las variables que entiende cada paso. Una que no está acá le llegaría al cliente tal cual. */
const BASE = ['saludo', 'nombre', 'producto', 'precio', 'precio_lista', 'precio_texto'];

export const VARIABLES_POR_PASO = Object.freeze({
  presentacion: Object.freeze([...BASE]),
  muestras: Object.freeze([...BASE]),
  extra: Object.freeze([...BASE, 'extra', 'precio_extra', 'total_con_extra', 'total_sin_extra']),
  pago: Object.freeze([...BASE, 'datos_cuenta', 'total', 'detalle']),
  entrega: Object.freeze(['saludo', 'nombre', 'producto', 'links']),
  seguimiento: Object.freeze(['nombre', 'producto', 'precio', 'vence', 'moneda'])
});

/** Todas, para el que solo necesita rellenar. */
export const VARIABLES = Object.freeze([...new Set(Object.values(VARIABLES_POR_PASO).flat())]);

/**
 * Los mensajes de seguimiento, en el orden en que se mandan.
 *
 * "decidido" es quien ya tocó comprar o recibió los datos; "mirando" es quien
 * solo vio el producto. Las versiones "sin descuento" se usan cuando el
 * producto no tiene precio de recuperación o la persona ya tiene uno igual o
 * más bajo: el mensaje no puede presentar el precio de siempre como rebaja.
 */
export const CLAVES_SEGUIMIENTO = Object.freeze([
  'nivel_1_decidido',
  'nivel_1_mirando',
  'nivel_2_decidido',
  'nivel_2_mirando',
  'nivel_2_extra',
  'nivel_2_sin_descuento',
  'nivel_3',
  'nivel_3_sin_descuento'
]);

function texto(valor) {
  return String(valor ?? '').replace(/\r\n/g, '\n').trim();
}

/** Las {{variables}} que usa un texto y que ese paso no conoce. */
export function variablesDesconocidas(plantilla, paso) {
  const permitidas = VARIABLES_POR_PASO[paso] || [];
  const usadas = [...String(plantilla || '').matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(m => m[1]);
  return [...new Set(usadas.filter(v => !permitidas.includes(v.toLowerCase())))];
}

/**
 * Reemplaza {{variables}} y acomoda lo que queda raro cuando una viene vacía.
 *
 * El caso típico es el nombre: "¡{{saludo}}, {{nombre}}!" sin nombre daría
 * "¡Buen día, !". Una coma pegada a un signo de cierre no la escribe nadie.
 * Solo se tocan espacios y tabulaciones: los saltos de línea son del texto.
 */
export function renderizar(plantilla, vars = {}) {
  const salida = String(plantilla || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (entera, clave) => {
    const k = clave.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : '';
  });
  return salida
    .replace(/,\s*([!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

  const seg = e.seguimiento && typeof e.seguimiento === 'object' ? e.seguimiento : {};
  const textosSeg = seg.textos && typeof seg.textos === 'object' ? seg.textos : {};

  const mensajes = {
    saludo_anuncio: texto(e.saludo_anuncio),
    frases_anuncio: texto(e.frases_anuncio),
    nombre_corto: texto(e.nombre_corto),
    presentacion: presentacion.slice(0, LIMITES.partes),
    boton_comprar: texto(e.boton_comprar),
    boton_muestras: texto(e.boton_muestras),
    muestras_intro: texto(e.muestras_intro),
    muestras_cierre: texto(e.muestras_cierre),
    pago: texto(e.pago),
    entrega: texto(e.entrega),
    guia_ia: texto(e.guia_ia),
    seguimiento: {
      // Sin dato, encendido: es como funcionaba antes de que existiera el interruptor.
      activo: seg.activo !== false,
      textos: Object.fromEntries(CLAVES_SEGUIMIENTO.map(k => [k, texto(textosSeg[k])]))
    }
  };

  if (mensajes.nombre_corto.length > LIMITES.boton) {
    errores.push(`El nombre corto para botones tiene ${mensajes.nombre_corto.length} caracteres y WhatsApp acepta hasta ${LIMITES.boton}.`);
  }

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
  if (mensajes.pago.length > LIMITES.texto) {
    errores.push(`El mensaje con los datos de pago pasa de ${LIMITES.texto} caracteres.`);
  }
  if (mensajes.entrega.length > LIMITES.texto) {
    errores.push(`El mensaje de entrega pasa de ${LIMITES.texto} caracteres.`);
  }
  if (mensajes.guia_ia.length > LIMITES.guia) {
    errores.push(`La guía para la IA tiene ${mensajes.guia_ia.length} caracteres y el máximo es ${LIMITES.guia}. Dejá lo que más cambia la venta.`);
  }
  for (const k of CLAVES_SEGUIMIENTO) {
    if (mensajes.seguimiento.textos[k].length > LIMITES.texto) {
      errores.push(`Un mensaje de seguimiento pasa de ${LIMITES.texto} caracteres.`);
      break;
    }
  }

  // Una variable mal escrita le llegaría al cliente como "{{nombr}}".
  const revisar = [
    ...mensajes.presentacion.map((t, i) => [t, 'presentacion', `el mensaje ${i + 1} de la presentación`]),
    [mensajes.muestras_intro, 'muestras', 'el texto antes de las muestras'],
    [mensajes.muestras_cierre, 'muestras', 'el texto después de las muestras'],
    [mensajes.pago, 'pago', 'el mensaje de pago'],
    [mensajes.entrega, 'entrega', 'el mensaje de entrega'],
    ...CLAVES_SEGUIMIENTO.map(k => [mensajes.seguimiento.textos[k], 'seguimiento', 'un mensaje de seguimiento'])
  ];
  for (const [t, paso, donde] of revisar) {
    const malas = variablesDesconocidas(t, paso);
    if (malas.length) {
      errores.push(`En ${donde} hay variables que no existen: ${malas.map(v => `{{${v}}}`).join(', ')}.`);
    }
  }

  return { mensajes, errores };
}

/**
 * El producto extra que se ofrece al tocar "comprar".
 *
 * @param {object|null} entrada
 * @param {{ productId?: number|null }} [contexto] Para que un producto no se ofrezca a sí mismo
 * @returns {{ bump: object, errores: string[] }}
 */
export function normalizarBump(entrada, { productId = null } = {}) {
  const e = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const errores = [];

  const idExtra = parseInt(e.product_id, 10);
  const precio = Number(e.precio);

  const bump = {
    activo: e.activo === true,
    product_id: Number.isFinite(idExtra) && idExtra > 0 ? idExtra : null,
    precio: Number.isFinite(precio) && precio > 0 ? precio : null,
    texto: texto(e.texto),
    boton_si: texto(e.boton_si),
    boton_no: texto(e.boton_no)
  };

  if (bump.activo) {
    if (!bump.product_id) errores.push('Elegí qué producto se ofrece como extra.');
    if (!bump.precio) errores.push('Poné el precio del producto extra.');
  }
  if (bump.product_id && productId && Number(bump.product_id) === Number(productId)) {
    errores.push('Un producto no se puede ofrecer como extra de sí mismo.');
  }
  if (bump.texto.length > LIMITES.conBotones) {
    errores.push(`El mensaje del extra tiene ${bump.texto.length} caracteres y el máximo es ${LIMITES.conBotones} porque sale con los botones.`);
  }
  for (const [clave, nombre] of [['boton_si', 'El botón para sumar el extra'], ['boton_no', 'El botón para seguir sin el extra']]) {
    if (bump[clave].length > LIMITES.boton) {
      errores.push(`${nombre} tiene ${bump[clave].length} caracteres y WhatsApp acepta hasta ${LIMITES.boton}.`);
    }
  }
  const malas = variablesDesconocidas(bump.texto, 'extra');
  if (malas.length) {
    errores.push(`En el mensaje del extra hay variables que no existen: ${malas.map(v => `{{${v}}}`).join(', ')}.`);
  }

  return { bump, errores };
}

/**
 * Los links de entrega: uno por cada archivo que recibe quien compra.
 *
 * @param {Array|null} entrada
 * @returns {{ entregables: {etiqueta:string, url:string}[], errores: string[] }}
 */
export function normalizarEntregables(entrada) {
  const lista = Array.isArray(entrada) ? entrada : [];
  const errores = [];

  const entregables = lista
    .map(item => ({
      etiqueta: texto(item?.etiqueta).slice(0, 120),
      url: texto(item?.url)
    }))
    .filter(item => item.url || item.etiqueta);

  entregables.forEach((item, i) => {
    if (!item.url) errores.push(`Al link ${i + 1} le falta la dirección.`);
    else if (!/^https?:\/\/\S+$/i.test(item.url)) errores.push(`El link ${i + 1} no es una dirección válida (tiene que empezar con https://).`);
  });
  if (entregables.length > LIMITES.links) {
    errores.push(`Se pueden cargar hasta ${LIMITES.links} links de entrega.`);
  }

  return { entregables: entregables.slice(0, LIMITES.links), errores };
}

/**
 * Los links de un producto tal como están en la base.
 *
 * Los productos de antes tienen solo `delivery_url`; los nuevos, la lista.
 */
export function linksDe(producto) {
  const { entregables } = normalizarEntregables(producto?.entregables);
  const validos = entregables.filter(e => /^https?:\/\//i.test(e.url));
  if (validos.length) return validos;
  const unico = texto(producto?.delivery_url);
  return unico ? [{ etiqueta: '', url: unico }] : [];
}

export default {
  LIMITES,
  VARIABLES,
  VARIABLES_POR_PASO,
  CLAVES_SEGUIMIENTO,
  renderizar,
  variablesDesconocidas,
  normalizarMensajes,
  normalizarBump,
  normalizarEntregables,
  linksDe
};
