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
      'ALTER TABLE contacts ADD COLUMN IF NOT EXISTS perfil_ultimo_intento TIMESTAMPTZ',

      // Cuántos seguimientos de recuperación se le mandaron ya a este pedido,
      // y cuándo salió el último.
      //
      // El nivel no cuenta mensajes enviados: cuenta hasta qué escalón de la
      // escalera llegó el pedido. Sube también cuando un seguimiento se
      // descarta —por caer en horario de silencio o fuera de la ventana
      // gratuita de Meta—, porque si no subiera, ese mismo seguimiento
      // volvería a estar vencido en la pasada siguiente y el pedido quedaría
      // atascado ahí, intentando lo mismo cada quince minutos para siempre.
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS recuperacion_nivel SMALLINT NOT NULL DEFAULT 0',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS recuperacion_at TIMESTAMPTZ',
      'CREATE INDEX IF NOT EXISTS idx_orders_recuperacion ON orders (status, recuperacion_nivel, etapa_at)',

      // Cuándo esta persona se enojó o nos trató de estafadores.
      //
      // Hace dos cosas, y la segunda es la que importa: marca el chat en la
      // bandeja para que se lo mire, y lo saca de la recuperación de
      // abandonos. Mandarle "¿te quedó alguna duda?" dos horas después a
      // alguien que escribió "estafan a la gente", y un descuento seis horas
      // más tarde, no es insistir: es confirmarle que del otro lado hay una
      // máquina que no leyó nada.
      'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS molesto_at TIMESTAMPTZ',

      // Un solo pedido sin producto por conversación.
      //
      // UNIQUE(conversation_id, product_id) no cubre este caso: Postgres trata
      // cada NULL como distinto de los demás, así que el pedido sin producto
      // nunca chocaba consigo mismo y cada mensaje de interés abría una fila
      // nueva. El embudo contaba gente que no existe y "¿ya pagó?" miraba la
      // fila más nueva —la vacía—, así que se le volvía a cobrar a quien ya
      // había pagado en la anterior.
      // Antes del índice hay que limpiar los duplicados que ya se crearon, o
      // el índice no se puede construir y el arreglo no entra nunca.
      //
      // Se borran solo los que no tienen nada que perder: los que siguen en
      // 'interesado' y nunca tuvieron un comprobante. De cada conversación
      // sobrevive el que llegó más lejos en el embudo. Si igual quedan dos
      // pagados —que no debería pasar—, el índice falla con un aviso y el
      // sistema sigue funcionando como hasta ahora.
      `DELETE FROM orders o
        WHERE o.product_id IS NULL
          AND o.status = 'interesado'
          AND o.receipt_operacion IS NULL
          AND EXISTS (
            SELECT 1 FROM orders otro
             WHERE otro.conversation_id = o.conversation_id
               AND otro.product_id IS NULL
               AND otro.id <> o.id
               AND (
                 array_position(
                   ARRAY['entro','vio_producto','vio_muestras','pidio_comprar',
                         'recibio_datos','mando_comprobante','pago','recibio_material'],
                   otro.etapa
                 ),
                 otro.id
               ) > (
                 array_position(
                   ARRAY['entro','vio_producto','vio_muestras','pidio_comprar',
                         'recibio_datos','mando_comprobante','pago','recibio_material'],
                   o.etapa
                 ),
                 o.id
               )
          )`,

      `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_conversacion_sin_producto
         ON orders (conversation_id)
         WHERE product_id IS NULL`,

      // Ajustes que se cambian en caliente, desde el tablero.
      //
      // Las variables de entorno sirven para lo que se define una vez. Para
      // "salgo dos horas, que apruebe solo" no sirven: cambiarlas reinicia el
      // servicio y tarda minutos, así que en la práctica nadie las cambia.
      `CREATE TABLE IF NOT EXISTS ajustes (
         clave      VARCHAR(80) PRIMARY KEY,
         valor      JSONB NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_by INTEGER
       )`,

      // Cada comprobante que llega, con lo que se leyó y lo que se decidió.
      //
      // El pedido guardaba un solo número de operación, y con eso no se podía
      // saber si alguien pagó en dos partes, si pagó dos veces, ni si ya había
      // mandado esa misma captura. Ver `comprobante.repository.js`.
      //
      // `message_id` va sin clave foránea a propósito: el guion a veces manda
      // ids que no son de nuestra base, y una foránea ahí convierte un dato
      // decorativo en un error 500 justo en el momento de cobrar. Ya pasó.
      `CREATE TABLE IF NOT EXISTS comprobantes (
         id              SERIAL PRIMARY KEY,
         order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
         conversation_id INTEGER,
         message_id      INTEGER,
         clave           VARCHAR(80),
         monto           NUMERIC(14, 2),
         moneda          VARCHAR(10),
         cuenta          VARCHAR(40),
         titular         VARCHAR(120),
         fecha           VARCHAR(8),
         hora            VARCHAR(4),
         tipo            VARCHAR(20),
         veredicto       VARCHAR(40) NOT NULL,
         recibido        BOOLEAN NOT NULL DEFAULT FALSE,
         created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      'CREATE INDEX IF NOT EXISTS idx_comprobantes_pedido ON comprobantes (order_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_comprobantes_clave ON comprobantes (clave) WHERE clave IS NOT NULL',

      // Una transferencia cuenta para UN pedido, nunca para dos. En la base y
      // no en el código, por la misma razón que el índice de operación de
      // arriba: dos comprobantes iguales en el mismo segundo pasan los dos
      // cualquier chequeo de "¿ya se usó?" que se haga leyendo antes de
      // escribir.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_comprobantes_clave_recibida
         ON comprobantes (clave)
         WHERE recibido = TRUE AND clave IS NOT NULL`,

      // Campañas de precio: remarketing, promos por fecha.
      //
      // Hasta ahora había un solo precio especial, el de recuperación, y
      // salía de un número —el escalón del seguimiento— que no vencía nunca
      // y que además subía aunque el mensaje con el descuento no hubiera
      // salido. Una campaña dice explícitamente cuánto, para qué producto,
      // desde cuándo, hasta cuándo, y a quién: solo a los que llegan por el
      // anuncio o escriben la palabra clave, o a todos los que escriban
      // mientras dure.
      `CREATE TABLE IF NOT EXISTS campanas (
         id            SERIAL PRIMARY KEY,
         nombre        VARCHAR(80) NOT NULL,
         product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
         precio        NUMERIC(14, 2) NOT NULL,
         desde         TIMESTAMPTZ NOT NULL,
         hasta         TIMESTAMPTZ NOT NULL,
         alcance       VARCHAR(20) NOT NULL DEFAULT 'invitados',
         anuncios      TEXT,
         palabra_clave VARCHAR(60),
         gracia_horas  INTEGER NOT NULL DEFAULT 24,
         activa        BOOLEAN NOT NULL DEFAULT TRUE,
         created_by    INTEGER,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      'CREATE INDEX IF NOT EXISTS idx_campanas_producto ON campanas (product_id, activa, desde, hasta)',

      // Qué precio especial se le ofreció a cada persona, de dónde salió y
      // hasta cuándo vale.
      //
      // Va por conversación y no por pedido porque el remarketing apunta a
      // personas: alguien que vuelve desde el anuncio de 15 mil puede no
      // tener todavía un pedido abierto, y el precio tiene que estar
      // esperándolo cuando lo abra.
      `CREATE TABLE IF NOT EXISTS ofertas (
         id              SERIAL PRIMARY KEY,
         conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
         product_id      INTEGER REFERENCES products(id) ON DELETE CASCADE,
         precio          NUMERIC(14, 2) NOT NULL,
         origen          VARCHAR(20) NOT NULL,
         campana_id      INTEGER REFERENCES campanas(id) ON DELETE CASCADE,
         detalle         VARCHAR(200),
         desde           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         hasta           TIMESTAMPTZ,
         created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      'CREATE INDEX IF NOT EXISTS idx_ofertas_conversacion ON ofertas (conversation_id, desde)',

      // Una persona entra a una campaña una sola vez, aunque vuelva a tocar
      // el anuncio diez veces. Si no, la fecha de la oferta se correría con
      // cada clic y no se sabría cuándo la recibió de verdad.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ofertas_una_por_campana
         ON ofertas (conversation_id, campana_id)
         WHERE campana_id IS NOT NULL`,

      // Cada comprobante anota contra qué precio se lo midió y por qué. Sin
      // esto, un "faltan 4.000" no se puede explicar después: ¿era lista,
      // era promo vencida, era alguien que pagó el precio de un anuncio que
      // nunca vio?
      'ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS precio_aplicado NUMERIC(14, 2)',
      'ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS precio_origen VARCHAR(160)',
      'ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS oferta_id INTEGER',

      // Y el pedido cobrado, a qué precio y por qué campaña. Es lo que
      // permite contar cuánto vendió cada campaña.
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS precio_cobrado NUMERIC(14, 2)',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS precio_origen VARCHAR(160)',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS campana_id INTEGER',

      // Los que ya recibieron el descuento de recuperación antes de que
      // existiera esta tabla. Sin esto, a quien se le prometió 15.000 ayer se
      // le pediría 19.000 hoy. Se les da el plazo normal desde el último
      // seguimiento, y corre una sola vez: si ya tiene una oferta de
      // recuperación, no se toca.
      `INSERT INTO ofertas (conversation_id, product_id, precio, origen, detalle, desde, hasta)
       SELECT o.conversation_id, o.product_id, p.precio_recuperacion, 'recuperacion',
              'seguimiento nivel ' || o.recuperacion_nivel || ' (anterior a las ofertas)',
              o.recuperacion_at, o.recuperacion_at + INTERVAL '72 hours'
         FROM orders o
         JOIN products p ON p.id = o.product_id
        WHERE COALESCE(o.recuperacion_nivel, 0) >= 2
          AND o.recuperacion_at IS NOT NULL
          AND p.precio_recuperacion > 0
          AND p.precio_recuperacion < p.price
          AND NOT EXISTS (
            SELECT 1 FROM ofertas f
             WHERE f.conversation_id = o.conversation_id AND f.origen = 'recuperacion'
          )`,

      // De qué anuncio viene cada persona, con nombre.
      //
      // Meta manda en el primer mensaje el identificador del anuncio y, en
      // WhatsApp, el título y el texto que la persona vio. El nombre que le
      // pusiste en el Administrador de anuncios ("CREATIVO A — CONTROL") no
      // viene nunca: se carga desde el panel. Sin esta tabla el panel solo
      // puede mostrar números de 18 cifras.
      `CREATE TABLE IF NOT EXISTS anuncios (
         ad_id        VARCHAR(100) PRIMARY KEY,
         nombre       VARCHAR(160),
         conjunto     VARCHAR(160),
         campana      VARCHAR(160),
         titulo       TEXT,
         texto        TEXT,
         url          TEXT,
         plataforma   VARCHAR(20),
         primera_vez  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         ultima_vez   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      // Los anuncios que ya trajeron gente antes de que existiera la tabla.
      `INSERT INTO anuncios (ad_id, primera_vez, ultima_vez)
       SELECT source_ad_id, MIN(created_at), MAX(created_at)
         FROM conversations
        WHERE source_ad_id IS NOT NULL AND source_ad_id <> ''
        GROUP BY source_ad_id
       ON CONFLICT (ad_id) DO NOTHING`,
      'CREATE INDEX IF NOT EXISTS idx_conversations_anuncio ON conversations (source_ad_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_creada ON conversations (created_at)',

      // De qué producto se está hablando en cada conversación. Con varios
      // productos, un "bueno" o la foto del comprobante no dicen de cuál se
      // trata: se toma este, que cambia solo cuando la persona elige otro.
      'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS producto_foco_id INTEGER',

      // Identificador del conjunto de anuncios (adset) y de campaña.
      // Permite saber con precisión de qué conjunto vino la conversación además del anuncio.
      'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_adset_id VARCHAR(100)',
      'CREATE INDEX IF NOT EXISTS idx_conversations_adset ON conversations (source_adset_id) WHERE source_adset_id IS NOT NULL',
      'ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS adset_id VARCHAR(100)',
      'ALTER TABLE anuncios ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(100)'
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

    // 5. Sembrar o actualizar producto digital "Grandes Historias de la Biblia"
    try {
      const nuevoResumen = `📦 Mirá todo lo que incluye el material:

1️⃣ 10 Grandes Historias Bíblicas completas: Desde La Creación del Mundo y El Arca de Noé hasta El Nacimiento de Jesús y La Resurrección, narradas paso a paso en 50 partes.
2️⃣ 50 Láminas para Colorear: Dibujos hermosos con trazos claros ideales para lápices, crayolas o témperas (de 3 a 10 años).
3️⃣ 50 Lecciones Bíblicas para el Corazón: Cada página trae una reflexión diaria para conversar en familia sobre el perdón, la obediencia, la valentía y el amor de Dios.
4️⃣ 🏆 Diploma de "Pequeño Conocedor de la Biblia": Certificado al final del libro listo para imprimir y premiar su dedicación cuando complete las historias.

✨ Ventaja única: Al ser en formato digital PDF, lo guardás en tu celular y lo imprimís en casa o en una librería las veces que quieras (ideal si tenés más de un niño o para volver a pintar).

🔥 Precio promocional hoy: Gs. 19.000 (pago único, acceso para siempre directo a tu WhatsApp)

¿Cómo te gustaría continuar? Elegí una opción 👇
1️⃣ Ver páginas por dentro 🖼️
2️⃣ Lo quiero ya 📲`;

      const deliveryNote = `Recomendación: Impriman una historia por semana para hacer juntos el devocional familiar. ¡Que sea de gran bendición para tu hogar! ✨`;

      const { rows: existingProducts } = await client.query(
        `SELECT id FROM products 
         WHERE slug = 'grandes-historias-de-la-biblia' 
            OR name ILIKE '%Grandes Historias%' 
            OR resumen ILIKE '%Grandes Historias%'
            OR description ILIKE '%Grandes Historias%'
         LIMIT 1`
      );

      let targetProductId = existingProducts[0]?.id;
      if (!targetProductId) {
        const { rows: allProds } = await client.query('SELECT id FROM products LIMIT 2');
        if (allProds.length === 1) {
          targetProductId = allProds[0].id;
        }
      }

      if (targetProductId) {
        await client.query(
          `UPDATE products
           SET resumen = $1,
               price = 19000,
               currency = 'PYG',
               precio_recuperacion = 15000,
               delivery_note = COALESCE(delivery_note, $2),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [nuevoResumen, deliveryNote, targetProductId]
        );
        console.log(`✅ [DATABASE] Producto "Grandes Historias de la Biblia" (#${targetProductId}) actualizado con nuevo resumen.`);
      } else {
        await client.query(
          `INSERT INTO products (team_id, slug, name, description, resumen, price, currency, precio_recuperacion, delivery_note, is_active, sort_order)
           VALUES ($1, 'grandes-historias-de-la-biblia', 'Grandes Historias de la Biblia — Libro para Colorear (PDF)', $2, $3, 19000, 'PYG', 15000, $4, TRUE, 1)`,
          [
            defaultTeamId,
            'Material educativo y devocional cristiano para niños de 3 a 10 años en formato digital PDF listo para imprimir en casa o librería.',
            nuevoResumen,
            deliveryNote
          ]
        );
        console.log('🌱 [DATABASE] Producto "Grandes Historias de la Biblia" sembrado exitosamente.');
      }
    } catch (prodErr) {
      console.warn('⚠️ [DATABASE] Nota sobre actualización de producto inicial:', prodErr.message);
    }
  } catch (error) {
    console.error('❌ [DATABASE ERROR] Error al inicializar esquema PostgreSQL:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

export default { initDatabase };
