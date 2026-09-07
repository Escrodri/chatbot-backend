import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/media');
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

// Mapeo seguro de MIME types a extensiones
const MIME_EXTENSION_MAP = {
  'audio/ogg': '.ogg',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

/**
 * Servicio de Descarga de Medios Efímeros de Meta (WhatsApp Cloud API):
 * Las URLs de medios de WhatsApp expiran en 5 minutos.
 * Este servicio descarga inmediatamente el binario y lo almacena localmente.
 */
export const mediaService = {
  /**
   * Asegura que el directorio de almacenamiento exista.
   */
  ensureUploadsDir() {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  },

  /**
   * Descarga un archivo multimedia de WhatsApp mediante su mediaId.
   * 
   * @param {{ mediaId: string, accessToken: string }} params
   * @returns {Promise<{ localUrl: string, filePath: string, mimeType: string, fileSize: number }>}
   */
  async downloadMedia({ mediaId, accessToken }) {
    this.ensureUploadsDir();

    const apiVersion = config.meta.apiVersion || 'v21.0';

    // 1. Obtener la URL efímera de descarga desde Meta
    const metaUrlRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!metaUrlRes.ok) {
      throw new Error(`Error al obtener URL del medio ${mediaId}: HTTP ${metaUrlRes.status}`);
    }

    const metaData = await metaUrlRes.json();
    const downloadUrl = metaData.url;
    const mimeType = metaData.mime_type || 'application/octet-stream';

    // 2. Validar tamaño reportado por Meta
    if (metaData.file_size && metaData.file_size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`El archivo supera el límite máximo permitido de 25MB (Tamaño: ${metaData.file_size} bytes).`);
    }

    // 3. Descargar el binario del archivo
    const fileRes = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'WhatsApp-CRM-Client/1.0'
      }
    });

    if (!fileRes.ok) {
      throw new Error(`Error descargando binario de ${downloadUrl}: HTTP ${fileRes.status}`);
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`El archivo descargado supera el límite de 25MB.`);
    }

    // 4. Determinar extensión segura y generar nombre único por hash
    const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
    const extension = MIME_EXTENSION_MAP[cleanMime] || MIME_EXTENSION_MAP[mimeType] || '.bin';
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const fileName = `${Date.now()}_${fileHash}${extension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // 5. Guardar en disco
    fs.writeFileSync(filePath, buffer);

    return {
      localUrl: `/uploads/media/${fileName}`,
      filePath,
      mimeType,
      fileSize: buffer.length
    };
  }
};

export default mediaService;
