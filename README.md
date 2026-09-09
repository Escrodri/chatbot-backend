# Lecturas de Tarde - Backend API 💬

[![Node.js](https://img.shields.io/badge/Node.js-v20+-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-v5.2-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16--alpine-336791?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Meta Graph API](https://img.shields.io/badge/Meta%20Graph%20API-v25.0-0668E1?style=for-the-badge&logo=meta&logoColor=white)](https://developers.facebook.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-v4.8-010101?style=for-the-badge&logo=socket.io&logoColor=white)](https://socket.io/)
[![Security](https://img.shields.io/badge/AppSec-AES--256--GCM-critical?style=for-the-badge&logo=shield)](https://owasp.org/)

Servidor backend omnicanal de alto rendimiento para gestión centralizada de mensajería empresarial a través de **WhatsApp Cloud API**, **Facebook Messenger** e **Instagram Direct**. Diseñado con una arquitectura modular en capas (*Layered Architecture*), seguridad criptográfica AppSec y sincronización en tiempo real vía WebSockets.

---

## 📑 Tabla de Contenidos

- [Características Principales](#-características-principales)
- [Arquitectura del Sistema](#-arquitectura-del-sistema)
- [Stack Tecnológico](#-stack-tecnológico)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Requisitos Previos](#-requisitos-previos)
- [Instalación y Configuración](#-instalación-y-configuración)
- [Gestión con Docker](#-gestión-con-docker)
- [Variables de Entorno](#-variables-de-entorno)
- [Referencia de la API](#-referencia-de-la-api)
- [Configuración de Webhooks de Meta](#-configuración-de-webhooks-de-meta)
- [Pruebas Automatizadas](#-pruebas-automatizadas)
- [Seguridad y Buenas Prácticas](#-seguridad-y-buenas-prácticas)

---

## 🌟 Características Principales

* **Integración Omnicanal Nativa (Meta Graph API v25.0):**
  * Conexión unificada con WhatsApp Cloud API, Instagram Messaging y Facebook Messenger.
  * Ingesta asíncrona de webhooks en menos de 50ms para evitar reintentos y saturación por parte de Meta.
* **Seguridad Criptográfica AppSec:**
  * Almacenamiento seguro de tokens de acceso y credenciales mediante cifrado autenticado **AES-256-GCM**.
  * Verificación estricta de firmas de Webhooks en tiempo constante con **HMAC-SHA256** (`x-hub-signature-256`).
  * Autenticación basada en sesiones seguras con cookies `HttpOnly`, `SameSite=Lax` y contraseñas hasheadas con **bcrypt**.
  * Protección contra ataques de fuerza bruta mediante limitación de tasa (*Rate Limiting*).
* **Gestión de Ventana de Mensajería (Políticas de Meta):**
  * Cálculo dinámico de la ventana de 24 horas para respuestas gratuitas.
  * Uso de la etiqueta oficial `HUMAN_AGENT` para extender el plazo de respuesta hasta 7 días en Messenger e Instagram.
* **Escáner y Conector Automático de Fan Pages:**
  * Descubrimiento automático de todas las Fan Pages de Facebook y cuentas de Instagram Business asociadas a un User Access Token.
  * Canje transparente por tokens de larga duración (60 días y tokens de página permanentes).
  * Suscripción automática de aplicaciones al webhook de cada página (`POST /{page_id}/subscribed_apps`).
* **Bot de Bienvenida Inteligente & Handover Protocol:**
  * Respuestas automáticas configurables con filtrado antirrepetición (1 saludo por usuario cada 24 horas).
  * Retardo humano simulado (10 segundos) cancelable automáticamente si un agente responde antes.
  * Alternador de control manual (*Bot ON/OFF*) por conversación.
* **Procesamiento y Descarga Multimedia:**
  * Descarga defensiva de imágenes, notas de voz (`.ogg`/`.mp3`), stickers y documentos adjuntos para persistencia local.

---

## 🏛 Arquitectura del Sistema

```mermaid
flowchart TD
    subgraph Meta_Cloud [Meta Graph API v25.0]
        WA[WhatsApp Cloud API]
        IG[Instagram Messaging]
        FB[Facebook Messenger]
    end

    subgraph Backend_App [Backend Express Server]
        WH[Webhook Receiver /api/webhook]
        SIG[HMAC-SHA256 Signature Validator]
        PROC[Asynchronous Event Processor]
        BOT[Smart Welcome Bot Engine]
        AUTH[Auth & Session Manager]
        CTRL[REST Controllers]
        SOCK[Socket.io Realtime Server]
    end

    subgraph Storage [Persistencia y Criptografía]
        CRYPTO[AES-256-GCM Vault]
        PG[(PostgreSQL 16 Alpine)]
        MEDIA[Local Media Storage /uploads]
    end

    subgraph Clients [Clientes]
        SPA[Frontend SPA React 19]
    end

    WA & IG & FB -->|POST Events| WH
    WH --> SIG
    SIG -->|200 OK Ingest < 50ms| PROC
    PROC --> BOT
    PROC --> SOCK
    PROC --> PG
    PROC --> MEDIA

    SPA <-->|WebSockets & REST API| SOCK & CTRL
    CTRL <--> AUTH
    CTRL <--> CRYPTO
    CRYPTO <--> PG
```

---

## 🛠 Stack Tecnológico

| Componente | Tecnología | Versión / Detalle |
| :--- | :--- | :--- |
| **Entorno de Ejecución** | Node.js | v20 LTS o superior |
| **Framework Web** | Express.js | v5.2 (ES Modules nativos) |
| **Base de Datos** | PostgreSQL | 16-alpine |
| **Contenedores** | Docker & Docker Compose | Compose v2 |
| **Comunicación en Vivo**| Socket.io | v4.8 |
| **Criptografía** | `node:crypto` | AES-256-GCM, HMAC-SHA256 |
| **Seguridad de Passwords**| bcryptjs | v3.0 |
| **Pruebas** | Node Test Runner | Nativo (`node:test`) |

---

## 📁 Estructura del Proyecto

```text
backend/
├── docker-compose.yml       # Definición del contenedor PostgreSQL 16
├── package.json             # Dependencias y scripts de ejecución
├── .env.example             # Plantilla de variables de entorno seguras
├── .gitignore               # Exclusión de credenciales y datos (pgdata, .env)
├── src/
│   ├── server.js            # Punto de entrada HTTP y Socket.io
│   ├── app.js               # Configuración de Express, middlewares y rutas
│   ├── config/
│   │   └── env.config.js    # Validación y carga centralizada de variables
│   ├── controllers/         # Lógica de controladores de negocio
│   │   ├── auth.controller.js
│   │   ├── conversation.controller.js
│   │   ├── settings.controller.js
│   │   └── webhook.controller.js
│   ├── database/            # Conexión pool y scripts de migración
│   │   ├── pool.js
│   │   ├── schema.sql
│   │   └── migrations.js
│   ├── middlewares/         # Middlewares de seguridad, auth y rate limiting
│   │   ├── auth.middleware.js
│   │   ├── meta-signature.middleware.js
│   │   └── rate-limit.middleware.js
│   ├── repositories/        # Capa de acceso a datos SQL
│   ├── routes/              # Definición de rutas Express
│   ├── scripts/             # Scripts auxiliares (seed-admin, password reset)
│   ├── services/            # Servicios de integración externa (Meta Graph API)
│   └── sockets/             # Gestor de eventos en tiempo real con Socket.io
└── test/                    # Suite de pruebas automatizadas
```

---

## ⚡ Requisitos Previos

* **Node.js** (v20.0.0 o superior).
* **Docker y Docker Compose** (para levantar PostgreSQL fácilmente).
* Una cuenta de **Meta for Developers** con una App creada (tipo Comercial o Negocios).

---

## 🚀 Instalación y Configuración

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
Copia la plantilla `.env.example` para generar tu archivo de configuración:
```bash
cp .env.example .env
```
*(Consulta la sección [Variables de Entorno](#-variables-de-entorno) para completar los valores requeridos).*

### 4. Iniciar la Base de Datos con Docker
Levanta la instancia de PostgreSQL con Docker Compose:
```bash
docker compose up -d
```
Comprueba que el contenedor esté corriendo y saludable:
```bash
docker compose ps
```

### 5. Inicializar el Esquema de la Base de Datos
Ejecuta las migraciones iniciales para crear las tablas necesarias:
```bash
npm run init-db
```

### 6. Configurar el Administrador Inicial
Configura la contraseña para el usuario administrador del sistema:
```bash
npm run set-admin-password
```

### 7. Iniciar el Servidor

```bash
# Modo Desarrollo (con reinicio automático al guardar cambios):
npm run dev

# Modo Producción:
npm start
```
El servidor quedará escuchando en `http://localhost:3000`.

---

## 🐳 Gestión con Docker

El archivo `docker-compose.yml` incluido gestiona el servicio de persistencia PostgreSQL 16 con las siguientes medidas de seguridad:

* **Enlace Local Exclusivo:** El puerto `5432` está enlazado a `127.0.0.1:5432`, impidiendo que la base quede expuesta públicamente en la red.
* **Persistencia Protegida:** Los datos se guardan en el volumen local `./pgdata` (el cual está protegido en `.gitignore` para no filtrarse al repositorio).
* **Sincronización Automática:** Las credenciales del contenedor se leen directamente desde el archivo `.env`.

### Comandos útiles de Docker:
```bash
# Iniciar base de datos en segundo plano:
docker compose up -d

# Ver logs de la base de datos:
docker compose logs -f postgres

# Detener el contenedor:
docker compose stop

# Detener y remover contenedor (sin borrar datos de pgdata):
docker compose down
```

---

## 🔑 Variables de Entorno

| Variable | Tipo | Descripción | Ejemplo / Default |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | Puerto HTTP del servidor Express | `3000` |
| `NODE_ENV` | String | Entorno (`development`, `production`, `test`) | `development` |
| `DATABASE_URL` | String | URL de conexión completa a PostgreSQL | `postgres://postgres:postgres@localhost:5432/chatbot_db` |
| `POSTGRES_USER` | String | Usuario de PostgreSQL para Docker | `postgres` |
| `POSTGRES_PASSWORD` | String | Contraseña de PostgreSQL para Docker | `postgres` |
| `POSTGRES_DB` | String | Nombre de la base de datos para Docker | `chatbot_db` |
| `ENCRYPTION_KEY` | Hex | Clave de 32 bytes (64 chars hex) para AES-256-GCM | `a1b2c3...64_caracteres` |
| `SESSION_SECRET` | String | Clave secreta para firma de sesiones de operador | `clave_secreta_segura` |
| `META_APP_ID` | String | Identificador de la App en Meta for Developers | `123456789012345` |
| `META_APP_SECRET` | String | Clave Secreta de la App de Meta (para HMAC) | `abcdef0123456789...` |
| `META_VERIFY_TOKEN` | String | Token personalizado para verificación de Webhook | `mi_token_verificacion_seguro` |
| `META_API_VERSION` | String | Versión oficial de Meta Graph API | `v25.0` |
| `FRONTEND_URL` | String | URL permitida por CORS para la SPA | `http://localhost:5173` |

> 💡 **Generar clave de cifrado:** Puedes generar una clave aleatoria de 32 bytes para `ENCRYPTION_KEY` con Node:
> ```bash
> node -e "console.log(crypto.randomBytes(32).toString('hex'))"
> ```

---

## 📡 Referencia de la API

### Salud y Verificación
| Método | Endpoint | Autenticación | Descripción |
| :--- | :--- | :---: | :--- |
| `GET` | `/health` | No | Comprobación de estado del servidor y base de datos |
| `GET` | `/api/webhook` | No | Handshake de verificación de Meta Graph API |
| `POST`| `/api/webhook` | Firma HMAC | Ingesta asíncrona de eventos de WhatsApp, FB e IG |

### Autenticación de Operadores
| Método | Endpoint | Autenticación | Descripción |
| :--- | :--- | :---: | :--- |
| `POST`| `/api/auth/login` | No | Inicio de sesión de operador (emite cookie segura) |
| `GET` | `/api/auth/me` | Sesión | Consulta datos del operador autenticado |
| `POST`| `/api/auth/logout` | Sesión | Cierre de sesión e invalidación de cookie |

### Gestión de Conversaciones y Mensajes
| Método | Endpoint | Autenticación | Descripción |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/conversations` | Sesión | Lista de chats activos con estado de ventana de 24h |
| `GET` | `/api/conversations/:id/messages` | Sesión | Historial de mensajes con paginación Keyset |
| `POST`| `/api/conversations/:id/messages` | Sesión | Envío de respuesta con soporte de ventana y tags |
| `POST`| `/api/conversations/:id/bot-toggle` | Sesión | Conmutador manual de bot vs control humano |

### Canales y Configuración
| Método | Endpoint | Autenticación | Descripción |
| :--- | :--- | :---: | :--- |
| `GET` | `/api/settings/channels` | Sesión | Listado de canales conectados (sin exponer tokens) |
| `POST`| `/api/settings/channels/scan-facebook-pages` | Sesión | Escáner de Fan Pages y cuentas de Instagram |
| `POST`| `/api/settings/channels/connect-facebook-pages` | Sesión | Conexión y suscripción a webhook de páginas |
| `GET/POST`| `/api/settings/bot` | Sesión | Lectura y actualización del mensaje de bienvenida |
| `POST`| `/api/compliance/data-deletion` | Firma Meta | Endpoint oficial de solicitud de borrado de datos |

---

## 🌐 Configuración de Webhooks de Meta

1. Ve al panel de [Meta for Developers](https://developers.facebook.com/).
2. Selecciona tu aplicación y ve a la sección **Webhooks**.
3. En la configuración de **Callback URL**, especifica:
   * **URL de devolución de llamada:** `https://tu-dominio.com/api/webhook`
   * **Token de verificación:** El mismo configurado en `META_VERIFY_TOKEN`.
4. Suscríbete a los campos requeridos:
   * Para WhatsApp: `messages`, `message_template_status_update`.
   * Para Messenger/Instagram: `messages`, `messaging_postbacks`, `messaging_handovers`.

---

## 🧪 Pruebas Automatizadas

El backend cuenta con una batería de pruebas de integración y unitarias que validan la autenticación, firma de webhooks, sockets y flujos de conversación:

```bash
# Ejecutar todas las pruebas:
npm test
```

---

## 🛡️ Seguridad y Buenas Prácticas

* **Cifrado en reposo:** Las credenciales y access tokens de Meta nunca se almacenan en texto plano en la base de datos; se cifran con AES-256-GCM mediante la clave maestra `ENCRYPTION_KEY`.
* **Verificación de firma Webhook:** Cualquier llamada a `/api/webhook` sin una firma `sha256=` válida generada por Meta con el `META_APP_SECRET` es rechazada inmediatamente con código `401 Unauthorized`.
* **Cookies de Sesión:** Protegidas con flags `HttpOnly` (inmunes a XSS), `SameSite=Lax` y `Secure` en entornos de producción.

---

## 📄 Licencia

Este proyecto está bajo la licencia MIT. Desarrollado con estándares de producción para **Lecturas de Tarde** ([lecturasdetarde.online](https://lecturasdetarde.online)).
