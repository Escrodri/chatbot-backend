import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { messageRepository } from '../repositories/message.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { mediaService } from '../services/media.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/media');

/**
 * Entrega de archivos multimedia.
 *
 * A diferencia de servir /uploads como carpeta pública, acá:
 *
 * 1. Se exige sesión y se respeta el aislamiento por canal, igual que en el
 *    resto de la bandeja. Las fotos que manda un cliente son tan privadas
 *    como el texto de su mensaje.
 * 2. El disco es solo una caché. Si el archivo no está —porque el hosting
 *    borró el disco en un despliegue— se le vuelve a pedir a Meta usando el
 *    identificador que guardamos, se guarda de nuevo y se entrega.
 *
 * Así los medios sobreviven a los despliegues sin depender de almacenamiento
 * pago ni de un servicio externo.
 */
export const mediaController = {
  /**
   * GET /api/media/:messageId
   */
  async serve(req, res) {
    try {
      const messageId = parseInt(req.params.messageId, 10);
      if (isNaN(messageId)) {
        return res.status(400).json({ error: 'Identificador de mensaje inválido' });
      }

      const mensaje = await messageRepository.findByIdWithChannel(messageId);
      if (!mensaje) {
        return res.status(404).json({ error: 'Mensaje no encontrado' });
      }

      // Aislamiento por canal: un operador solo ve los medios de sus canales.
      if (req.user.role === 'agent') {
        const asignados = await userRepository.getAssignedChannelIds(req.user.id);
        if (!asignados.includes(mensaje.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      // 1. ¿Está en la caché local?
      const nombreCache = mensaje.media_url ? path.basename(mensaje.media_url) : null;
      if (nombreCache) {
        const rutaCache = path.join(UPLOADS_DIR, nombreCache);
        // path.basename evita que un nombre malicioso escape del directorio.
        if (rutaCache.startsWith(UPLOADS_DIR) && fs.existsSync(rutaCache)) {
          if (mensaje.media_mime) res.setHeader('Content-Type', mensaje.media_mime);
          res.setHeader('Cache-Control', 'private, max-age=86400');
          return res.sendFile(rutaCache);
        }
      }

      // 2. No está: se la pedimos a Meta de nuevo.
      if (!mensaje.meta_media_id) {
        return res.status(404).json({
          error: 'El archivo ya no está disponible y no quedó registrado su identificador en Meta.',
          code: 'ERR_MEDIA_GONE'
        });
      }

      const canal = await channelRepository.findById(mensaje.channel_id);
      const token = canal?.accessToken;

      if (!token) {
        return res.status(409).json({
          error: 'El canal de este mensaje no tiene un token válido para recuperar el archivo.',
          code: 'ERR_CHANNEL_TOKEN_MISSING'
        });
      }

      let descargado;
      try {
        descargado = await mediaService.downloadMedia({
          mediaId: mensaje.meta_media_id,
          accessToken: token,
          mimeType: mensaje.media_mime
        });
      } catch (err) {
        console.warn(`⚠️ [MEDIA] No se pudo recuperar el medio ${mensaje.meta_media_id} de Meta:`, err.message);
        return res.status(404).json({
          error: 'Meta ya no conserva este archivo. Los medios se guardan por tiempo limitado.',
          code: 'ERR_MEDIA_EXPIRED'
        });
      }

      // Actualizamos la caché para no volver a pedirlo la próxima vez.
      if (descargado?.localUrl && descargado.localUrl !== mensaje.media_url) {
        await messageRepository.updateMediaUrl(messageId, descargado.localUrl);
      }

      if (descargado?.mimeType) res.setHeader('Content-Type', descargado.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.sendFile(descargado.filePath);
    } catch (error) {
      console.error('❌ [MEDIA] Error al entregar el archivo:', error);
      return res.status(500).json({ error: 'Error al entregar el archivo: ' + error.message });
    }
  }
};

export default mediaController;
