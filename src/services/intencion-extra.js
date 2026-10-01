/**
 * Qué versión eligió la persona cuando el producto tiene un extra.
 *
 * Con un extra cargado, el producto se vende en dos versiones: solo el
 * producto, o el producto más el extra. La gente casi nunca toca el botón:
 * escribe "el de 35", "quiero el plus", "solo el plan", "sin el extra". Antes
 * el guion entendía solo "sí" y "no", y todo lo demás iba a la IA. La IA no
 * puede sumar el extra al pedido, así que contestaba con el precio
 * equivocado o decía que esa versión no existía.
 *
 * Este archivo no habla con la base: recibe el texto y los precios, y dice
 * qué eligió la persona. Si no está claro, devuelve null y la charla sigue
 * con la IA, que puede preguntar. Es mejor preguntar que cobrar de más.
 *
 * Resultados:
 *   extra_si  eligió la versión con el extra
 *   extra_no  eligió la versión sin el extra
 *   comprar   nombró el precio del producto solo, antes de que se le
 *             ofreciera el extra: quiere comprar y el paso normal se lo ofrece
 *   null      no eligió nada, o no está claro
 */

/** Más de esto ya no es una elección: es una historia, y la lee la IA. */
const MAX_PALABRAS = 12;

/** La oferta del extra que sigue fresca para un "sí" o un "no" a secas. */
export const VENTANA_RESPUESTA_MS = 30 * 60 * 1000;

const UNIDADES = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const ESPECIALES = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  cien: 100
};
const DECENAS = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };

/** Lo que va después de un número y dice que no es plata: "21 días", "3 packs". */
const UNIDAD_NO_PLATA = /^(dias?|semanas?|mes(es)?|kg|kilos?|kilogramos?|gr|gramos?|anos?|hs|horas?|min|minutos?|packs?|opciones|recetas?|comidas?|cenas?|platos?|menus?|porciones|personas?|hijos?|veces|x|libros?|paginas?|laminas?|historias?|infusiones|herramientas)$/;

/** Las palabras con las que empieza una pregunta. */
const PREGUNTA = /^(que|cual|cuales|como|cuanto|cuanta|cuantos|cuantas|cuando|donde|por que|porque|para que|trae|traen|tiene|tienen|incluye|incluyen|sirve|sirven|funciona|vale|valen|hay|puedo|se puede|podes|me podes|me explicas|explicame|diferencia|en que|y que|y cual|y el|y la|y si)\b/;

/** Respuestas a una oferta que no hablan del extra sino de no comprar nada. */
const NO_COMPRA = /\b(nada|ninguno|ninguna|ya no|despues|luego|mas adelante|otro dia|manana|lo pienso|lo voy a pensar|pensarlo|pensar|no me alcanza|no tengo plata|no puedo|cancel)/;

const YA_PAGO = /\b(transferi|transferido|pague|pagado|pago hecho|deposite|depositado|gire|girado|comprobante|captura|ya te pase|ya pase|ya envie|ya mande)\b/;

const SI_SOLO = /^(si+|sii+|si si|si quiero|si dale|dale si|si por favor|si porfa|si gracias|quiero|lo quiero|la quiero|quiero ese|obvio|claro|claro que si|de una|me interesa|si me interesa|sumalo|sumala|agregalo|agregala|si sumalo|si agregalo|sumame|agregame|si sumame|si agregame)$/;
const NO_SOLO = /^(no+|nop|nope|no gracias|no muchas gracias|no por ahora|por ahora no|mejor no|asi nomas|asi esta bien|asi nomas esta bien|solo eso|nomas eso|eso nomas|no hace falta|no necesito|no lo necesito|no quiero|no quiero el extra)$/;

/**
 * Palabras que eligen la versión con el extra aunque todavía no se haya
 * ofrecido: quien las usa ya sabe que hay dos versiones (lo vio en el anuncio
 * o en la presentación).
 */
const FUERTES_SI = [
  'plus', 'premium', 'vip',
  'con el extra', 'con extra', 'con los extras', 'con el adicional',
  'el mas completo', 'la mas completa', 'la version completa'
];
const FUERTES_NO = [
  'sin el extra', 'sin extra', 'sin los extras', 'sin el adicional', 'sin adicional'
];

