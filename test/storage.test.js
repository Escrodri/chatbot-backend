import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { storageService } from '../src/services/storage.service.js';
import { config } from '../src/config/index.js';

/**
 * La firma de Cloudinary es sensible al orden y al formato: si se arma mal, la
 * subida falla en silencio y los archivos se quedan solo en el disco. Estas
 * pruebas comprueban la construcción de la firma sin necesidad de red.
 */

/** Firma esperada, calculada de forma independiente siguiendo la regla de Cloudinary. */
function firmaEsperada(cadena, secreto) {
  return crypto.createHash('sha1').update(cadena + secreto).digest('hex');
}

test('T-14: la firma ordena los parámetros alfabéticamente y les agrega el secreto', () => {
  const secreto = config.cloudinary?.apiSecret || '';

  const firmada = storageService._firmar({ timestamp: 1700000000, folder: 'bandeja' });
  const esperada = firmaEsperada('folder=bandeja&timestamp=1700000000', secreto);

  assert.equal(firmada, esperada, 'Los parámetros deben ir ordenados por nombre');
});

test('T-14: los parámetros vacíos no entran en la firma', () => {
  const secreto = config.cloudinary?.apiSecret || '';

  const firmada = storageService._firmar({ timestamp: 123, folder: '', public_id: null });
  const esperada = firmaEsperada('timestamp=123', secreto);

  assert.equal(firmada, esperada, 'Un parámetro vacío no se envía y por lo tanto no se firma');
});

test('T-14: el tipo de recurso se elige según el tipo de archivo', () => {
  assert.equal(storageService._tipoDeRecurso('image/jpeg'), 'image');
  assert.equal(storageService._tipoDeRecurso('image/webp'), 'image');
  assert.equal(storageService._tipoDeRecurso('video/mp4'), 'video');
  // Cloudinary trata el audio dentro de la categoría de video.
  assert.equal(storageService._tipoDeRecurso('audio/ogg'), 'video');
  assert.equal(storageService._tipoDeRecurso('application/pdf'), 'raw');
  assert.equal(storageService._tipoDeRecurso(''), 'raw');
});

test('T-14: sin credenciales el almacenamiento externo se desactiva solo', async () => {
  if (storageService.estaConfigurado()) {
    // Con credenciales presentes no se prueba la red: alcanza con saber que se activó.
    assert.ok(true);
    return;
  }

  const resultado = await storageService.subirArchivo({ filePath: '/no/existe.png' });
  assert.equal(resultado, null, 'Sin credenciales debe devolver null y no romper el envío');
});
