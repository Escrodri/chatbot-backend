-- ==============================================================================
-- DDL OFICIAL POSTGRESQL 16: SISTEMA MULTI-CANAL ENTERPRISE (SDD CONTRACT)
-- ==============================================================================

-- 1. Operadores del Sistema (Roles: admin, agent)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'agent' CHECK(role IN ('admin', 'agent')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 2. Canales y Cuentas de Meta (Tokens cifrados con AES-256-GCM)
CREATE TABLE IF NOT EXISTS channels (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(20) NOT NULL CHECK(platform IN ('whatsapp', 'instagram', 'facebook')),
    name VARCHAR(255) NOT NULL,
    channel_identifier VARCHAR(100) UNIQUE NOT NULL,  -- phone_number_id (WA) o page_id (FB/IG)
    app_id VARCHAR(100),
    app_secret_encrypted TEXT,                        -- Cifrado AES-256-GCM
    access_token_encrypted TEXT NOT NULL,             -- Cifrado AES-256-GCM
    token_iv VARCHAR(64) NOT NULL,                    -- Vector de inicialización (Hex)
    token_tag VARCHAR(64) NOT NULL,                   -- Tag de autenticación GCM (Hex)
    color_tag VARCHAR(20) DEFAULT '#25D366',          -- Color distintivo para badge
    status VARCHAR(20) DEFAULT 'active' CHECK(status IN ('active', 'error', 'paused')),
    error_message TEXT,
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Asignación de Canales a Operadores (Aislamiento IDOR)
CREATE TABLE IF NOT EXISTS user_channel_assignments (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);

-- 4. Configuración del Chatbot por Canal
CREATE TABLE IF NOT EXISTS bot_settings (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT TRUE,
    welcome_message TEXT NOT NULL DEFAULT '¡Hola! Gracias por comunicarte con nosotros. Un asesor te atenderá a la brevedad. ¿En qué podemos ayudarte?',
    inactivity_hours INTEGER DEFAULT 24,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. Contactos de Clientes
CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL CHECK(platform IN ('whatsapp', 'instagram', 'facebook')),
    platform_user_id VARCHAR(100) NOT NULL,           -- Teléfono en WA, PSID en FB, IGSID en IG
    name VARCHAR(255) NOT NULL,
    phone_or_username VARCHAR(100),
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, platform_user_id)
);

-- 6. Conversaciones (Cabeceras de Chat)
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    last_message_text TEXT DEFAULT '',
    last_message_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_customer_interaction TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    unread_count INTEGER DEFAULT 0,
    bot_status VARCHAR(20) DEFAULT 'active' CHECK(bot_status IN ('active', 'handed_over', 'disabled')),
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. Mensajes Individuales con Deduplicación
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    meta_message_id VARCHAR(150) UNIQUE,              -- Deduplicación estricta de Meta
    direction VARCHAR(10) NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    sender_type VARCHAR(20) DEFAULT 'customer' CHECK(sender_type IN ('customer', 'bot', 'agent')),
    sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content_type VARCHAR(20) DEFAULT 'text' CHECK(content_type IN ('text', 'image', 'sticker', 'audio', 'video', 'document', 'system')),
    text TEXT NOT NULL,
    media_url TEXT,
    status VARCHAR(20) DEFAULT 'sent' CHECK(status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
    error_details JSONB,                              -- Diagnóstico nativo JSONB
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. Auditoría de Webhooks
CREATE TABLE IF NOT EXISTS webhook_logs (
    id BIGSERIAL PRIMARY KEY,
    platform VARCHAR(20),
    channel_identifier VARCHAR(100),
    event_type VARCHAR(50),
    payload_json JSONB,                               -- Payload crudo en formato JSONB nativo
    status VARCHAR(20),                               -- 'PROCESSED', 'DUPLICATE', 'ERROR', 'IGNORED'
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Índices de Rendimiento y Concurrencia
CREATE INDEX IF NOT EXISTS idx_channels_lookup ON channels(channel_identifier, status);
CREATE INDEX IF NOT EXISTS idx_contacts_lookup ON contacts(channel_id, platform_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id, last_message_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv_cursor ON messages(conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_meta_id ON messages(meta_message_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_payload_gin ON webhook_logs USING gin (payload_json);

-- ==============================================================================
-- Identificador del archivo en Meta.
-- Permite volver a pedirle el archivo a Meta si la copia local se perdió
-- (el disco de los planes gratuitos se borra en cada despliegue).
-- ==============================================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta_media_id VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(meta_media_id) WHERE meta_media_id IS NOT NULL;

-- ==============================================================================
-- Atribución de anuncios y registro de ventas.
--
-- Cuando alguien llega desde un anuncio de clic a WhatsApp o a Messenger, Meta
-- manda un identificador del clic UNA SOLA VEZ, dentro del webhook del primer
-- mensaje. Hay que guardarlo con la conversación: es lo que después permite
-- avisarle a Meta que esa charla terminó en una venta y que el anuncio funcionó.
-- ==============================================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ctwa_clid VARCHAR(512);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_ad_id VARCHAR(100);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_type VARCHAR(50);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_url TEXT;

-- La cuenta de WhatsApp Business a la que pertenece el número. Viene en el
-- webhook y hace falta para identificar el evento de conversión.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS waba_id VARCHAR(100);

-- 9. Ventas informadas a Meta (API de Conversiones)
CREATE TABLE IF NOT EXISTS conversion_events (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    registered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_name VARCHAR(50) NOT NULL DEFAULT 'Purchase',
    event_id VARCHAR(100) NOT NULL UNIQUE,            -- Evita que un doble clic cuente dos veces
    value NUMERIC(14, 2),
    currency VARCHAR(10),
    note TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'skipped')),
    error_details JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversion_events_conv ON conversion_events(conversation_id, created_at DESC);
