import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
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
   * ¿Este archivo es un audio que hay que reconvertir antes de mandarlo a Meta?
   *
   * Pasan derecho solo los formatos que Meta reconoce y que no salen de una
   * grabación del navegador. Todo lo demás se reconvierte, porque Meta mira el
   * contenido real del archivo y no lo que uno le declara.
   *
   * @param {string} ext Extensión con punto, en minúsculas
   * @param {string} mime Tipo MIME sin parámetros, en minúsculas
   * @returns {boolean}
   */
  necesitaConversionDeAudio(ext = '', mime = '') {
    const YA_SIRVEN = ['.ogg', '.opus', '.mp3', '.amr', '.aac'];
    const EXTENSIONES_DE_AUDIO = ['.webm', '.m4a', '.mp4', '.wav', '.ogg', '.opus', '.mp3', '.aac', '.amr'];

    const esAudio = String(mime).startsWith('audio/') || EXTENSIONES_DE_AUDIO.includes(ext);
    return esAudio && !YA_SIRVEN.includes(ext);
  },

  /**
   * ¿Este archivo es una imagen que hay que reconvertir antes de mandarlo a Meta?
   *
   * Meta (WhatsApp Cloud API, Instagram Direct y Facebook Messenger) solo acepta
   * de forma garantizada image/jpeg e image/png para imágenes.
   * Formatos como WebP, JFIF, BMP, TIFF, SVG, etc. son rechazados por Meta con:
   * "Param messages[0][image][link] has unexpected mime type: image/webp".
   * Por eso se convierten automáticamente a JPEG de alta calidad usando FFmpeg.
   *
   * @param {string} ext Extensión con punto, en minúsculas
   * @param {string} mime Tipo MIME sin parámetros, en minúsculas
   * @returns {boolean}
   */
  necesitaConversionDeImagen(ext = '', mime = '') {
    const YA_SIRVEN = ['.jpg', '.jpeg', '.png'];
    const EXTENSIONES_IMAGEN = ['.webp', '.jfif', '.bmp', '.tiff', '.tif', '.svg', '.gif', '.heic', '.heif', '.avif', '.jpg', '.jpeg', '.png'];

    const cleanMime = String(mime).toLowerCase();
    const cleanExt = String(ext).toLowerCase();
    const esImagen = cleanMime.startsWith('image/') || EXTENSIONES_IMAGEN.includes(cleanExt);
    return esImagen && !YA_SIRVEN.includes(cleanExt) && cleanMime !== 'image/png' && cleanMime !== 'image/jpeg';
  },

  /**
   * Convierte cualquier imagen (WebP, BMP, TIFF, JFIF, etc.) a JPEG de alta calidad con FFmpeg.
   */
  async convertirImagenAJpeg(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        if (process.platform !== 'win32' && ffmpeg.path && fs.existsSync(ffmpeg.path)) {
          fs.chmodSync(ffmpeg.path, 0o755);
        }
      } catch {}

      // ffmpeg -i input.webp -q:v 2 -y output.jpg
      const args = ['-i', inputPath, '-q:v', '2', '-y', outputPath];
      execFile(ffmpeg.path, args, (err, stdout, stderr) => {
        if (err) {
          console.error('❌ [FFMPEG IMAGE TRANSCODE ERROR]:', stderr || err.message);
          return reject(err);
        }
        resolve(outputPath);
      });
    });
  },

  /**
   * Convierte cualquier audio a OGG con códec Opus mono usando FFmpeg.
   *
   * Meta acepta muy pocos formatos para notas de voz y, sobre todo, verifica el
   * contenido real del archivo, no lo que uno le declara. Lo que graba el
   * navegador —WebM en Chrome, MP4 en Safari y en el iPhone— sale como un
   * archivo pensado para reproducirse mientras se graba, y al procesarlo Meta
   * no lo reconoce: responde que es "application/octet-stream" y lo rechaza.
   *
   * Por eso se reconvierte todo a Ogg Opus, que es el formato nativo de las
   * notas de voz de WhatsApp, en vez de confiar en lo que mandó el navegador.
   */
  async convertirAudioAOggOpus(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      try {
        if (process.platform !== 'win32' && ffmpeg.path && fs.existsSync(ffmpeg.path)) {
          fs.chmodSync(ffmpeg.path, 0o755);
        }
      } catch {}

      // ffmpeg -i input.webm -c:a libopus -b:a 64k -ac 1 -y output.ogg
      const args = ['-i', inputPath, '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-y', outputPath];
      execFile(ffmpeg.path, args, (err, stdout, stderr) => {
        if (err) {
          console.error('❌ [FFMPEG AUDIO TRANSCODE ERROR]:', stderr || err.message);
          return reject(err);
        }
        resolve(outputPath);
      });
    });
  },

  /**
   * Obtiene la ruta física absoluta de un archivo local en /uploads/media/
   */
  resolveLocalPath(localUrl) {
    if (!localUrl || typeof localUrl !== 'string') return null;
    const match = localUrl.match(/^\/uploads\/media\/([a-zA-Z0-9_.\-]+)$/);
    if (!match) return null;
    const safeName = path.basename(match[1]);
    const fullPath = path.join(UPLOADS_DIR, safeName);
    return fs.existsSync(fullPath) ? fullPath : null;
  },

  /**
   * Guarda un archivo multimedia enviado desde el cliente en base64.
   */
  async saveBase64Media({ fileBase64, fileName, mimeType }) {
    this.ensureUploadsDir();

    // Extraer limpiamente los datos base64 eliminando el prefijo data:...;base64,
    // garantizando soporte para tipos MIME con parámetros como audio/webm;codecs=opus
    const base64Data = fileBase64.includes(';base64,')
      ? fileBase64.slice(fileBase64.indexOf(';base64,') + 8)
      : fileBase64;
    const buffer = Buffer.from(base64Data.trim(), 'base64');

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(`El archivo supera el límite máximo permitido de 25MB.`);
    }

    let cleanMime = (mimeType || '').split(';')[0].trim().toLowerCase();
    let origExt = path.extname(fileName || '').toLowerCase();
    let ext = origExt || MIME_EXTENSION_MAP[cleanMime] || '.bin';

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
    let finalFileName = `${Date.now()}_${fileHash}${ext}`;
    let filePath = path.join(UPLOADS_DIR, finalFileName);

    fs.writeFileSync(filePath, buffer);

    // Toda nota de voz se reconvierte a Ogg Opus antes de salir.
    //
    // No alcanza con mirar si es WebM: Safari y el iPhone graban en MP4, y ese
    // MP4 de grabación en vivo tampoco lo acepta Meta —dice que al procesarlo
    // le da "application/octet-stream"—. Los únicos que pasan derecho son los
    // formatos que Meta ya reconoce y que no vienen de una grabación del
    // navegador.
    if (this.necesitaConversionDeAudio(ext, cleanMime)) {
      try {
        const convertedFileName = `${Date.now()}_${fileHash}.ogg`;
        const convertedFilePath = path.join(UPLOADS_DIR, convertedFileName);
        await this.convertirAudioAOggOpus(filePath, convertedFilePath);

        try { fs.unlinkSync(filePath); } catch {}

        console.log(`🎙️ [AUDIO] Nota de voz convertida de ${ext || cleanMime} a Ogg Opus.`);

        finalFileName = convertedFileName;
        filePath = convertedFilePath;
        ext = '.ogg';
        cleanMime = 'audio/ogg';
        fileName = (fileName || 'nota_de_voz').replace(/\.[a-z0-9]+$/i, '') + '.ogg';
      } catch (convErr) {
        console.error(
          `❌ [AUDIO] No se pudo convertir la nota de voz a Ogg Opus: ${convErr.message}. ` +
          'Meta va a rechazar el envío.'
        );
      }
    }

    // Meta (WhatsApp Cloud API, Instagram, Messenger) solo acepta de forma garantizada image/jpeg e image/png.
    // Formatos como WebP, JFIF, BMP, TIFF, SVG, etc., son rechazados por Meta con error #100.
    // Los convertimos automáticamente a JPEG de alta calidad con FFmpeg.
    if (this.necesitaConversionDeImagen(ext, cleanMime)) {
      try {
        const convertedFileName = `${Date.now()}_${fileHash}.jpg`;
        const convertedFilePath = path.join(UPLOADS_DIR, convertedFileName);
        await this.convertirImagenAJpeg(filePath, convertedFilePath);

        try { fs.unlinkSync(filePath); } catch {}

        console.log(`🖼️ [IMAGEN] Imagen convertida de ${ext || cleanMime} a JPEG de alta calidad.`);

        finalFileName = convertedFileName;
        filePath = convertedFilePath;
        ext = '.jpg';
        cleanMime = 'image/jpeg';
        fileName = (fileName || 'imagen').replace(/\.[a-z0-9]+$/i, '') + '.jpg';
      } catch (convErr) {
        console.error(
          `❌ [IMAGEN] No se pudo convertir la imagen a JPEG: ${convErr.message}. ` +
          'Se intentará enviar el archivo original.'
        );
      }
    }

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
      fileSize: fs.existsSync(filePath) ? fs.statSync(filePath).size : buffer.length,
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
