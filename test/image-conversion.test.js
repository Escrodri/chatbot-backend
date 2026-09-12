import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mediaService } from '../src/services/media.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('T-25: Transcodificación de formatos de imagen no soportados por Meta (WebP -> JPEG)', () => {
  test('necesitaConversionDeImagen detecta correctamente WebP, BMP, JFIF y formatos no admitidos', () => {
    // Formatos que Meta acepta sin conversión
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.jpg', 'image/jpeg'), false);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.jpeg', 'image/jpeg'), false);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.png', 'image/png'), false);

    // Formatos que Meta rechaza con error 100
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.webp', 'image/webp'), true);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.jfif', 'image/jfif'), true);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.bmp', 'image/bmp'), true);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.tiff', 'image/tiff'), true);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('.svg', 'image/svg+xml'), true);
    assert.strictEqual(mediaService.necesitaConversionDeImagen('', 'image/webp'), true);
  });

  test('convertirImagenAJpeg convierte un WebP binario a JPEG válido usando FFmpeg', async () => {
    // 1x1 WebP válido en base64
    const base64Webp = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const tempIn = path.join(__dirname, 'temp_test.webp');
    const tempOut = path.join(__dirname, 'temp_test.jpg');

    fs.writeFileSync(tempIn, Buffer.from(base64Webp, 'base64'));

    try {
      const resultPath = await mediaService.convertirImagenAJpeg(tempIn, tempOut);
      assert.strictEqual(resultPath, tempOut);
      assert.strictEqual(fs.existsSync(tempOut), true);

      // Comprobar que el archivo resultante tiene firma de JPEG (FF D8)
      const buffer = fs.readFileSync(tempOut);
      assert.ok(buffer.length > 0);
      assert.strictEqual(buffer[0], 0xff);
      assert.strictEqual(buffer[1], 0xd8);
    } finally {
      try { fs.unlinkSync(tempIn); } catch {}
      try { fs.unlinkSync(tempOut); } catch {}
    }
  });
});
