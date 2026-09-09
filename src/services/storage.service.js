import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * Almacenamiento externo de archivos (Cloudinary).
 *
 * Por qué existe: el disco del servidor se borra en cada despliegue, así que
 * una foto guardada solo ahí desaparece. Además Meta necesita una dirección
 * pública y estable para poder descargar los archivos que enviamos nosotros.
 *
 * Es opcional. Si no hay credenciales configuradas, todo sigue funcionando
 * contra el disco local como antes; simplemente no sobrevive a los despliegues.
 *
 * No usa la librería oficial a propósito: una petición firmada con fetch evita
 * sumar una dependencia más al proyecto.
 */

const API_BASE = 'https://api.cloudinary.com/v1_1';

/** Límites del plan gratuito de Cloudinary. */
const LIMITE_IMAGEN = 10 * 1024 * 1024;   // 10 MB
const LIMITE_VIDEO = 100 * 1024 * 1024;   // 100 MB

export const storageService = {
  /** ¿Hay credenciales completas para usar el almacenamiento externo? */
  estaConfigurado() {
    const c = config.cloudinary || {};
    return Boolean(c.cloudName && c.apiKey && c.apiSecret);
  },

  /**
   * Firma los parámetros como pide Cloudinary: los ordena alfabéticamente,
   * los concatena y les aplica SHA-1 junto con el secreto de la cuenta.
   */
  _firmar(params) {
    const cadena = Object.keys(params)
      .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');

    return crypto
      .createHash('sha1')
      .update(cadena + config.cloudinary.apiSecret)
      .digest('hex');
  },

  /** Qué tipo de recurso declarar en Cloudinary según el tipo de archivo. */
  _tipoDeRecurso(mimeType = '') {
    const m = String(mimeType).toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/') || m.startsWith('audio/')) return 'video'; // el audio va como video en Cloudinary
    return 'raw';
  },

  /**
   * Sube un archivo ya guardado en disco y devuelve su dirección pública.
   *
   * Nunca lanza: si algo falla, devuelve null y el archivo se sigue sirviendo
   * desde el disco local. Un problema de almacenamiento no debe impedir que un
   * mensaje llegue.
   *
   * @param {{ filePath: string, mimeType?: string, fileName?: string }} params
   * @returns {Promise<{ url: string, publicId: string, resourceType: string }|null>}
   */
  async subirArchivo({ filePath, mimeType = '', fileName = '' }) {
    if (!this.estaConfigurado()) return null;

    try {
      if (!filePath || !fs.existsSync(filePath)) {
        console.warn('⚠️ [STORAGE] No se encontró el archivo a subir:', filePath);
        return null;
      }

      const buffer = fs.readFileSync(filePath);
      const resourceType = this._tipoDeRecurso(mimeType);
      const limite = resourceType === 'video' ? LIMITE_VIDEO : LIMITE_IMAGEN;

      if (buffer.length > limite) {
        console.warn(
          `⚠️ [STORAGE] "${fileName || path.basename(filePath)}" pesa ${Math.round(buffer.length / 1024 / 1024)}MB ` +
          `y supera el límite de Cloudinary para este tipo de archivo. Se deja solo en el disco local.`
        );
        return null;
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const carpeta = config.cloudinary.folder;
      const firmables = { folder: carpeta, timestamp };

      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), path.basename(filePath));
      form.append('api_key', config.cloudinary.apiKey);
      form.append('timestamp', String(timestamp));
      form.append('folder', carpeta);
      form.append('signature', this._firmar(firmables));

      const url = `${API_BASE}/${config.cloudinary.cloudName}/${resourceType}/upload`;
      const res = await fetch(url, { method: 'POST', body: form });
      const datos = await res.json().catch(() => ({}));

      if (!res.ok || !datos.secure_url) {
        console.warn('⚠️ [STORAGE] Cloudinary rechazó la subida:', datos?.error?.message || `HTTP ${res.status}`);
        return null;
      }

      console.log(`☁️  [STORAGE] Archivo guardado en Cloudinary: ${datos.secure_url}`);
      return {
        url: datos.secure_url,
        publicId: datos.public_id,
        resourceType
      };
    } catch (error) {
      console.warn('⚠️ [STORAGE] Error al subir el archivo a Cloudinary:', error.message);
      return null;
    }
  }
};

export default storageService;
