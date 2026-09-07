import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { createApp } from '../src/app.js';
import { mediaService } from '../src/services/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('T-14: mediaService crea el directorio de uploads de forma defensiva', () => {
  mediaService.ensureUploadsDir();
  const dir = path.resolve(__dirname, '../uploads/media');
  assert.equal(fs.existsSync(dir), true, 'El directorio uploads/media debe existir');
});

test('T-14: Archivos en /uploads son servidos estáticamente por Express', async () => {
  const dir = path.resolve(__dirname, '../uploads/media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const testFileName = `test_${Date.now()}.txt`;
  const testFilePath = path.join(dir, testFileName);
  fs.writeFileSync(testFilePath, 'Contenido de audio/media binario simulado');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/uploads/media/${testFileName}`);
    assert.equal(res.status, 200);
    const content = await res.text();
    assert.equal(content, 'Contenido de audio/media binario simulado');
  } finally {
    server.close();
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
  }
});
