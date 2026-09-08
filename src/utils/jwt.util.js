import crypto from 'crypto';

/**
 * Convierte un Buffer o string a Base64URL (RFC 7515).
 * @param {Buffer|string} input 
 * @returns {string}
 */
function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Convierte un string Base64URL a Buffer.
 * @param {string} base64url 
 * @returns {Buffer}
 */
function fromBase64Url(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

/**
 * Genera y firma un JSON Web Token (JWT) estándar con HMAC-SHA256.
 * 
 * @param {object} payload Datos del usuario o sesión
 * @param {string} secret Clave secreta (config.sessionSecret)
 * @param {number} [expiresInSeconds=86400] Tiempo de vida en segundos (default: 24 horas)
 * @returns {string} Token firmado con formato header.payload.signature
 */
export function signToken(payload, secret, expiresInSeconds = 86400) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('El payload debe ser un objeto válido.');
  }
  if (!secret) {
    throw new Error('Se requiere secret para firmar el token.');
  }

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds
  };

  const header = { alg: 'HS256', typ: 'JWT' };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(fullPayload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.createHmac('sha256', secret).update(dataToSign).digest();
  const encodedSignature = toBase64Url(signature);

  return `${dataToSign}.${encodedSignature}`;
}

/**
 * Valida la firma criptográfica y la expiración de un JWT.
 * Utiliza timingSafeEqual para evitar ataques de temporización.
 * 
 * @param {string} token 
 * @param {string} secret 
 * @returns {object|null} Retorna el payload decodificado si es válido, o null si es inválido o expiró.
 */
export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(dataToSign).digest();
    const providedSignature = fromBase64Url(encodedSignature);

    if (expectedSignature.length !== providedSignature.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(expectedSignature, providedSignature)) {
      return null;
    }

    const payloadJson = fromBase64Url(encodedPayload).toString('utf8');
    const payload = JSON.parse(payloadJson);

    // Validar expiración
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null; // Token expirado
    }

    return payload;
  } catch {
    return null;
  }
}
