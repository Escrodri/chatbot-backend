import express from 'express';

/**
 * Middleware que parsea peticiones JSON y preserva el Buffer binario exacto (req.rawBody)
 * necesario para la validación criptográfica de firmas HMAC-SHA256 de Meta.
 */
export const rawBodyJsonParser = express.json({
  verify: (req, res, buf) => {
    if (buf && buf.length > 0) {
      req.rawBody = buf;
    }
  },
  limit: '15mb' // Soporte para recepción de metadatos o medios en base64 si aplica
});

export default rawBodyJsonParser;
