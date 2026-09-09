import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

/**
 * Pool de conexiones PostgreSQL configurado para alta concurrencia y resiliencia.
 */
/**
 * Decide si la conexión debe usar TLS.
 *
 * Las bases administradas (Render, Railway, Neon, Supabase) exigen SSL y presentan
 * certificados que Node no reconoce sin el CA de cada proveedor, de ahí
 * rejectUnauthorized: false. En local, contra el Postgres de Docker, no se usa SSL.
 *
 * Se puede forzar con DATABASE_SSL=true / DATABASE_SSL=false.
 */
function resolveSsl() {
  const forzado = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (forzado === 'false' || forzado === '0') return false;
  if (forzado === 'true' || forzado === '1') return { rejectUnauthorized: false };

  const url = config.database.url || '';
  const esLocal = /@(localhost|127\.0\.0\.1|\[::1\]|postgres|db)(:|\/)/.test(url);

  return esLocal ? false : { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: resolveSsl(),
  max: 20,                       // Hasta 20 conexiones concurrentes para ráfagas de webhooks
  idleTimeoutMillis: 30000,      // Cierra clientes inactivos tras 30 segundos
  connectionTimeoutMillis: 10000, // 10 s: las bases administradas tardan más en aceptar
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
