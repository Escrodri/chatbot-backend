/**
 * Lo que se lee de una captura de comprobante, pasado a datos con los que se
 * puede decidir.
 *
 * Todo lo que hay acá es puro: recibe texto, devuelve valores, no toca la base
 * ni la red. Es a propósito. Son las funciones que deciden si se cobra o no, y
 * tienen que poder probarse una por una con cien casos raros sin levantar nada.
 */

/**
 * Un id de mensaje de NUESTRA base, o null.
 *
 * `Number(null)` es 0 y `Number.isInteger(0)` es true: un cero disfrazado de
 * entero válido llegaba hasta el UPDATE y rompía la clave foránea justo en el
 * momento de cobrar. El guion además a veces manda el id de Meta ("wamid.…"),
 * que no es un número nuestro.
 *
 * @param {*} valor
 * @returns {number|null}
 */
export function idDeMensaje(valor) {
  if (valor === null || valor === undefined) return null;

  const texto = String(valor).trim();
  if (!/^\d+$/.test(texto)) return null;

  const numero = Number(texto);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

/**
 * El monto de una captura, en guaraníes enteros.
 *
 * El modelo ahora copia el monto TAL CUAL está escrito —"Gs. 19.000,00",
 * "USD 5,00"— y la cuenta se hace acá. Antes se le pedía "solo dígitos", y eso
 * abría una trampa concreta: una transferencia de Gs. 190 que la app muestra
 * como "190,00" se convertía en "19000", o sea el precio exacto del material.
 * Transferir ciento noventa guaraníes alcanzaba para llevárselo.
 *
 * Reglas, en este orden:
 *   - Si dice otra moneda (dólares, reales, pesos, euros) y no dice guaraníes,
 *     se marca como OTRA y no se interpreta el número: 5 dólares no son 5
 *     guaraníes, y tampoco son 36.000 a un tipo de cambio que no sabemos.
 *   - Los guaraníes no tienen centavos. Un separador seguido de una o dos
 *     cifras al final es la parte decimal y se descarta: "19.000,00" es 19000,
 *     "190,00" es 190.
 *   - Un separador seguido de tres cifras es de miles: "19.000" y "19,000" son
 *     los dos 19000.
 *
 * @param {*} texto
 * @returns {{ monto: number|null, moneda: 'PYG'|'OTRA'|null, crudo: string }}
 */
export function leerMontoPYG(texto) {
  const crudo = String(texto ?? '').trim();
  if (!crudo) return { monto: null, moneda: null, crudo };

  const t = crudo.toUpperCase();
  const diceOtra = /(US\s*\$|U\$S|USD|\bUS\b|R\$|BRL|\bARS\b|EUR|€|DOLAR|DÓLAR|\bREAL(ES)?\b|PESOS?\b)/.test(t);
  const diceGuaranies = /(\bGS\b|GS\.|₲|PYG|GUARAN)/.test(t);

  if (diceOtra && !diceGuaranies) {
    return { monto: null, moneda: 'OTRA', crudo };
  }

  let numero = t.replace(/[^0-9.,]/g, '');
  // La parte decimal: un separador y una o dos cifras al final.
  numero = numero.replace(/[.,]\d{1,2}$/, '');
  const digitos = numero.replace(/[^0-9]/g, '');

  if (!digitos) return { monto: null, moneda: 'PYG', crudo };

  const monto = Number(digitos);
  if (!Number.isSafeInteger(monto) || monto <= 0) return { monto: null, moneda: 'PYG', crudo };

  return { monto, moneda: 'PYG', crudo };
}

/**
 * Una llave para el comprobante que no muestra número de operación.
 *
 * Fecha + hora + monto, porque son los tres datos que cualquier pantalla de
 * resumen muestra siempre. La misma captura reenviada da la misma huella; dos
 * pagos distintos solo chocarían en el mismo minuto por el mismo importe, y
 * ese caso cae en revisión humana.
 *
 * Forma exacta o nada. Una fecha son ocho dígitos y una hora son cuatro:
 * cualquier otra cosa no es un dato mal escrito, es una lectura que no se
 * entendió, y con eso no se arma una llave que después decide un cobro.
 *
 * El prefijo 9 evita que una huella coincida con un número de operación real.
 *
 * @param {{fecha: *, hora: *, monto: *}} datos
 * @returns {string} Vacío si no alcanza para armarla
 */
export function construirHuella({ fecha, hora, monto }) {
  const f = String(fecha || '').trim();
  const h = String(hora || '').trim();
  const m = String(monto || '').replace(/[^0-9]/g, '');

  if (!/^\d{8}$/.test(f) || !/^\d{4}$/.test(h) || !m || m === '0') return '';

  return `9${f}${h}${m}`;
}

/**
 * Cuántas horas hace que se hizo la transferencia, según la propia captura.
 *
 * Fecha ddmmaaaa y hora hhmm, en hora de Paraguay (UTC-3 todo el año desde
 * 2024). Devuelve null si no se pueden leer: un comprobante sin fecha legible
 * no es sospechoso, es uno mal leído. Negativo si la captura está en el futuro.
 *
 * @param {{fecha: *, hora: *}} datos
 * @param {number} [ahora] Para las pruebas
 * @returns {number|null}
 */
export function antiguedadEnHoras({ fecha, hora }, ahora = Date.now()) {
  const f = String(fecha || '').trim();
  const h = String(hora || '').trim();
  if (!/^\d{8}$/.test(f) || !/^\d{4}$/.test(h)) return null;

  const dia = Number(f.slice(0, 2));
  const mes = Number(f.slice(2, 4));
  const anio = Number(f.slice(4, 8));
  const hh = Number(h.slice(0, 2));
  const mm = Number(h.slice(2, 4));

  if (dia < 1 || dia > 31 || mes < 1 || mes > 12 || anio < 2000 || hh > 23 || mm > 59) {
    return null;
  }

  // Una fecha imposible —30 de febrero— Date.UTC la corre en silencio al 2 de
  // marzo. Se comprueba a mediodía, lejos de los bordes, que siga siendo el
  // mismo día que se leyó.
  const control = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== dia
  ) {
    return null;
  }

  return (ahora - Date.UTC(anio, mes - 1, dia, hh + 3, mm, 0)) / 3600000;
}

