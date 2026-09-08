import { query } from '../database/index.js';
import { encryptSecret, decryptSecret } from '../utils/index.js';

/**
 * Repositorio de Canales: CRUD de cuentas de Meta (WhatsApp, Facebook, Instagram)
 * Implementa cifrado simétrico AES-256-GCM transparente para credenciales en reposo.
 */
export const channelRepository = {
  /**
   * Crea un nuevo canal en la base de datos cifrando automáticamente tokens y secretos.
   * 
   * @param {{ platform: string, name: string, channelIdentifier: string, appId?: string, appSecret?: string, accessToken: string, colorTag?: string }} data
   * @returns {Promise<object>}
   */
  async create({ platform, name, channelIdentifier, appId = null, appSecret = null, accessToken, colorTag = '#25D366' }) {
    // 1. Cifrar Access Token con AES-256-GCM
    const encryptedToken = encryptSecret(accessToken);

    // 2. Cifrar App Secret si fue provisto
    let encryptedSecretJson = null;
    if (appSecret) {
      const encryptedAppSecret = encryptSecret(appSecret);
      encryptedSecretJson = JSON.stringify(encryptedAppSecret);
    }

    const { rows } = await query(
      `INSERT INTO channels (
         platform, name, channel_identifier, app_id, 
         app_secret_encrypted, access_token_encrypted, token_iv, token_tag, color_tag
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, platform, name, channel_identifier, app_id, color_tag, status, created_at, updated_at`,
      [
        platform,
        name.trim(),
        channelIdentifier.trim(),
        appId ? appId.trim() : null,
        encryptedSecretJson,
        encryptedToken.cipherText,
        encryptedToken.iv,
        encryptedToken.tag,
        colorTag
      ]
    );

    return rows[0];
  },

  /**
   * Busca un canal por su identificador único (phone_number_id o page_id) y descifra sus secretos en memoria.
   * 
   * @param {string} identifier phone_number_id (WA) o page_id (FB/IG)
   * @returns {Promise<object|null>} Canal con access_token y app_secret en texto plano descifrado
   */
  async findByIdentifier(identifier) {
    const { rows } = await query(
      `SELECT * FROM channels WHERE channel_identifier = $1`,
      [identifier.trim()]
    );

    if (rows.length === 0) return null;
    return this._decryptChannelSecrets(rows[0]);
  },

  /**
   * Busca un canal por su ID interno y descifra sus secretos en memoria.
   * 
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT * FROM channels WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) return null;
    return this._decryptChannelSecrets(rows[0]);
  },

  /**
   * Lista todos los canales activos para la interfaz.
   * OMITIR estrictamente tokens cifrados y tags de autenticación para evitar fugas.
   * 
   * @returns {Promise<Array>}
   */
  async listAll() {
    const { rows } = await query(
      `SELECT id, platform, name, channel_identifier, app_id, color_tag, status, error_message, created_at, updated_at 
       FROM channels 
       ORDER BY id ASC`
    );
    return rows;
  },

  /**
   * Actualiza los datos de un canal (nombre, color, estado, y opcionalmente nuevo token).
   * 
   * @param {number} id 
   * @param {{ name?: string, colorTag?: string, status?: 'active'|'error'|'paused', accessToken?: string }} data 
   * @returns {Promise<object|null>}
   */
  async update(id, { name, colorTag, status, accessToken } = {}) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (colorTag !== undefined) {
      fields.push(`color_tag = $${idx++}`);
      values.push(colorTag.trim());
    }
    if (status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(status);
    }
    if (accessToken) {
      const encryptedToken = encryptSecret(accessToken);
      fields.push(`access_token_encrypted = $${idx++}`);
      values.push(encryptedToken.cipherText);
      fields.push(`token_iv = $${idx++}`);
      values.push(encryptedToken.iv);
      fields.push(`token_tag = $${idx++}`);
      values.push(encryptedToken.tag);
    }

    if (fields.length === 0) {
      const { rows } = await query(
        `SELECT id, platform, name, channel_identifier, app_id, color_tag, status, error_message, created_at, updated_at 
         FROM channels WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const { rows } = await query(
      `UPDATE channels 
       SET ${fields.join(', ')} 
       WHERE id = $${idx}
       RETURNING id, platform, name, channel_identifier, app_id, color_tag, status, error_message, created_at, updated_at`,
      values
    );

    return rows[0] || null;
  },

  /**
   * Actualiza el estado de un canal (active, error, paused) y registra el mensaje de error si aplica.
   * 
   * @param {number} id
   * @param {'active'|'error'|'paused'} status
   * @param {string|null} errorMessage
   * @returns {Promise<void>}
   */
  async updateStatus(id, status, errorMessage = null) {
    await query(
      `UPDATE channels 
       SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      [status, errorMessage, id]
    );
  },

  /**
   * Elimina un canal por su ID.
   * @param {number} id
   * @returns {Promise<void>}
   */
  async deleteById(id) {
    await query('DELETE FROM channels WHERE id = $1', [id]);
  },

  /**
   * Helper privado para descifrar en memoria los secretos de un registro de canal.
   * @private
   */
  _decryptChannelSecrets(rawRow) {
    const channel = { ...rawRow };

    // 1. Descifrar Access Token
    if (channel.access_token_encrypted && channel.token_iv && channel.token_tag) {
      const decryptedToken = decryptSecret(
        channel.access_token_encrypted,
        channel.token_iv,
        channel.token_tag
      );
      channel.accessToken = decryptedToken;
      channel.access_token = decryptedToken;
    }

    // 2. Descifrar App Secret si existe
    if (channel.app_secret_encrypted) {
      try {
        const secObj = JSON.parse(channel.app_secret_encrypted);
        const decryptedSecret = decryptSecret(secObj.cipherText, secObj.iv, secObj.tag);
        channel.appSecret = decryptedSecret;
        channel.app_secret = decryptedSecret;
      } catch {
        channel.appSecret = null;
        channel.app_secret = null;
      }
    }

    // Limpiar campos de almacenamiento criptográfico crudo
    delete channel.access_token_encrypted;
    delete channel.app_secret_encrypted;
    delete channel.token_iv;
    delete channel.token_tag;

    return channel;
  }
};

export default channelRepository;
