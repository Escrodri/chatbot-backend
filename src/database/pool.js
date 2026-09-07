import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

/**
 * Pool de conexiones PostgreSQL configurado para alta concurrencia y resiliencia.
 */
export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,                       // Hasta 20 conexiones concurrentes para ráfagas de webhooks
  idleTimeoutMillis: 30000,      // Cierra clientes inactivos tras 30 segundos
  connectionTimeoutMillis: 5000, // Timeout de conexión de 5 segundos
});

pool.on('error', (err) => {
  console.error('❌ [DATABASE ERROR] Error imprevisto en cliente inactivo de PostgreSQL:', err.message);
});

/**
 * Ejecuta una consulta SQL parametrizada garantizando protección contra Inyección SQL.
 * 
 * @param {string} text Sentencia SQL con placeholders $1, $2, ...
 * @param {Array} params Parámetros a sustituir
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params = []) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  if (config.isDev && duration > 200) {
    console.warn(`⚠️ [SLOW QUERY] (${duration}ms) ${text.substring(0, 100)}...`);
  }

  return res;
}

export default { pool, query };
