import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Inicializa la base de datos PostgreSQL:
 * 1. Ejecuta el DDL de schema.sql para crear tablas e índices.
 * 2. Siembra el usuario administrador por defecto si la base de datos está vacía.
 */
export async function initDatabase() {
  console.log('🔄 [DATABASE] Verificando conexión e inicializando esquema PostgreSQL...');

  const client = await pool.connect();
  try {
    // 1. Cargar y ejecutar DDL
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    await client.query(schemaSql);
    console.log('✅ [DATABASE] Esquema e índices de PostgreSQL 16 verificados.');

    // 2. Verificar y sembrar administrador inicial
    const { rows: users } = await client.query('SELECT id FROM users LIMIT 1');
    if (users.length === 0) {
      console.log('🌱 [DATABASE] Sembrando usuario administrador inicial...');

      const adminEmail = (process.env.ADMIN_EMAIL || 'admin@empresa.com').toLowerCase().trim();

      // La contraseña NUNCA se escribe en el código. Sale de ADMIN_PASSWORD y, si no
      // está definida, se genera una aleatoria que se muestra una sola vez en consola.
      const envPassword = (process.env.ADMIN_PASSWORD || '').trim();
      const generated = !envPassword;
      const initialPassword = envPassword || crypto.randomBytes(12).toString('base64url');

      if (envPassword && envPassword.length < 12) {
        console.warn('⚠️  [DATABASE] ADMIN_PASSWORD tiene menos de 12 caracteres. Usá una más larga.');
      }

      const passwordHash = await bcrypt.hash(initialPassword, 12);

      await client.query(
        `INSERT INTO users (email, password_hash, name, role, is_active)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminEmail, passwordHash, 'Administrador del Sistema', 'admin', true]
      );

      if (generated) {
        console.log('');
        console.log('┌───────────────────────────────────────────────────────────────┐');
        console.log('│  ADMINISTRADOR CREADO — anotá esta contraseña ahora.          │');
        console.log('│  No se vuelve a mostrar y no queda guardada en ningún lado.   │');
        console.log('└───────────────────────────────────────────────────────────────┘');
        console.log(`   Usuario:     ${adminEmail}`);
        console.log(`   Contraseña:  ${initialPassword}`);
        console.log('');
        console.log('   Para cambiarla más adelante:  npm run set-admin-password');
        console.log('');
      } else {
        console.log(`✅ [DATABASE] Administrador sembrado: ${adminEmail} (contraseña tomada de ADMIN_PASSWORD).`);
      }
    }
  } catch (error) {
    console.error('❌ [DATABASE ERROR] Error al inicializar esquema PostgreSQL:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

export default { initDatabase };
