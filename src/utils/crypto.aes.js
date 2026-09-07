import crypto from 'crypto';
import { config } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recomendado para GCM

/**
 * Obtiene el buffer de 32 bytes de la clave de cifrado configurada.
 * @returns {Buffer}
 */
function getKeyBuffer() {
  const hexKey = config.security.encryptionKey;
  return Buffer.from(hexKey, 'hex');
}

/**
 * Cifra una cadena de texto plano usando AES-256-GCM.
 * Genera un vector de inicialización (IV) único y criptográficamente seguro por cada llamada.
 * 
 * @param {string} plainText Texto a cifrar (ej. Access Token de Meta o App Secret)
 * @returns {{ cipherText: string, iv: string, tag: string }} Objeto con cadenas hexadecimales
 */
export function encryptSecret(plainText) {
  if (!plainText || typeof plainText !== 'string') {
    throw new Error('El texto a cifrar debe ser una cadena no vacía.');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);

  let cipherText = cipher.update(plainText, 'utf8', 'hex');
  cipherText += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  return {
    cipherText,
    iv: iv.toString('hex'),
    tag
  };
}

/**
 * Descifra un secreto previamente cifrado con AES-256-GCM.
 * Valida de forma estricta el tag de autenticación; si el tag o el texto fueron alterados, falla.
 * 
 * @param {string} cipherText Texto cifrado en hexadecimal
 * @param {string} iv Vector de inicialización en hexadecimal (12 bytes)
 * @param {string} tag Etiqueta de autenticación GCM en hexadecimal (16 bytes)
 * @returns {string} Texto plano recuperado
 */
export function decryptSecret(cipherText, iv, tag) {
  if (!cipherText || !iv || !tag) {
    throw new Error('Parámetros de descifrado incompletos: se requiere cipherText, iv y tag.');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKeyBuffer(),
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(cipherText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