/** Las que valen solo como respuesta a la oferta: antes, "con todo" o "solo eso" pueden ser cualquier cosa. */
const DESPUES_SI = [
  'con todo', 'todo junto', 'los dos', 'las dos', 'ambos', 'ambas',
  'con el pack', 'con los packs', 'el grande', 'el mas grande', 'el mas caro',
  'sumalo', 'sumala', 'sumame', 'sumale', 'agregalo', 'agregala', 'agregame', 'agregale', 'incluilo', 'incluime'
];
const DESPUES_NO = [
  'sin el pack', 'sin los packs',
  'basico', 'basica', 'el normal', 'la normal', 'el simple', 'la simple', 'el comun', 'el sencillo',
  'el mas barato', 'la mas barata', 'el economico', 'la economica'
];

/** "Solo eso", "así nomás": valen cuando son toda la frase, no metidas en otra ("quiero saber solo eso"). */
const CORTAS_NO = ['solo ese', 'solo eso', 'nomas ese', 'nomas eso', 'eso nomas', 'asi nomas', 'asi esta bien', 'asi nomas esta bien', 'asi nomas gracias'];

/** Lo que va después de "solo el …" y dice "lo principal, sin el extra". */
const PRINCIPAL = ['principal', 'producto', 'basico', 'normal', 'plan', 'libro', 'material', 'pdf'];

/** Palabras que están en el nombre de casi cualquier extra y no lo distinguen. */
const NO_DISTINGUEN = new Set([
  'modo', 'sos', 'para', 'con', 'sin', 'del', 'las', 'los', 'una', 'uno', 'mas', 'extra', 'extras', 'pack', 'packs',
  'bonus', 'regalo', 'guia', 'pdf', 'plan', 'dias', 'dia', 'libro', 'material', 'version', 'completo', 'completa',
  'todo', 'todos', 'nuevo', 'nueva', 'opciones', 'recetas', 'que', 'por', 'super'
]);

export function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Las palabras del texto, con "|" donde había una coma, un punto o un signo.
 *
 * La coma importa: "no, el de 35" es corregir ("no, te dije el de 35") y
 * "no quiero el de 35" es rechazarlo. Los puntos de miles se juntan antes:
 * "35.000" es una sola palabra.
 */
