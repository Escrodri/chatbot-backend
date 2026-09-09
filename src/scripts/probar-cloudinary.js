/**
 * Comprueba que el almacenamiento externo de archivos esté bien configurado.
 *
 *   npm run probar-cloudinary
 *
 * Sube una imagen mínima de un píxel a la cuenta configurada en el .env y
 * muestra la dirección resultante. Si algo está mal, dice exactamente qué.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config/index.js';
import { storageService } from '../services/storage.service.js';

// PNG transparente de 1x1 píxel.
const PIXEL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  console.log('🔎 Comprobando la configuración del almacenamiento de archivos...\n');

  const c = config.cloudinary || {};
  const faltan = [];
  if (!c.cloudName) faltan.push('CLOUDINARY_CLOUD_NAME');
  if (!c.apiKey) faltan.push('CLOUDINARY_API_KEY');
  if (!c.apiSecret) faltan.push('CLOUDINARY_API_SECRET');

  if (faltan.length > 0) {
    console.error('❌ Faltan estas variables de entorno:');
    faltan.forEach(v => console.error(`   - ${v}`));
    console.error('\nSin ellas los archivos se guardan solo en el disco del servidor,');
    console.error('así que desaparecen en cada despliegue.');
    process.exit(1);
  }

  console.log(`   Cuenta:  ${c.cloudName}`);
  console.log(`   Carpeta: ${c.folder}\n`);

  const rutaTemporal = path.join(os.tmpdir(), `prueba-almacenamiento-${Date.now()}.png`);
  fs.writeFileSync(rutaTemporal, Buffer.from(PIXEL_BASE64, 'base64'));

  const resultado = await storageService.subirArchivo({
    filePath: rutaTemporal,
    mimeType: 'image/png',
    fileName: 'prueba.png'
  });

  fs.unlinkSync(rutaTemporal);

  if (!resultado) {
    console.error('\n❌ La subida falló. El motivo aparece en el aviso de arriba.');
    console.error('   Lo más común es que la clave o el secreto estén mal copiados.');
    process.exit(1);
  }

  console.log('\n✅ Todo funciona. La imagen de prueba quedó en:');
  console.log(`   ${resultado.url}\n`);
  console.log('Podés borrarla desde el panel de Cloudinary cuando quieras.');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Error inesperado:', err.message);
  process.exit(1);
});
