import { config } from '../config/index.js';

/**
 * Middleware centralizado para captura y formateo de excepciones no controladas.
 * Garantiza respuestas JSON predecibles y evita fugas de trazas internas en producción.
 */
export function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  
  console.error(`💥 [ERROR HANDLER] [${req.method} ${req.url}]:`, err.message);
  if (config.isDev && err.stack) {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    error: err.message || 'Error interno del servidor.',
    code: err.code || 'INTERNAL_SERVER_ERROR',
    ...(config.isDev ? { stack: err.stack } : {})
  });
}

export default errorHandler;
