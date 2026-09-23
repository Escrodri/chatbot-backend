import { settingRepository } from '../repositories/setting.repository.js';
import { query } from '../database/index.js';

/**
 * La cuenta que recibe las transferencias.
 *
 * Estos cuatro datos —cuenta, alias, documento y titular— son contra lo que se
 * contrasta cada comprobante antes de entregar sin que nadie mire. Vivían solo
 * en variables de entorno del servidor, y eso tenía dos problemas que costaron
 * una tarde entera:
 *
 * El primero es que el guion de n8n tiene sus PROPIAS variables con los mismos
 * datos, porque es quien se los escribe al cliente. Estaban cargadas ahí y no
 * acá, así que el bot mandaba el alias correcto y después el backend rechazaba
 * el comprobante diciendo que no tenía ninguna cuenta configurada. Dos copias
 * del mismo dato, una cargada y la otra no, y nada que lo dijera hasta que un
 * cliente pagó.
 *
 * El segundo es que cambiar una variable de entorno reinicia el servicio. Un
 * dato que puede cambiar —te mudás de banco, cambiás el alias— no debería
 * exigir un despliegue.
 *
 * Así que ahora se cargan desde el panel y se guardan en la base. Las
 * variables de entorno siguen valiendo como respaldo, para no romper lo que ya
 * estaba andando: si en la base no hay nada, se usa lo que diga el entorno.
 */

export const CLAVE = 'datos_pago';

const CAMPOS = Object.freeze(['cuenta', 'alias', 'documento', 'titular', 'banco']);

/** Lee del entorno, que es el respaldo cuando en la base no hay nada. */
function desdeEntorno() {
  return {
    cuenta: (process.env.PAGO_CUENTA || '').trim(),
    alias: (process.env.PAGO_ALIAS || '').trim(),
    documento: (process.env.PAGO_DOCUMENTO || '').trim(),
    titular: (process.env.PAGO_TITULAR || '').trim(),
    banco: (process.env.PAGO_BANCO || '').trim()
  };
}

function normalizar(valor) {
  const base = { cuenta: '', alias: '', documento: '', titular: '', banco: '' };
  if (!valor || typeof valor !== 'object') return base;

  for (const campo of CAMPOS) {
    base[campo] = typeof valor[campo] === 'string' ? valor[campo].trim().slice(0, 120) : '';
  }
  return base;
}

/** ¿Alcanza para contrastar un comprobante? */
function sirve(datos) {
  const conDigitos = [datos.cuenta, datos.alias, datos.documento]
    .some(v => String(v || '').replace(/[^0-9]/g, '').length >= 4);
  return conDigitos || String(datos.titular || '').trim().length >= 4;
}

export const datosPagoService = {
  CLAVE,
  CAMPOS,

  /**
   * Los datos vigentes, mirando primero la base y después el entorno.
   *
   * Nunca lanza: un fallo de base cae al entorno, y si tampoco hay nada
   * devuelve todo vacío. Quien decide entregar comprueba `configurado` y
   * rechaza, que es la dirección segura.
   *
   * @returns {Promise<{cuenta:string, alias:string, documento:string, titular:string, banco:string, origen:string, configurado:boolean}>}
   */
  async leer() {
    let guardado = null;
    try {
      guardado = await settingRepository.leer(CLAVE, null);
    } catch (err) {
      console.warn('⚠️ [DATOS DE PAGO] No se pudo leer de la base:', err.message);
    }

    const deBase = normalizar(guardado);
    if (sirve(deBase)) return { ...deBase, origen: 'panel', configurado: true };

    const deEntorno = desdeEntorno();
    return {
      ...deEntorno,
      origen: sirve(deEntorno) ? 'entorno' : 'ninguno',
      configurado: sirve(deEntorno)
    };
  },

  /**
   * Los datos sacados del mensaje que el bot ya le mandó a esta persona.
   *
   * Es el último recurso, y resultó ser el mejor de todos: si nadie cargó la
   * cuenta en ningún lado, se lee del bloque de datos bancarios que el propio
   * sistema le escribió a este cliente en este mismo chat. La pregunta que
   * termina contestando es exactamente la correcta: ¿transfirió a donde le
   * dijimos que transfiera?
   *
   * No lo manda el guion en la petición: se lee de nuestra base, de un mensaje
   * que salió de nuestro servidor. Un flujo mal armado no puede inventarlo.
   *
   * Existe porque la cuenta estaba cargada en las variables del guion y no en
   * las del backend, y esa diferencia —invisible, en dos lugares distintos—
   * hizo que se rechazara un pago real. Con esto, el sistema deja de depender
   * de que alguien se acuerde de cargar el mismo dato dos veces.
   *
   * @param {number} conversationId
   * @returns {Promise<object|null>}
   */
  async leerDelChat(conversationId) {
    if (!conversationId) return null;

    let filas = [];
    try {
      const { rows } = await query(
        `SELECT text FROM messages
          WHERE conversation_id = $1
            AND direction = 'outbound'
            AND text ILIKE '%titular%'
          ORDER BY id DESC
          LIMIT 5`,
        [conversationId]
      );
      filas = rows;
    } catch (err) {
      console.warn('⚠️ [DATOS DE PAGO] No se pudo leer el chat:', err.message);
      return null;
    }

    for (const { text } of filas) {
      const texto = String(text || '');

      // Se buscan por etiqueta y no cualquier número suelto: el mismo mensaje
      // trae el monto, y tomarlo por una cuenta sería aceptar como válido un
      // comprobante cuyo destino coincida con el importe.
      const tras = (etiqueta) => {
        const m = texto.match(new RegExp(etiqueta + '[^0-9]{0,40}([0-9][0-9.\\-\\s]{3,})', 'i'));
        return m ? m[1].replace(/[^0-9]/g, '') : '';
      };

      const titular = (texto.match(/titular:?\**\s*\**\s*([^\n*]{3,60})/i) || [])[1] || '';

      const datos = normalizar({
        alias: tras('alias'),
        cuenta: tras('cuenta completa') || tras('cuenta'),
        documento: tras('documento'),
        titular: titular.trim(),
        banco: (texto.match(/banco:?\**\s*\**\s*([^\n*]{2,40})/i) || [])[1]?.trim() || ''
      });

      if (sirve(datos)) return { ...datos, origen: 'chat', configurado: true };
    }

    return null;
  },

  /**
   * Guarda los datos cargados desde el panel.
   *
   * @param {object} valores
   * @param {number|null} userId
   */
  async guardar(valores, userId = null) {
    const datos = normalizar(valores);

    if (!sirve(datos)) {
      const err = new Error(
        'Hace falta al menos la cuenta, el alias o el documento con cuatro dígitos, o el nombre del titular.'
      );
      err.code = 'ERR_DATOS_PAGO_INCOMPLETOS';
      throw err;
    }

    await settingRepository.guardar(CLAVE, datos, userId);
    return this.leer();
  },

  /**
   * Los identificadores numéricos propios, para contrastar contra el
   * comprobante. Solo los que tienen cuatro dígitos o más: con menos, cualquier
   * cuenta ajena que termine en esa cifra pasaría.
   *
   * @param {object} datos Lo que devolvió `leer()`
   * @returns {string[]}
   */
  identificadores(datos) {
    return [datos.cuenta, datos.alias, datos.documento]
      .map(v => String(v || '').replace(/[^0-9]/g, ''))
      .filter(v => v.length >= 4);
  }
};

export default datosPagoService;
