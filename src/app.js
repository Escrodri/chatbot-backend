import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rawBodyJsonParser, errorHandler } from './middlewares/index.js';
import { apiRouter } from './routes/index.js';
import { config } from './config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carpeta con el frontend compilado (npm run build dentro de frontend/)
const SPA_DIR = path.resolve(__dirname, '../../frontend/dist');
const SPA_INDEX = path.join(SPA_DIR, 'index.html');

// Prefijos que nunca deben devolver el index.html del SPA
const API_PREFIXES = ['/api', '/uploads', '/health'];

/**
 * Cabeceras de seguridad básicas, sin dependencias externas.
 * Equivale a lo esencial de helmet para esta aplicación.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');

  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
}

/**
 * Crea y configura la instancia de aplicación Express.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Detrás de nginx o de un túnel, confiar en X-Forwarded-* para conocer el
  // protocolo real (HTTPS) y la IP real del cliente (M-11).
  app.set('trust proxy', 1);

  // 1. Cabeceras de seguridad
  app.use(securityHeaders);

  // 2. CORS restringido a los orígenes autorizados (M-01).
  //    Se permiten también las peticiones sin cabecera Origin (curl, Meta, same-origin).
  const allowedOrigins = config.security.allowedOrigins;
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`🚫 [CORS] Origen no autorizado: ${origin}`);
      return callback(null, false);
    },
    credentials: true
  }));

  app.use(cookieParser());

  // 3. Archivos multimedia descargados de Meta y enviados por operadores
  app.use('/uploads', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.path && req.path.toLowerCase().endsWith('.jfif')) {
      res.setHeader('Content-Type', 'image/jpeg');
    }
    next();
  }, express.static(path.resolve(__dirname, '../uploads')));

  // 4. Parsers con captura de rawBody para verificar la firma de Meta
  app.use(rawBodyJsonParser);
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 5. Health check
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // 6. API
  app.use('/api', apiRouter);

  // 7. Frontend compilado (A-04).
  //    Sirve los archivos estáticos y devuelve index.html para las rutas del SPA
  //    (/login, /inbox, /politica-de-privacidad, ...), que de otro modo darían 404.
  const spaDisponible = fs.existsSync(SPA_INDEX);

  if (spaDisponible) {
    app.use(express.static(SPA_DIR, {
      index: false,
      maxAge: config.isProd ? '1y' : 0,
      setHeaders(res, filePath) {
        // El index.html nunca se cachea: es quien apunta a los assets con hash.
        if (filePath === SPA_INDEX) res.setHeader('Cache-Control', 'no-cache');
      }
    }));

    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (API_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) return next();
      if (req.path.includes('.')) return next(); // archivo inexistente: que devuelva 404
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(SPA_INDEX);
    });
  } else {
    console.warn('⚠️  [SPA] No se encontró frontend/dist. El backend solo servirá la API.');
    console.warn('    Para servir el sitio:  cd frontend && npm run build');
  }

  // 8. 404 explícito para la API (antes caía en el manejador genérico de Express)
  app.use((req, res, next) => {
    if (API_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
      return res.status(404).json({
        success: false,
        error: `Ruta no encontrada: ${req.method} ${req.path}`,
        code: 'ERR_NOT_FOUND'
      });
    }
    return next();
  });

  // 9. Manejador centralizado de errores (siempre el último)
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