/**
 * Un nombre partido en palabras comparables: sin tildes, sin puntuación y en
 * minúsculas. Los bancos escriben el titular de cualquier manera, así que se
 * compara por palabras y no la cadena entera.
 *
 * @param {*} valor
 * @returns {string[]}
 */
export function normalizarNombre(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * ¿El titular leído es el nuestro?
 *
 * Tienen que coincidir DOS palabras —nombre y apellido—, no una. Con una sola
 * alcanzaba el apellido, y en Paraguay eso no identifica a nadie: cualquier
 * captura de una transferencia a cualquier Rodríguez del país pasaba. Si el
 * titular propio es una sola palabra (un comercio), se exige esa.
 *
 * @param {string} propio
 * @param {string} leido
 * @returns {boolean}
 */
export function coincideTitular(propio, leido) {
  const titularPropio = normalizarNombre(propio);
  const titularLeido = normalizarNombre(leido);
  if (!titularPropio.length || !titularLeido.length) return false;

  const propias = new Set(titularPropio.filter(p => p.length >= 3));
  if (!propias.size) return false;

  const compartidas = new Set(titularLeido.filter(p => p.length >= 3 && propias.has(p)));
  const exigidas = propias.size >= 2 ? 2 : 1;
  return compartidas.size >= exigidas;
}

/**
 * ¿La cuenta leída es una de las nuestras?
 *
 * Se compara por terminación porque cada banco recorta el número distinto:
 * hasta seis cifras, y nunca menos de cuatro. Con menos, cualquier cuenta
 * ajena que termine igual pasaría.
 *
 * @param {string[]} propios Identificadores propios, solo dígitos
 * @param {string} leida
 * @returns {boolean}
 */
export function coincideCuenta(propios, leida) {
  const cuenta = String(leida || '').replace(/[^0-9]/g, '');
  if (cuenta.length < 4) return false;

  return (propios || []).some(propio => {
    const p = String(propio || '').replace(/[^0-9]/g, '');
    if (p.length < 4) return false;
    const largo = Math.min(p.length, cuenta.length, 6);
    return p.slice(-largo) === cuenta.slice(-largo);
  });
}

/**
 * Guaraníes con puntos de miles, como los escribe cualquiera en Paraguay.
 *
 * @param {*} monto
 * @returns {string} "Gs. 19.000"
 */
export function formatoGs(monto) {
  const n = Math.round(Number(monto) || 0);
  return 'Gs. ' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * El nombre del destino tal como se le puede mostrar al cliente.
 *
 * Se le sacan los prefijos que agrega la app del banco ("Pago QR.",
 * "Transferencia a") para que el mensaje diga "figura a SAN ISIDRO MARKET" y
 * no "figura a PAGO QR. SAN ISIDRO MARKET".
 *
 * @param {*} nombre
 * @returns {string}
 */
export function nombreDestinoParaMostrar(nombre) {
  // Con límite de palabra en los dos lados. Sin él, "GIRON LOPEZ" perdía el
  // "GIRO" y quedaba "N LOPEZ", y "Pago Alvarez" perdía el "Al".
  return String(nombre || '')
    .replace(/^\s*(?:pago\s*qr|pago|transferencia|transf|env[ií]o|giro)\b\.?(?:\s+(?:a|al)\b|\s*:)?\s*/i, '')
    .replace(/^[.:\-\s]+/, '')
    .trim()
    .slice(0, 40);
}
