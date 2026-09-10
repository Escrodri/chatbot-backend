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
  limit: '50mb' // Soporte para recepción de PDFs y medios de hasta 25MB en base64
});

export default rawBodyJsonParser;
