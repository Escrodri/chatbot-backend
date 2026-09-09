import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { storageService } from './storage.service.js';

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
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/webm': '.webm',
  'audio/webm; codecs=opus': '.webm',
  'image/jpeg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/jfif': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
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
   * Guarda un archivo multimedia enviado desde el cliente en base64.
   */
  saveBase64Media({ fileBase64, fileName, mimeType }) {
    this.ensureUploadsDir();

    const base64Data = fileBase64.replace(/^data:([A-Za-z-+\/]+);base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`El archivo supera el límite máximo permitido de 25MB.`);
    }

    const cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();
    const origExt = path.extname(fileName || '').toLowerCase();
    const ext = origExt || MIME_EXTENSION_MAP[cleanMime] || '.bin';

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const finalFileName = `${Date.now()}_${fileHash}${ext}`;
    const filePath = path.join(UPLOADS_DIR, finalFileName);

    fs.writeFileSync(filePath, buffer);

    let contentType = 'document';
    if (cleanMime.startsWith('image/')) contentType = 'image';
    else if (cleanMime.startsWith('audio/')) contentType = 'audio';
    else if (cleanMime.startsWith('video/')) contentType = 'video';
    else if (['.mp3', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.webm'].includes(ext)) contentType = 'audio';
    else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) contentType = 'image';
    else if (['.mp4', '.mov', '.3gp'].includes(ext)) contentType = 'video';

    return {
      localUrl: `/uploads/media/${finalFileName}`,
      filePath,
      mimeType: cleanMime,
      fileSize: buffer.length,
      contentType,
      fileName: fileName || finalFileName
    };
  },

  /**
   * Sube una copia del archivo al almacenamiento externo, si está configurado.
   *
   * Devuelve el mismo objeto pero con `localUrl` apuntando a la dirección
   * pública, que es la que se guarda en la base de datos. Así el archivo
   * sobrevive a los despliegues y Meta puede descargarlo cuando lo enviamos.
   *
   * Si no hay almacenamiento externo o la subida falla, devuelve el objeto tal
   * cual y todo sigue funcionando contra el disco local.
   *
   * @param {object|null} guardado Resultado de saveBase64Media o downloadMedia
   * @returns {Promise<object|null>}
   */
  async respaldar(guardado) {
    if (!guardado?.filePath) return guardado;

    const remoto = await storageService.subirArchivo({
      filePath: guardado.filePath,
      mimeType: guardado.mimeType,
      fileName: guardado.fileName
    });

    if (!remoto) return guardado;

    return {
      ...guardado,
      localUrl: remoto.url,
      rutaLocal: guardado.localUrl,
      remoteUrl: remoto.url,
      publicId: remoto.publicId
    };
  },

  /**
   * Descarga un archivo multimedia de WhatsApp mediante su mediaId o URL directa.
   * 
   * @param {{ mediaId?: string, accessToken: string, directUrl?: string, mimeType?: string }} params
   * @returns {Promise<{ localUrl: string, filePath: string, mimeType: string, fileSize: number }>}
   */
  async downloadMedia({ mediaId, accessToken, directUrl = null, mimeType: initialMime = null }) {
    this.ensureUploadsDir();

    const apiVersion = config.meta.apiVersion || 'v26.0';
    let downloadUrl = directUrl;
    let mimeType = initialMime || 'application/octet-stream';

    // 1. Si no se proveyó directUrl o para obtener la URL firmada oficial, consultar Meta Graph API
    if (!downloadUrl && mediaId) {
      const metaUrlRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!metaUrlRes.ok) {
        throw new Error(`Error al obtener URL del medio ${mediaId}: HTTP ${metaUrlRes.status}`);
      }

      const metaData = await metaUrlRes.json();
      downloadUrl = metaData.url;
      mimeType = metaData.mime_type || mimeType;

      if (metaData.file_size && metaData.file_size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`El archivo supera el límite máximo permitido de 25MB (Tamaño: ${metaData.file_size} bytes).`);
      }
    }

    if (!downloadUrl) {
      throw new Error(`No se proporcionó ni directUrl ni mediaId válido para descargar.`);
    }

    // 2. Descargar el binario del archivo
    const fileRes = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'WhatsApp-CRM-Client/1.0'
      }
    });

    if (!fileRes.ok) {
      // Si la URL directa falló, reintentar con Graph API si tenemos mediaId
      if (directUrl && mediaId) {
        return this.downloadMedia({ mediaId, accessToken });
      }
      throw new Error(`Error descargando binario de ${downloadUrl}: HTTP ${fileRes.status}`);
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`El archivo descargado supera el límite de 25MB.`);
    }

    // 3. Determinar extensión segura y generar nombre único por hash
    const cleanMime = mimeType.split(';')[0].trim().toLowerCase();
    const extension = MIME_EXTENSION_MAP[cleanMime] || MIME_EXTENSION_MAP[mimeType] || '.bin';
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    const fileName = `${Date.now()}_${fileHash}${extension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    // 4. Guardar en disco
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
