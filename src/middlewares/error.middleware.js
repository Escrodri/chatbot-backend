import { config } from '../config/index.js';

/**
 * Middleware centralizado para captura y formateo de excepciones no controladas.
 * Garantiza respuestas JSON predecibles y evita fugas de trazas internas en producción.
 */
export function errorHandler(err, req, res, next) {
  let statusCode = err.status || err.statusCode || 500;
  let errorMessage = err.message || 'Error interno del servidor.';

  // Si el archivo adjunto excede el límite del body parser
  if (err.type === 'entity.too.large' || statusCode === 413) {
    statusCode = 413;
    errorMessage = 'El archivo supera el tamaño máximo permitido (máx. 25 MB). Por favor, selecciona o comprime el archivo antes de enviarlo.';
  }
  
  console.error(`💥 [ERROR HANDLER] [${req.method} ${req.url}]:`, err.message);
  if (config.isDev && err.stack) {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    code: err.code || (statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_SERVER_ERROR'),
    ...(config.isDev ? { stack: err.stack } : {})
  });
}

export default errorHandler;
