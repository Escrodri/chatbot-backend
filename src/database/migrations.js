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
    // 1. Cargar y ejecutar DDL base
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    try {
      await client.query(schemaSql);
    } catch (sErr) {
      console.warn('⚠️ [DATABASE] Nota al ejecutar schema base (posibles objetos existentes):', sErr.message);
    }

    // 2. Aplicar columnas multi-tenant de forma resiliente e individual
    const columnMigrations = [
      'ALTER TABLE channels ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE',
      'ALTER TABLE channels ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE',
      'ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE',
      "ALTER TABLE teams ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
      'ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE',
      'ALTER TABLE teams ADD COLUMN IF NOT EXISTS meta_app_id VARCHAR(100)',
      'ALTER TABLE teams ADD COLUMN IF NOT EXISTS meta_app_secret_encrypted TEXT',
      "ALTER TABLE teams ADD COLUMN IF NOT EXISTS meta_verify_token VARCHAR(255) DEFAULT 'meta_webhook_verify_token_secure_2026'",

      // Cuántas veces contestó el bot sin que el pedido avance. Es el contador
      // que decide cuándo dejar de insistir con el guion y llamar a la IA: si
      // después de varios mensajes la persona sigue en "interesado", el guion
      // claramente no está entendiendo lo que pregunta.
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_intentos INTEGER NOT NULL DEFAULT 0'
    ];

    for (const sql of columnMigrations) {
      try {
        await client.query(sql);
      } catch (colErr) {
        console.warn('⚠️ [DATABASE MIGRATION NOTICE]:', colErr.message);
      }
    }

    // 3. Índices de rendimiento multi-tenant
    const indexMigrations = [
      'CREATE INDEX IF NOT EXISTS idx_channels_team ON channels(team_id, deleted_at)',
      'CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id, role)',
      'CREATE INDEX IF NOT EXISTS idx_bot_settings_team ON bot_settings(team_id, channel_id)'
    ];

    for (const idxSql of indexMigrations) {
      try {
        await client.query(idxSql);
      } catch (idxErr) {
        console.warn('⚠️ [DATABASE INDEX NOTICE]:', idxErr.message);
      }
    }

    // Deduplicar conversaciones (channel_id, contact_id) si existieran antes de aplicar la restricción UNIQUE
    try {
      await client.query(`
        DO $$
        DECLARE
          dup RECORD;
          primary_id INT;
        BEGIN
          FOR dup IN (
            SELECT channel_id, contact_id, ARRAY_AGG(id ORDER BY last_message_time DESC, id DESC) as ids
            FROM conversations
            GROUP BY channel_id, contact_id
            HAVING COUNT(*) > 1
          ) LOOP
            primary_id := dup.ids[1];
            UPDATE messages SET conversation_id = primary_id WHERE conversation_id = ANY(dup.ids[2:]);
            DELETE FROM conversations WHERE id = ANY(dup.ids[2:]);
          END LOOP;
        END $$;
      `);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_id_contact_id_key'
          ) THEN
            ALTER TABLE conversations ADD CONSTRAINT conversations_channel_id_contact_id_key UNIQUE(channel_id, contact_id);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END $$;
      `);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_contact ON conversations(channel_id, contact_id)');
    } catch (cErr) {
      console.warn('⚠️ [DATABASE] Nota sobre restricción de conversaciones:', cErr.message);
    }

    // Deduplicar y asegurar unicidad en bot_settings
    try {
      await client.query(`
        DO $$
        DECLARE
          bdup RECORD;
        BEGIN
          FOR bdup IN (
            SELECT channel_id, ARRAY_AGG(id ORDER BY updated_at DESC, id DESC) as ids
            FROM bot_settings
            WHERE channel_id IS NOT NULL
            GROUP BY channel_id
            HAVING COUNT(*) > 1
          ) LOOP
            DELETE FROM bot_settings WHERE id = ANY(bdup.ids[2:]);
          END LOOP;

          FOR bdup IN (
            SELECT team_id, ARRAY_AGG(id ORDER BY updated_at DESC, id DESC) as ids
            FROM bot_settings
            WHERE channel_id IS NULL AND team_id IS NOT NULL
            GROUP BY team_id
            HAVING COUNT(*) > 1
          ) LOOP
            DELETE FROM bot_settings WHERE id = ANY(bdup.ids[2:]);
          END LOOP;
        END $$;
      `);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_settings_channel_unique ON bot_settings(channel_id) WHERE channel_id IS NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_settings_team_default_unique ON bot_settings(team_id) WHERE channel_id IS NULL');
    } catch (bErr) {
      console.warn('⚠️ [DATABASE] Nota sobre índices únicos de bot_settings:', bErr.message);
    }

    // Actualizar restricción de roles dinámicamente para soportar 'superadmin'
    try {
      await client.query(`
        DO $$
        DECLARE
            con_record RECORD;
        BEGIN
            FOR con_record IN (
                SELECT c.conname
                FROM pg_constraint c
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                WHERE c.conrelid = 'users'::regclass
                  AND c.contype = 'c'
                  AND a.attname = 'role'
            ) LOOP
                EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(con_record.conname);
            END LOOP;
        END $$;
      `);
      await client.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('superadmin', 'admin', 'agent'))");
    } catch (cErr) {
      console.warn('⚠️ [DATABASE] Nota sobre constraint de roles:', cErr.message);
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

    // 3. Vincular usuarios, canales y configuración de bot huérfanos al equipo por defecto
    await client.query('UPDATE users SET team_id = $1 WHERE team_id IS NULL', [defaultTeamId]);
    await client.query('UPDATE channels SET team_id = $1 WHERE team_id IS NULL', [defaultTeamId]);
    await client.query(`
      UPDATE bot_settings 
      SET team_id = (SELECT team_id FROM channels WHERE id = bot_settings.channel_id) 
      WHERE team_id IS NULL AND channel_id IS NOT NULL
    `);
    await client.query('UPDATE bot_settings SET team_id = $1 WHERE team_id IS NULL', [defaultTeamId]);

    // Promover explícitamente el usuario administrador principal a superadmin
    const targetAdminEmail = (process.env.ADMIN_EMAIL || 'admin@empresa.com').toLowerCase().trim();
    await client.query(
      `UPDATE users 
       SET role = 'superadmin' 
       WHERE LOWER(email) = $1 
          OR id = (SELECT id FROM users ORDER BY id ASC LIMIT 1)`,
      [targetAdminEmail]
    );

    // El Superadministrador es global de la plataforma; su team_id debe ser NULL para no contarse erróneamente como operador del Equipo Principal
    await client.query("UPDATE users SET team_id = NULL WHERE role = 'superadmin'");

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
        [null, adminEmail, passwordHash, 'Super Administrador del Sistema', 'superadmin', true]
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
