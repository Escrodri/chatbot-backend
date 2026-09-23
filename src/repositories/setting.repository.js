import { query } from '../database/index.js';

/**
 * Ajustes que se cambian en caliente, desde el tablero.
 *
 * Hasta ahora todo lo que decidía el comportamiento del sistema vivía en
 * variables de entorno, y eso está bien para lo que se define una vez: los
 * tokens de Meta, la cuenta bancaria, el horario nocturno. Pero hay decisiones
 * que se toman en el momento y por un rato —"salgo dos horas, que apruebe
 * solo"—, y para esas el entorno es el lugar equivocado: cambiar una variable
 * en Render reinicia el servicio, corta las conversaciones abiertas y tarda
 * varios minutos. Nadie hace eso antes de salir; lo que hace es no salir, o
 * salir y dejar a la gente esperando.
 *
 * Una tabla de clave y valor, entonces. Dos columnas y sin esquema: cada
 * ajuste se valida donde se usa, que es el único lugar que sabe qué significa.
 */

/**
 * Caché en memoria.
 *
 * La revisión de comprobantes consulta el ajuste en cada comprobante que
 * llega, y una consulta a Postgres por cada foto es gratis hasta que no lo es.
 * Quince segundos es suficientemente corto para que apagar la aprobación
 * automática se sienta inmediato, y suficientemente largo para que una ráfaga
 * de comprobantes no golpee la base una vez por cada uno.
 */
const CACHE_MS = 15 * 1000;
const cache = new Map();

export const settingRepository = {
  /** Vacía la caché. Se llama sola al guardar; existe aparte para las pruebas. */
  limpiarCache(clave = null) {
    if (clave) cache.delete(clave);
    else cache.clear();
  },

  /**
   * Lee un ajuste. Devuelve `porDefecto` si la clave no está guardada, y
   * LANZA si la base falla.
   *
   * Esa diferencia importa y antes no existía: los dos casos devolvían el
   * valor por defecto, así que una tabla que no se creó o una conexión caída
   * se veían igual que "nadie lo configuró". En la aprobación automática eso
   * significaba que un administrador que la había APAGADO seguía viéndola
   * apagada en su cabeza mientras el sistema, con un aviso en consola, volvía
   * al modo por defecto y entregaba solo de madrugada.
   *
   * Quien llama decide qué hacer con la falla. Para un ajuste que decide si se
   * regala material sin que nadie mire, lo seguro no es "seguí como siempre".
   *
   * @param {string} clave
   * @param {*} porDefecto Se usa solo cuando la clave no existe
   * @throws Si la consulta falla
   */
  async leer(clave, porDefecto = null) {
    const guardado = cache.get(clave);
    if (guardado && guardado.hasta > Date.now()) return guardado.valor;

    const { rows } = await query(
      'SELECT valor FROM ajustes WHERE clave = $1 LIMIT 1',
      [clave]
    );

    const valor = rows[0] ? rows[0].valor : porDefecto;
    cache.set(clave, { valor, hasta: Date.now() + CACHE_MS });
    return valor;
  },

  /**
   * Guarda un ajuste y limpia la caché al instante.
   *
   * @param {string} clave
   * @param {*} valor Se guarda como JSONB
   * @param {number|null} userId Quién lo cambió
   */
  async guardar(clave, valor, userId = null) {
    const { rows } = await query(
      `INSERT INTO ajustes (clave, valor, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (clave) DO UPDATE
         SET valor = EXCLUDED.valor,
             updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP
       RETURNING clave, valor, updated_at, updated_by`,
      [clave, JSON.stringify(valor), userId]
    );

    cache.delete(clave);
    return rows[0] || null;
  }
};

export default settingRepository;
