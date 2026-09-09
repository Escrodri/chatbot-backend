import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret, decryptSecret, calculateHmacSha256, verifyHmacSha256 } from '../src/utils/index.js';

test('T-02: AES-256-GCM Cifrado y Descifrado Exacto', () => {
  const originalSecret = 'EAABwdN...MetaLongLivedAccessToken1234567890';
  
  const encrypted = encryptSecret(originalSecret);
  
  assert.ok(encrypted.cipherText, 'Debe existir cipherText');
  assert.ok(encrypted.iv, 'Debe existir IV');
  assert.ok(encrypted.tag, 'Debe existir AuthTag');
  assert.equal(encrypted.iv.length, 24, 'IV debe ser de 12 bytes en hex (24 chars)');
  assert.equal(encrypted.tag.length, 32, 'Tag debe ser de 16 bytes en hex (32 chars)');

  // Descifrado exitoso
  const decrypted = decryptSecret(encrypted.cipherText, encrypted.iv, encrypted.tag);
  assert.equal(decrypted, originalSecret, 'El texto descifrado debe coincidir exactamente con el original');
});

test('T-02: AES-256-GCM Falla ante manipulación de datos (Integridad AppSec)', () => {
  const originalSecret = 'secret_data';
  const encrypted = encryptSecret(originalSecret);

  // Alterar un byte del ciphertext asegurando que sea diferente
  const firstCipherByte = encrypted.cipherText.slice(0, 2);
  const tamperedCipher = (firstCipherByte === '00' ? 'ff' : '00') + encrypted.cipherText.slice(2);
  assert.throws(() => {
    decryptSecret(tamperedCipher, encrypted.iv, encrypted.tag);
  }, /unable to authenticate data/i, 'Debe rechazar ciphertext alterado');

  // Alterar un byte del auth tag asegurando que sea diferente
  const firstTagByte = encrypted.tag.slice(0, 2);
  const tamperedTag = (firstTagByte === 'ff' ? '00' : 'ff') + encrypted.tag.slice(2);
  assert.throws(() => {
    decryptSecret(encrypted.cipherText, encrypted.iv, tamperedTag);
  }, /unable to authenticate data/i, 'Debe rechazar auth tag alterado');
});

test('T-02: HMAC-SHA256 Validación de firma de Webhook en tiempo constante', () => {
  const rawBody = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '123' }] }));
  const appSecret = 'my_meta_app_secret_999';

  const hash = calculateHmacSha256(rawBody, appSecret);
  const signatureHeader = `sha256=${hash}`;

  // Verificación exitosa
  assert.equal(verifyHmacSha256(rawBody, signatureHeader, appSecret), true);

  // Firma inválida o cuerpo alterado
  const tamperedBody = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '999' }] }));
  assert.equal(verifyHmacSha256(tamperedBody, signatureHeader, appSecret), false);

  // Firma corrupta
  assert.equal(verifyHmacSha256(rawBody, 'sha256=invalidhash123', appSecret), false);
});
