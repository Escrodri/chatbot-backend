# Lecturas de Tarde - Backend API

Servidor backend omnicanal de alto rendimiento para gestión unificada de conversaciones de **WhatsApp Cloud API**, **Facebook Messenger** e **Instagram Direct**, con arquitectura en capas (Layered Architecture), seguridad criptográfica AppSec y cumplimiento estricto con **Meta Graph API v25.0**.

---

## 🌟 Características Principales

* **Meta Graph API v25.0:** Soporte nativo para la última versión de la API de Meta.
* **Seguridad AppSec:**
  * Almacenamiento de tokens y credenciales de canales cifrado con **AES-256-GCM**.
  * Validación criptográfica de firmas de Webhook en tiempo constante mediante **HMAC-SHA256**.
  * Autenticación basada en sesiones seguras `HttpOnly`, `SameSite` y hash de contraseñas con **bcrypt**.
* **Gestión de Ventana de Mensajería:**
  * Control estricto de la ventana estándar de 24 horas.
  * Soporte de etiqueta oficial `HUMAN_AGENT` para Messenger e Instagram hasta 7 días.
* **Escáner y Conector Automático de Fan Pages:**
  * Detección de todas las páginas de Facebook y cuentas comerciales de Instagram vinculadas.
  * Canje automático por tokens de larga duración (60 días y tokens permanentes de página).
  * Suscripción automática a eventos de Webhook (`POST /{page_id}/subscribed_apps`).
* **Bot de Bienvenida Inteligente:**
  * 1 saludo automático por cliente cada 24 horas (sin spam repetitivo).
  * Retardo natural de 10 segundos con cancelación automática si un operador humano responde primero.
* **Procesamiento de Archivos Multimedia:**
  * Descarga y almacenamiento local defensivo de imágenes, stickers, notas de voz (`.ogg`/`.mp3`) y documentos.
* **Eventos en Tiempo Real:** Servidor WebSocket con **Socket.io** para entrega instantánea de mensajes y actualización de estados.

---

## 🛠️ Stack Tecnológico

* **Entorno de Ejecución:** Node.js (v20+ recomendado)
* **Framework:** Express.js (ES Modules nativos)
* **Base de Datos:** PostgreSQL 16
* **WebSockets:** Socket.io
* **Criptografía:** Módulo nativo `node:crypto` (AES-256-GCM, HMAC-SHA256)
* **Pruebas Automatizadas:** Node Test Runner nativo (`node:test`)

---

## 🚀 Instalación y Puesta en Marcha

### 1. Clonar el repositorio
```bash
git clone <URL_DEL_REPOSITORIO_BACKEND>
cd <CARPETA_DEL_REPOSITORIO>
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
Copia el archivo de plantilla `.env.example` a `.env` y completa los valores requeridos:
```bash
cp .env.example .env
```

Variables clave en `.env`:
* `PORT`: Puerto del servidor (por defecto: `3000`).
* `DATABASE_URL`: Conexión a PostgreSQL 16 (ej. `postgres://postgres:postgres@localhost:5432/chatbot_db`).
* `ENCRYPTION_KEY`: Clave hexadecimal de 32 bytes (64 caracteres) para cifrado AES-256-GCM.
* `SESSION_SECRET`: Secreto para firma de sesiones de usuario.
* `META_APP_ID`: Identificador de tu App de Meta Developers.
* `META_APP_SECRET`: Clave secreta de tu App de Meta (para validación HMAC).
* `META_VERIFY_TOKEN`: Token de verificación para el handshake del Webhook.
* `META_API_VERSION`: `v25.0`

### 4. Inicializar la Base de Datos
Ejecuta el esquema SQL en tu base de datos PostgreSQL:
```bash
psql -U postgres -d chatbot_db -f src/database/schema.sql
```

### 5. Ejecutar la Suite de Pruebas
El proyecto incluye 56 pruebas unitarias y de integración:
```bash
npm test
```

### 6. Iniciar el Servidor
```bash
# Modo desarrollo con auto-reload:
npm run dev

# Modo producción:
npm start
```
Servidor disponible en: `http://localhost:3000`.

---

## 📡 Endpoints del Sistema

* `GET /health`: Comprobación de salud del servidor.
* `GET /api/webhook`: Handshake de verificación de Meta Graph API.
* `POST /api/webhook`: Ingesta asíncrona de eventos de WhatsApp, Facebook e Instagram (< 50ms).
* `POST /api/auth/login`: Autenticación con cookie `session_token`.
* `GET /api/auth/me`: Verificación de sesión activa.
* `POST /api/auth/logout`: Cierre de sesión.
* `GET /api/conversations`: Lista de chats con cálculo de ventana activa y filtros.
* `GET /api/conversations/:id/messages`: Historial con paginación Keyset.
* `POST /api/conversations/:id/messages`: Envío de respuesta humana con pase de control automático.
* `POST /api/conversations/:id/bot-toggle`: Conmutación manual del Bot vs Atención Humana.
* `GET /api/settings/channels`: Listado seguro de canales conectados.
* `POST /api/settings/channels/scan-facebook-pages`: Escaneo automático de Fan Pages de Meta.
* `POST /api/settings/channels/connect-facebook-pages`: Conexión en 1 clic y suscripción a Webhook.
* `POST /api/compliance/data-deletion`: Endpoint oficial de eliminación de datos de usuario de Meta.

---

## 🔒 Licencia y Seguridad
Este proyecto sigue las mejores prácticas de ciberseguridad AppSec de OWASP y las directrices oficiales de la Plataforma para Desarrolladores de Meta.
