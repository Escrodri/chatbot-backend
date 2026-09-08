import bcrypt from 'bcryptjs';
import { channelRepository } from '../repositories/channel.repository.js';
import { botRepository } from '../repositories/bot.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { logRepository } from '../repositories/log.repository.js';
import envConfig from '../config/env.config.js';

export const settingsController = {
  // ==========================================
  // CANALES
  // ==========================================

  /**
   * Obtiene la lista de canales registrados (sin tokens ni secretos expuestos).
   */
  async getChannels(req, res) {
    try {
      const channels = await channelRepository.listAll();
      return res.json(channels);
    } catch (error) {
      return res.status(500).json({ error: 'Error al obtener los canales: ' + error.message });
    }
  },

  /**
   * Da de alta un nuevo canal cifrando credenciales con AES-256-GCM.
   */
  async createChannel(req, res) {
    try {
      const { platform, name, channelIdentifier, appId, appSecret, accessToken, colorTag } = req.body;

      if (!platform || !['whatsapp', 'facebook', 'instagram'].includes(platform)) {
        return res.status(400).json({ error: 'Plataforma inválida. Debe ser whatsapp, facebook o instagram' });
      }

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'El nombre del canal es obligatorio' });
      }

      if (!channelIdentifier || !channelIdentifier.trim()) {
        return res.status(400).json({ error: 'El identificador del canal (phone_number_id o page_id) es obligatorio' });
      }

      if (!accessToken || !accessToken.trim()) {
        return res.status(400).json({ error: 'El token de acceso de Meta Graph API es obligatorio' });
      }

      // Verificar si el identificador ya existe
      const existing = await channelRepository.findByIdentifier(channelIdentifier.trim());
      if (existing) {
        return res.status(409).json({ error: 'Ya existe un canal configurado con ese identificador' });
      }

      const newChannel = await channelRepository.create({
        platform,
        name: name.trim(),
        channelIdentifier: channelIdentifier.trim(),
        appId: appId ? appId.trim() : null,
        appSecret: appSecret ? appSecret.trim() : null,
        accessToken: accessToken.trim(),
        colorTag: colorTag || '#D4AF37'
      });

      return res.status(201).json(newChannel);
    } catch (error) {
      return res.status(500).json({ error: 'Error al registrar el canal: ' + error.message });
    }
  },

  /**
   * Actualiza los datos de un canal existente.
   */
  async updateChannel(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de canal inválido' });
      }

      const channel = await channelRepository.findById(id);
      if (!channel) {
        return res.status(404).json({ error: 'Canal no encontrado' });
      }

      const updated = await channelRepository.update(id, req.body);
      return res.json(updated);
    } catch (error) {
      return res.status(500).json({ error: 'Error al actualizar el canal: ' + error.message });
    }
  },

  /**
   * Elimina un canal por su ID.
   */
  async deleteChannel(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de canal inválido' });
      }

      const channel = await channelRepository.findById(id);
      if (!channel) {
        return res.status(404).json({ error: 'Canal no encontrado' });
      }

      await channelRepository.deleteById(id);
      return res.json({ success: true, message: 'Canal eliminado correctamente' });
    } catch (error) {
      return res.status(500).json({ error: 'Error al eliminar el canal: ' + error.message });
    }
  },

  /**
   * Escanea las Fan Pages del perfil de Facebook del usuario a través de Meta Graph API v21.0.
  /**
   * Obtiene la configuración pública de la App de Meta (App ID) para OAuth.
   */
  async getMetaAppInfo(req, res) {
    return res.json({
      appId: envConfig.meta.appId || '2381150255623992'
    });
  },

  /**
   * Escanea las Fan Pages del perfil de Meta asociado al token proporcionado.
   * Requiere un token con permisos 'pages_show_list' (y opcionalmente 'pages_messaging', 'pages_manage_metadata').
   */
  async scanFacebookPages(req, res) {
    try {
      const { userToken } = req.body;

      if (!userToken || !userToken.trim()) {
        return res.status(400).json({
          error: 'El token de acceso de usuario de Meta (User Access Token) es obligatorio para escanear páginas.'
        });
      }

      const cleanToken = userToken.trim();
      let effectiveToken = cleanToken;
      const apiVersion = envConfig.meta.apiVersion || 'v25.0';

      // Canje por token de larga duración (60 días / permanente para páginas) si disponemos de App ID y App Secret
      if (envConfig.meta.appId && envConfig.meta.appSecret && !cleanToken.startsWith('EAAB_test')) {
        try {
          const exchangeUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${envConfig.meta.appId}&client_secret=${envConfig.meta.appSecret}&fb_exchange_token=${cleanToken}`;
          const exRes = await fetch(exchangeUrl);
          const exData = await exRes.json();
          if (exData.access_token) {
            effectiveToken = exData.access_token;
            console.log('⚡ [TOKEN EXCHANGE] Token canjeado por token de larga duración exitosamente.');
          }
        } catch (exErr) {
          console.warn('⚠️ [TOKEN EXCHANGE] Canje de token omitido:', exErr.message);
        }
      }

      // 1. Validar permisos concedidos al token
      let grantedPermissions = [];
      try {
        const permRes = await fetch(`https://graph.facebook.com/${apiVersion}/me/permissions?access_token=${effectiveToken}`);
        if (permRes.ok) {
          const permData = await permRes.json();
          grantedPermissions = (permData.data || [])
            .filter(p => p.status === 'granted')
            .map(p => p.permission);
        }
      } catch (permErr) {
        console.warn('⚠️ [SCAN PAGES] No se pudieron verificar permisos previos:', permErr.message);
      }

      // 2. Consultar Fan Pages del perfil y cuentas de Instagram vinculadas
      const accountsRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/me/accounts?fields=id,name,category,access_token,instagram_business_account{id,username,name}&access_token=${effectiveToken}`
      );

      const accountsData = await accountsRes.json();

      if (!accountsRes.ok || accountsData.error) {
        const errorMsg = accountsData.error?.message || 'Error al comunicarse con Meta Graph API';
        return res.status(400).json({
          error: `Meta Graph API error: ${errorMsg}`,
          metaError: accountsData.error
        });
      }

      const rawPages = accountsData.data || [];

      // 3. Cruzar con canales existentes en la base de datos
      const scannedPages = await Promise.all(
        rawPages.map(async (page) => {
          const existingFb = await channelRepository.findByIdentifier(page.id);
          let existingIg = null;

          if (page.instagram_business_account?.id) {
            existingIg = await channelRepository.findByIdentifier(page.instagram_business_account.id);
          }

          return {
            id: page.id,
            name: page.name,
            category: page.category || 'Página de Facebook',
            accessToken: page.access_token,
            alreadyConnected: Boolean(existingFb),
            existingChannelId: existingFb?.id || null,
            instagram: page.instagram_business_account ? {
              id: page.instagram_business_account.id,
              username: page.instagram_business_account.username,
              name: page.instagram_business_account.name || null,
              alreadyConnected: Boolean(existingIg),
              existingChannelId: existingIg?.id || null
            } : null
          };
        })
      );

      const recommended = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata'];
      const missingRecommended = recommended.filter(p => !grantedPermissions.includes(p));

      return res.json({
        success: true,
        pages: scannedPages,
        permissions: grantedPermissions,
        missingRecommended,
        count: scannedPages.length
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al escanear páginas de Facebook: ' + error.message });
    }
  },

  /**
   * Conecta y suscribe automáticamente una o varias Fan Pages seleccionadas como canales del CRM.
   */
  async connectFacebookPages(req, res) {
    try {
      const { pages, appId = null, appSecret = null } = req.body;
      const finalAppId = appId || envConfig.meta.appId;
      const finalAppSecret = appSecret || envConfig.meta.appSecret;

      if (!Array.isArray(pages) || pages.length === 0) {
        return res.status(400).json({ error: 'Debes seleccionar al menos una página para conectar.' });
      }

      const connectedChannels = [];

      for (const p of pages) {
        if (!p.id || !p.accessToken) continue;

        // A. Suscribir la página a los eventos de Webhook de la aplicación
        try {
          const apiVersion = envConfig.meta.apiVersion || 'v25.0';
          const subRes = await fetch(
            `https://graph.facebook.com/${apiVersion}/${p.id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads&access_token=${p.accessToken}`,
            { method: 'POST' }
          );
          const subData = await subRes.json();
          if (subData.success) {
            console.log(`✅ [PAGE SUBSCRIBED] Página "${p.name}" (#${p.id}) suscrita al webhook.`);
          } else {
            console.warn(`⚠️ [PAGE SUBSCRIBE WARNING] Respuesta de suscripción para #${p.id}:`, subData);
          }
        } catch (subErr) {
          console.warn(`⚠️ [PAGE SUBSCRIBE ERROR] No se pudo suscribir webhook para #${p.id}:`, subErr.message);
        }

        // B. Crear o actualizar canal de Facebook en la base de datos
        const existingFb = await channelRepository.findByIdentifier(p.id);
        let fbChannel;
        if (existingFb) {
          fbChannel = await channelRepository.update(existingFb.id, {
            name: p.name || existingFb.name,
            accessToken: p.accessToken,
            appId: finalAppId,
            appSecret: finalAppSecret,
            status: 'active'
          });
        } else {
          fbChannel = await channelRepository.create({
            platform: 'facebook',
            name: p.name || `Facebook Page ${p.id}`,
            channelIdentifier: p.id,
            accessToken: p.accessToken,
            appId: finalAppId,
            appSecret: finalAppSecret,
            colorTag: '#1877F2'
          });
        }
        connectedChannels.push(fbChannel);

        // C. Si se solicitó conectar Instagram y la página tiene cuenta vinculada
        if (p.connectInstagram && p.instagram?.id) {
          const igId = p.instagram.id;
          const igUsername = p.instagram.username || p.name;
          const existingIg = await channelRepository.findByIdentifier(igId);
          let igChannel;
          if (existingIg) {
            igChannel = await channelRepository.update(existingIg.id, {
              name: `Instagram @${igUsername}`,
              accessToken: p.accessToken,
              appId: finalAppId,
              appSecret: finalAppSecret,
              status: 'active'
            });
          } else {
            igChannel = await channelRepository.create({
              platform: 'instagram',
              name: `Instagram @${igUsername}`,
              channelIdentifier: igId,
              accessToken: p.accessToken,
              appId: finalAppId,
              appSecret: finalAppSecret,
              colorTag: '#E1306C'
            });
          }
          connectedChannels.push(igChannel);
        }
      }

      return res.status(201).json({
        success: true,
        message: `Se conectaron ${connectedChannels.length} canal(es) exitosamente.`,
        channels: connectedChannels
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al conectar páginas de Facebook: ' + error.message });
    }
  },

  // ==========================================
  // CHATBOT
  // ==========================================

  /**
   * Obtiene la configuración del bot (global o para un canal específico).
   */
  async getBotSettings(req, res) {
    try {
      const channelId = req.query.channel_id ? parseInt(req.query.channel_id, 10) : null;
      const settings = await botRepository.getSettingsForChannel(channelId);
      return res.json(settings);
    } catch (error) {
      return res.status(500).json({ error: 'Error al obtener la configuración del bot: ' + error.message });
    }
  },

  /**
   * Actualiza o crea la configuración del bot.
   */
  async saveBotSettings(req, res) {
    try {
      const { channelId, isEnabled, welcomeMessage, inactivityHours } = req.body;

      if (!welcomeMessage || !welcomeMessage.trim()) {
        return res.status(400).json({ error: 'El mensaje de bienvenida es obligatorio' });
      }

      const saved = await botRepository.saveSettings({
        channelId: channelId ? parseInt(channelId, 10) : null,
        isEnabled: isEnabled !== undefined ? Boolean(isEnabled) : true,
        welcomeMessage: welcomeMessage.trim(),
        inactivityHours: inactivityHours ? parseInt(inactivityHours, 10) : 24
      });

      return res.json(saved);
    } catch (error) {
      return res.status(500).json({ error: 'Error al guardar la configuración del bot: ' + error.message });
    }
  },

  // ==========================================
  // USUARIOS / OPERADORES
  // ==========================================

  /**
   * Lista todos los operadores y administradores (sin passwords).
   */
  async getUsers(req, res) {
    try {
      const users = await userRepository.listAll();
      return res.json(users);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar los usuarios: ' + error.message });
    }
  },

  /**
   * Registra un nuevo operador o administrador.
   */
  async createUser(req, res) {
    try {
      const { email, password, name, role = 'agent' } = req.body;

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Email inválido o ausente' });
      }

      if (!password || password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      }

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'El nombre es obligatorio' });
      }

      if (!['admin', 'agent'].includes(role)) {
        return res.status(400).json({ error: 'Rol inválido. Debe ser admin o agent' });
      }

      const existing = await userRepository.findByEmail(email);
      if (existing) {
        return res.status(409).json({ error: 'Ya existe un usuario con ese correo electrónico' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = await userRepository.create({
        email,
        passwordHash,
        name: name.trim(),
        role
      });

      return res.status(201).json(newUser);
    } catch (error) {
      return res.status(500).json({ error: 'Error al registrar el usuario: ' + error.message });
    }
  },

  // ==========================================
  // AUDITORÍA DE LOGS
  // ==========================================

  /**
   * Obtiene los logs de webhooks recientes.
   */
  async getLogs(req, res) {
    try {
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 200) : 50;
      const logs = await logRepository.listRecent(limit);
      return res.json(logs);
    } catch (error) {
      return res.status(500).json({ error: 'Error al consultar logs de auditoría: ' + error.message });
    }
  }
};

export default settingsController;
