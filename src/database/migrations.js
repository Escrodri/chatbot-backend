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
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_intentos INTEGER NOT NULL DEFAULT 0',

      // Desde cuándo este chat está en manos de una persona.
      //
      // Sin esta fecha, pasarle el chat a un asesor era para siempre: el bot se
      // callaba y no volvía a hablar nunca más, aunque del otro lado alguien
      // escribiera al otro día a las tres de la mañana y no hubiera nadie para
      // contestarle. Con la hora anotada se puede decidir que después de un
      // rato largo sin que nadie del equipo conteste, el bot retome el chat en
      // vez de dejarlo mudo.
      //
      // Se pisa cada vez que una persona escribe, así que mide lo que hay que
      // medir: hace cuánto que este chat no recibe atención humana.
      'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ',

      // Número de operación del comprobante, guardado aparte del texto suelto
      // de la revisión.
      //
      // Es lo único del comprobante que identifica a una transferencia y no se
      // repite. Sin esto, la misma captura sirve infinitas veces: alcanza con
      // reenviarla, o con que circule entre conocidos, para que el bot entregue
      // el material de nuevo. Mientras revisa una persona el problema no
      // existe, porque se da cuenta; en la entrega automática de madrugada es
      // la única defensa que queda.
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_operacion VARCHAR(60)',
      'CREATE INDEX IF NOT EXISTS idx_orders_receipt_operacion ON orders (receipt_operacion) WHERE receipt_operacion IS NOT NULL',

      // Este pedido lo aprobó el sistema solo, sin que nadie mirara el banco.
      // Queda marcado para que a la mañana se puedan repasar de un vistazo los
      // que se entregaron de madrugada y contrastarlos contra el extracto.
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_aprobado BOOLEAN NOT NULL DEFAULT FALSE',

      // Precio para recuperar a quien se quedó a mitad de camino.
      //
      // Va como campo del producto y no escrito en el guion a propósito: un
      // descuento permanente se aprende, y en un mercado chico alcanza con que
      // un par de personas comenten que esperando baja para que esperar salga
      // gratis. Estando acá se apaga vaciando el campo, sin tocar el flujo.
      //
      // Vacío significa que no hay precio de recuperación y se insiste al
      // precio de siempre.
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS precio_recuperacion NUMERIC(14, 2)',

      // Páginas de muestra: dos o tres imágenes, una URL por línea.
      //
      // Quien duda de un material para chicos duda de cómo se ve, no de la
      // descripción. Mostrar dos páginas responde esa pregunta mejor que
      // cualquier texto, y mandar quince la vuelve a abrir: si ya vio todo,
      // no le queda nada por comprar.
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS preview_urls TEXT',

      // Hasta dónde llegó esta persona. Es distinto del estado del pedido y va
      // en su propia columna a propósito.
      //
      // `status` responde "¿qué hago con esto ahora?" y por eso va y viene: un
      // pedido rechazado puede volver a comprobante_recibido cuando mandan la
      // captura buena. Sirve para trabajar, no para medir: si alguien llegó
      // hasta el pago y después volvió atrás, el estado ya no recuerda que
      // llegó.
      //
      // `etapa` responde "¿hasta dónde llegó?" y solo avanza. Eso es lo que
      // permite comparar anuncios por costo por venta real en vez de por costo
      // por conversación, y es también lo que decide a quién se le insiste con
      // descuento: el que pidió los datos de pago y no transfirió no es el
      // mismo caso que el que preguntó el precio y nunca volvió.
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS etapa VARCHAR(30) NOT NULL DEFAULT 'entro'",
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS etapa_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP',
      'CREATE INDEX IF NOT EXISTS idx_orders_etapa ON orders (etapa, etapa_at)',

      // La versión corta del producto, la que entra en la tarjeta de WhatsApp.
      //
      // La descripción larga sirve para la web y para que una persona entienda
      // qué está comprando. En la tarjeta con botones arruina la venta: WhatsApp
      // la corta con un "Leer más" y lo que queda abajo del corte —el precio y
      // los botones— es justo lo único que importa. En un celular, con la
      // descripción larga ni siquiera se llega a ver la portada.
      //
      // Dos textos porque son dos trabajos distintos, no porque uno esté mal.
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS resumen TEXT',

      // Un número de operación no puede cobrar dos pedidos. Se lo prohíbe la
      // base y no el código.
      //
      // El chequeo en JavaScript era leer y después escribir, sin nada en el
      // medio: dos comprobantes iguales llegando en el mismo segundo pasaban
      // los dos, porque cuando el segundo preguntó "¿ya se usó?" el primero
      // todavía no había terminado de guardarse. Con el índice único la
      // segunda escritura falla siempre, sin importar el orden ni cuántos
      // procesos haya.
      //
      // Es parcial a propósito: solo cuentan los pedidos cobrados. Que el
      // mismo número aparezca en uno rechazado es alguien reintentando, no un
      // fraude.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_operacion_unica
         ON orders (receipt_operacion)
         WHERE receipt_operacion IS NOT NULL AND status IN ('pagado', 'entregado')`,

      // La bandeja cuenta las compras previas de cada persona cruzando por
      // contact_id, y ese cruce no tenía índice: cada vez que se pintaba la
      // lista, Postgres recorría la tabla entera una vez por cada chat.
      // Invisible con cien conversaciones, medio segundo con diez mil.
      'CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations (contact_id)',

      // La bandeja ordena por el último mensaje. Sin índice, ordenar es leer
      // todo y clasificarlo, cada cinco segundos, por cada asesor con la
      // pantalla abierta.
      'CREATE INDEX IF NOT EXISTS idx_conversations_ultimo_mensaje ON conversations (last_message_time DESC)',

      // Cuándo se intentó por última vez traer la foto y el nombre real de un
      // contacto de Facebook o Instagram, y cuántas veces se intentó.
      //
      // Sin esto el intento se repetía en cada carga de la bandeja, o sea cada
      // cinco segundos por asesor, para siempre. Un contacto sin foto —que es
      // lo normal en Instagram— se convertía en una llamada permanente a la API
      // de Meta, y los fallos no se recordaban: se reintentaba lo mismo hasta
      // que Meta cortaba por límite de peticiones.
      'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS perfil_intentos INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS perfil_ultimo_intento TIMESTAMPTZ'
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
