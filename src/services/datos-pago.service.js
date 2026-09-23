import { settingRepository } from '../repositories/setting.repository.js';

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