export function palabrasDe(texto) {
  const limpio = String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1')
    .replace(/[,.;:!?¿¡\n]+/g, ' | ')
    .replace(/[^a-z0-9| ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const salida = [];
  for (const w of limpio.split(' ')) {
    if (!w) continue;
    if (w === '|' && (salida.length === 0 || salida[salida.length - 1] === '|')) continue;
    salida.push(w);
  }
  while (salida[salida.length - 1] === '|') salida.pop();
  return salida;
}

/** "treinta y cinco" → 35, "veinticinco" → 25. Lee desde la posición i; devuelve [valor, cuántas palabras usó]. */
function numeroEnLetras(palabras, i) {
  const w = palabras[i];
  if (ESPECIALES[w] !== undefined) return [ESPECIALES[w], 1];
  if (DECENAS[w] !== undefined) {
    if (palabras[i + 1] === 'y' && UNIDADES[palabras[i + 2]] !== undefined) {
      return [DECENAS[w] + UNIDADES[palabras[i + 2]], 3];
    }
    return [DECENAS[w], 1];
  }
  if (UNIDADES[w] !== undefined) return [UNIDADES[w], 1];
  return null;
}

/**
 * Los montos de plata que nombra un texto.
 *
 * En Paraguay "el de 35" es 35.000: un número suelto de menos de mil se lee
 * en miles. Se descartan los números que no son plata: los que van con una
 * unidad ("21 días", "3 packs") y los que están en el nombre del producto
 * ("Plan 21"), salvo que digan "mil" o vengan con puntos.
 *
 * @param {string} texto
 * @param {{ moneda?: string, ignorar?: number[] }} [opciones]
 * @returns {{ monto:number, posicion:number }[]}
 */
export function montosDelTexto(texto, { moneda = 'PYG', ignorar = [] } = {}) {
  const palabras = palabrasDe(texto);
  const enMiles = moneda === 'PYG';
  const salida = [];

  for (let i = 0; i < palabras.length; i++) {
    const w = palabras[i];
    if (w === '|') continue;
    let base = null;
    let usadas = 1;
    let explicito = false;

    const pegado = w.match(/^(\d+)(mil|k)$/);
    if (pegado) {
      base = Number(pegado[1]) * 1000;
      explicito = true;
    } else if (/^\d+$/.test(w)) {
      if (w.length > 7) continue; // un teléfono o un número de operación
      base = Number(w);
      if (palabras[i + 1] === 'mil' || palabras[i + 1] === 'k') {
        base *= 1000;
        usadas = 2;
        explicito = true;
      } else if (base >= 1000) {
        explicito = true;
      }
    } else {
      const letras = numeroEnLetras(palabras, i);
      // En letras solo cuenta con "mil": "los dos" o "una" no son plata.
      if (letras && palabras[i + letras[1]] === 'mil') {
        base = letras[0] * 1000;
        usadas = letras[1] + 1;
        explicito = true;
      }
    }

    if (base === null) continue;

    const siguiente = palabras[i + usadas] || '';
    if (!explicito) {
      if (UNIDAD_NO_PLATA.test(siguiente)) continue;
      if (palabras[i - 1] === 'plan' || palabras[i - 1] === 'los' || palabras[i - 1] === 'las') continue;
      if (ignorar.includes(base)) continue;
      if (enMiles && base > 0 && base < 1000) base *= 1000;
    }

    if (base > 0) salida.push({ monto: base, posicion: i });
    i += usadas - 1;
  }
  return salida;
}

/** Las palabras del nombre del extra que no están en el del producto: "plus", "asado", "dulce". */
export function palabrasDelExtra({ nombreProducto = '', nombreExtra = '', botonSi = '' } = {}) {
  const delProducto = new Set(normalizar(nombreProducto).split(' '));
  const candidatas = `${normalizar(nombreExtra)} ${normalizar(botonSi)}`.split(' ');
  return [...new Set(candidatas.filter(w =>
    w.length >= 4 && !/^\d+$/.test(w) && !delProducto.has(w) && !NO_DISTINGUEN.has(w) &&
    !['quiero', 'sumar', 'sumalo', 'agregar', 'agregalo', 'gracias'].includes(w)
  ))];
}

function contiene(t, frase) {
  return ` ${t} `.includes(` ${frase} `);
}

/**
 * ¿Hay un "no" o un "sin" justo antes (hasta 3 palabras) de la posición, en
 * la misma frase? Una coma corta: en "no, el de 35" el "no" es otra cosa.
 */
export function negadoAntes(palabras, posicion) {
  for (let k = posicion - 1; k >= Math.max(0, posicion - 3); k--) {
    if (palabras[k] === '|') return false;
    if (['no', 'ni', 'sin', 'tampoco'].includes(palabras[k])) return true;
  }
  return false;
}

/** Lo que se dice al principio y no cambia el sentido: "hola, …", "bueno, …". */
const ARRANQUE = /^((hola|holaa+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|bueno|ok|dale|perfecto|gracias|mira|che|entonces|ah|ahh|aja) )+/;

/** Posiciones (en palabras) donde empieza cada aparición de una frase. */
function posiciones(palabras, frase) {
  const f = frase.split(' ');
  const salida = [];
  for (let i = 0; i + f.length <= palabras.length; i++) {
    if (f.every((w, j) => palabras[i + j] === w)) salida.push(i);
  }
  return salida;
}

/**
 * ¿El texto es corto y afirma algo, o es una pregunta, una historia o un "no
 * puedo"? Solo lo primero puede elegir una versión o un producto sin la IA.
 *
 * @returns {boolean}
 */
export function pareceEleccion(texto, { maxPalabras = MAX_PALABRAS } = {}) {
  const bruto = String(texto || '').trim();
  const palabras = palabrasDe(bruto);
  const t = palabras.filter(w => w !== '|').join(' ');
  if (!t || t.split(' ').length > maxPalabras) return false;
  if (bruto.includes('?') || bruto.includes('¿')) return false;
  if (palabras.join(' ').split(' | ').some(frase => PREGUNTA.test(frase.replace(ARRANQUE, '')))) return false;
  if (NO_COMPRA.test(t) || YA_PAGO.test(t)) return false;
  return true;
}

/**
 * Qué eligió la persona.
 *
 * @param {string} texto Lo que escribió
 * @param {object} c
 * @param {number} c.precio          Su precio del producto (lista, campaña o recuperación)
 * @param {number} [c.lista]         El precio de lista, por si nombra ese
 * @param {number} c.precioExtra     Lo que cuesta sumar el extra
 * @param {string} [c.moneda]
 * @param {string} [c.nombreProducto]
 * @param {string} [c.nombreExtra]
 * @param {string} [c.botonSi]       El texto del botón para sumar el extra
 * @param {string|null} [c.bumpEstado]  null, 'ofrecido', 'aceptado' o 'rechazado'
 * @param {boolean} [c.ofrecidoReciente] Si la oferta salió hace poco (para un "sí" o "no" a secas)
 * @returns {{ intencion: 'extra_si'|'extra_no'|'comprar'|null, motivo: string }}
 */
export function intencionExtra(texto, c = {}) {
  const nada = (motivo) => ({ intencion: null, motivo });
  const bruto = String(texto || '').trim();
  const palabras = palabrasDe(bruto);
  const t = palabras.filter(w => w !== '|').join(' ');
  const conCortes = palabras.join(' ');
  if (!t) return nada('vacio');

  const precio = Number(c.precio) || 0;
  const precioExtra = Number(c.precioExtra) || 0;
  if (!precio || !precioExtra) return nada('sin_precios');

  if (t.split(' ').length > MAX_PALABRAS) return nada('largo');
  if (bruto.includes('?') || bruto.includes('¿')) return nada('pregunta');
  if (conCortes.split(' | ').some(frase => PREGUNTA.test(frase.replace(ARRANQUE, '')))) return nada('pregunta');

  // "no el de 35", "no el plus" sin coma: puede ser "no, te dije el de 35" o
  // "no quiero el de 35". No se adivina: la IA ve la charla y pregunta.
  for (let i = 0; i + 1 < palabras.length; i++) {
    if (palabras[i] === 'no' && ['el', 'la', 'ese', 'esa', 'los', 'las', 'de'].includes(palabras[i + 1])) {
      return nada('no_ambiguo');
    }
  }

  const ofrecido = c.bumpEstado === 'ofrecido' || c.bumpEstado === 'aceptado' || c.bumpEstado === 'rechazado';

  // 1. "Sí" o "no" a secas: solo si la oferta está fresca. Un "sí" de mañana
  //    puede ser la respuesta a cualquier otra cosa.
  if (c.ofrecidoReciente && c.bumpEstado === 'ofrecido') {
    if (SI_SOLO.test(t)) return { intencion: 'extra_si', motivo: 'si' };
    if (NO_SOLO.test(t)) return { intencion: 'extra_no', motivo: 'no' };
  }

  if (NO_COMPRA.test(t)) return nada('no_compra');
  // "te transferí 35", "ya pagué": habla de un pago, no elige. Eso lo ve la revisión del comprobante.
  if (YA_PAGO.test(t)) return nada('habla_de_pago');

  let votosSi = 0;
  let votosNo = 0;
  let porPrecioSolo = false;
  const motivos = [];

  // 2. Precios. "el de 35" es el total con el extra; "el de 25", sin.
  const lista = Number(c.lista) || precio;
  const conExtra = new Set([precio + precioExtra, lista + precioExtra]);
  const sinExtra = new Set([precio, lista]);
  const ignorar = [...`${c.nombreProducto || ''} ${c.nombreExtra || ''}`.matchAll(/\d+/g)].map(m => Number(m[0]));
  const montos = montosDelTexto(bruto, { moneda: c.moneda || 'PYG', ignorar });

  for (const { monto, posicion } of montos) {
    const negado = negadoAntes(palabras, posicion);
    if (conExtra.has(monto) && !sinExtra.has(monto)) {
      if (negado) { votosNo++; motivos.push('precio_con_extra_negado'); } else { votosSi++; motivos.push('precio_con_extra'); }
    } else if (sinExtra.has(monto) && !conExtra.has(monto)) {
      // "no tengo 25" no es elegir el de 25: es que no le alcanza. Eso lo ve la IA.
      if (negado) return nada('precio_negado');
      votosNo++;
      porPrecioSolo = true;
      motivos.push('precio_sin_extra');
    } else if (monto === precioExtra) {
      // "sumame el de 10": solo con una palabra que diga sumar.
      if (/\b(suma|sumal|sumam|agreg|mas|tambien|extra|plus|adicional)/.test(t) && !negado) {
        votosSi++;
        motivos.push('precio_extra');
      }
    } else {
      // Nombró un precio que no es de ninguna versión: que lo vea la IA.
      return nada('precio_desconocido');
    }
  }

  // 3. Palabras. Antes de la oferta valen solo las que muestran que ya sabe
  //    que hay dos versiones; después, también las respuestas comunes.
  const delExtra = ofrecido ? palabrasDelExtra(c) : [];
  const frasesSi = [...new Set([...FUERTES_SI, ...(ofrecido ? DESPUES_SI : []), ...delExtra])];
  const sueltas = delExtra.filter(w => !FUERTES_SI.includes(w) && !DESPUES_SI.includes(w));
  const frasesNo = [...FUERTES_NO, ...(ofrecido ? DESPUES_NO : [])];
  const SOLO = ['solo', 'nomas', 'solamente', 'unicamente'];

  for (const frase of frasesSi) {
    const largo = frase.split(' ').length;
    for (const pos of posiciones(palabras, frase)) {
      const negada = negadoAntes(palabras, pos) || palabras[pos + largo] === 'no';
      if (!negada) {
        votosSi++;
        motivos.push(frase);
      } else if (!sueltas.includes(frase)) {
        // "no quiero el plus", "el plus no". Una palabra suelta del nombre del
        // extra negada ("no como dulce") no dice nada de la oferta: no cuenta.
        votosNo++;
        motivos.push(`no_${frase}`);
      }
    }
  }

  for (const frase of frasesNo) {
    if (!contiene(conCortes, frase)) continue;
    votosNo++;
    motivos.push(frase);
  }
  if (ofrecido) {
    const frases = conCortes.split(' | ').map(f => f.replace(ARRANQUE, '').replace(/ (gracias|por favor|porfa)$/, '').trim());
    const corta = frases.find(f => CORTAS_NO.includes(f));
    if (corta) {
      votosNo++;
      motivos.push(corta);
    }
  }

  // "solo el plan", "nomas la biblia", "solamente el principal". No cuenta si
  // lo que sigue es el extra: "solo el plus" es querer el plus.
  const delProducto = new Set(palabrasDe(c.nombreProducto).filter(w => w.length >= 3 && !/^\d+$/.test(w)));
  for (let i = 0; i + 2 < palabras.length; i++) {
    if (!SOLO.includes(palabras[i]) || !['el', 'la', 'ese', 'esa'].includes(palabras[i + 1])) continue;
    const sigue = palabras[i + 2];
    if (frasesSi.includes(sigue) || FUERTES_SI.includes(sigue)) continue;
    if (PRINCIPAL.includes(sigue) || delProducto.has(sigue)) {
      votosNo++;
      motivos.push(`solo_${sigue}`);
    }
  }

  if (votosSi && votosNo) return nada('contradice');
  if (votosSi) return { intencion: 'extra_si', motivo: motivos.join(',') };
  if (votosNo) {
    // Nombró el precio del producto solo antes de ver la oferta: quiere comprar.
    // El paso de comprar le ofrece el extra una vez, como a todos.
    if (!ofrecido && porPrecioSolo && motivos.every(m => m === 'precio_sin_extra')) {
      return { intencion: 'comprar', motivo: 'precio_sin_extra' };
    }
    return { intencion: 'extra_no', motivo: motivos.join(',') };
  }
  return nada('sin_eleccion');
}

export default { intencionExtra, pareceEleccion, montosDelTexto, palabrasDelExtra, palabrasDe, normalizar, negadoAntes, VENTANA_RESPUESTA_MS };
