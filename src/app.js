import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rawBodyJsonParser, errorHandler } from './middlewares/index.js';
import { apiRouter } from './routes/index.js';

/**
 * Crea y configura la instancia de aplicación Express.
 */
export function createApp() {
  const app = express();

  // 1. Cabeceras y seguridad básica
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(cookieParser());

  // 2. Parsers de petición con captura de rawBody para Meta
  app.use(rawBodyJsonParser);
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // 3. Health Check canónico
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // 4. Montar rutas de la API
  app.use('/api', apiRouter);

  // 5. Manejador centralizado de errores (debe ser el último middleware montado)
  app.use(errorHandler);

  return app;
}

export const app = createApp();
export default app;
