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
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE');
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE');
    try {
      await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
      await client.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('superadmin', 'admin', 'agent'))");
    } catch (cErr) {
      // Ignorar si la BD no permite drop de constraint
    }

    // 2. Sembrar equipo principal por defecto si no existe ninguno
    const { rows: existingTeams } = await client.query('SELECT id FROM teams ORDER BY id ASC LIMIT 1');
    let defaultTeamId = existingTeams.length > 0 ? existingTeams[0].id : null;

    if (!defaultTeamId) {
      const { rows: createdTeam } = await client.query(
        "INSERT INTO teams (name) VALUES ('Equipo Principal') RETURNING id"
      );
      defaultTeamId = createdTeam[0].id;
      console.log(`🌱 [DATABASE] Equipo principal por defecto creado (#${defaultTeamId}).`);
    }

    // 3. Vincular usuarios y canales huérfanos al equipo por defecto
    await client.query('UPDATE users SET team_id = $1 WHERE team_id IS NULL', [defaultTeamId]);
    await client.query('UPDATE channels SET team_id = $1 WHERE team_id IS NULL', [defaultTeamId]);

    // Promover el primer usuario del sistema a superadmin si es admin
    await client.query(
      "UPDATE users SET role = 'superadmin' WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1) AND role = 'admin'"
    );

    console.log('✅ [DATABASE] Esquema e índices de PostgreSQL 16 verificados.');

    // 4. Verificar y sembrar administrador inicial
    const { rows: users } = await client.query('SELECT id FROM users LIMIT 1');
    if (users.length === 0) {
      console.log('🌱 [DATABASE] Sembrando usuario superadministrador inicial...');

      const adminEmail = (process.env.ADMIN_EMAIL || 'admin@empresa.com').toLowerCase().trim();

      const envPassword = (process.env.ADMIN_PASSWORD || '').trim();
      const generated = !envPassword;
      const initialPassword = envPassword || crypto.randomBytes(12).toString('base64url');

      if (envPassword && envPassword.length < 12) {
        console.warn('⚠️  [DATABASE] ADMIN_PASSWORD tiene menos de 12 caracteres. Usá una más larga.');
      }

      const passwordHash = await bcrypt.hash(initialPassword, 12);

      await client.query(
        `INSERT INTO users (team_id, email, password_hash, name, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [defaultTeamId, adminEmail, passwordHash, 'Super Administrador del Sistema', 'superadmin', true]
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
