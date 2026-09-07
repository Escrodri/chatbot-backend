import crypto from 'crypto';

/**
 * Calcula el hash HMAC-SHA256 de un buffer o texto con una clave secreta.
 * 
 * @param {Buffer|string} data Datos a firmar (usualmente req.rawBody)
 * @param {string} secret Clave secreta (App Secret de Meta)
 * @returns {string} Firma hexadecimal
 */
export function calculateHmacSha256(data, secret) {
  if (!data || !secret) {
    throw new Error('Se requieren datos y clave secreta para calcular HMAC-SHA256.');
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data);
  return hmac.digest('hex');
}

/**
 * Verifica una firma HMAC-SHA256 de Meta (cabecera X-Hub-Signature-256).
 * Utiliza crypto.timingSafeEqual para prevenir ataques de temporización (Timing Attacks).
 * 
 * @param {Buffer} rawBody Buffer binario exacto del cuerpo de la petición HTTP
 * @param {string} signatureHeader Cabecera enviada por Meta (ej: "sha256=abcdef...")
 * @param {string} secret App Secret de Meta registrado para el canal
 * @returns {boolean} true si la firma es auténtica y no ha sido alterada
 */
export function verifyHmacSha256(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !secret) {
    return false;
  }

  // Normalizar la cabecera: Meta envía el prefijo "sha256="
  let providedHash = signatureHeader.trim();
  if (providedHash.startsWith('sha256=')) {
    providedHash = providedHash.slice(7);
  }

  // Verificar que el hash provisto sea hexadecimal válido de 64 caracteres (sha256)
  if (providedHash.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(providedHash)) {
    return false;
  }

  try {
    const expectedHash = calculateHmacSha256(rawBody, secret);
    
    const providedBuffer = Buffer.from(providedHash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');

    // timingSafeEqual requiere que ambos buffers tengan idéntica longitud
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
