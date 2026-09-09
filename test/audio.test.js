import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaService } from '../src/services/media.service.js';

/**
 * Las notas de voz fallaban con un error confuso de Meta:
 *
 *   "Audio file uploaded with mimetype as audio/mp4, however on processing it
 *    is of type application/octet-stream."
 *
 * La causa: Meta verifica el contenido real del archivo, no lo que uno declara.
 * Lo que graba el navegador (WebM en Chrome, MP4 en Safari y en el iPhone) es un
 * archivo pensado para reproducirse mientras se graba, y Meta no lo reconoce.
 *
 * Estas pruebas fijan qué se reconvierte y qué pasa derecho, porque acertarle a
 * esa lista es la diferencia entre que la nota de voz salga o no.
 */

test('T-17: los audios grabados por el navegador siempre se reconvierten', () => {
  // Chrome y Edge
  assert.equal(mediaService.necesitaConversionDeAudio('.webm', 'audio/webm'), true);
  // Safari y iPhone: este era el caso que fallaba en producción
  assert.equal(mediaService.necesitaConversionDeAudio('.m4a', 'audio/mp4'), true);
  assert.equal(mediaService.necesitaConversionDeAudio('.mp4', 'audio/mp4'), true);
  // Sin comprimir
  assert.equal(mediaService.necesitaConversionDeAudio('.wav', 'audio/wav'), true);
});

test('T-17: los formatos que Meta ya acepta pasan derecho', () => {
  assert.equal(mediaService.necesitaConversionDeAudio('.ogg', 'audio/ogg'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.opus', 'audio/ogg'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.mp3', 'audio/mpeg'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.amr', 'audio/amr'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.aac', 'audio/aac'), false);
});

test('T-17: lo que no es audio no se toca', () => {
  assert.equal(mediaService.necesitaConversionDeAudio('.jpg', 'image/jpeg'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.pdf', 'application/pdf'), false);
  assert.equal(mediaService.necesitaConversionDeAudio('.mp4', 'video/mp4'), true,
    'Un .mp4 puede ser una nota de voz; se reconvierte y el audio se conserva igual');
  assert.equal(mediaService.necesitaConversionDeAudio('.mov', 'video/quicktime'), false);
});

test('T-17: un audio sin extensión reconocible se decide por su tipo MIME', () => {
  assert.equal(mediaService.necesitaConversionDeAudio('', 'audio/webm'), true);
  assert.equal(mediaService.necesitaConversionDeAudio('.bin', 'audio/x-raro'), true);
  assert.equal(mediaService.necesitaConversionDeAudio('', ''), false);
});
