import bcrypt from 'bcryptjs';
import { channelRepository } from '../repositories/channel.repository.js';
import { botRepository } from '../repositories/bot.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { logRepository } from '../repositories/log.repository.js';
import { teamRepository } from '../repositories/team.repository.js';
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
      const teamId = req.query.team_id || req.user?.team_id || 1;
      const channels = await channelRepository.listAll(teamId);
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
      let teamId = req.body.teamId || req.user?.team_id;
      if (!teamId) {
        const teams = await teamRepository.listAllWithMetrics();
        teamId = teams.length > 0 ? teams[0].id : 1;
      }
      const { platform, name, channelIdentifier, appId, appSecret, accessToken, colorTag } = req.body;

      if (!platform || !['whatsapp', 'facebook', 'instagram'].includes(platform)) {
        return res.status(400).json({ error: 'Plataforma inválida. Debe ser whatsapp, facebook o instagram' });
      }

      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'El nombre del canal es obligatorio' });
      }

      if (!channelIdentifier || !String(channelIdentifier).trim()) {
        return res.status(400).json({ error: 'El identificador del canal (phone_number_id o page_id) es obligatorio' });
      }

      let cleanIdentifier = String(channelIdentifier).trim().replace(/\s+/g, '');
      if (platform === 'whatsapp') {
        cleanIdentifier = cleanIdentifier.replace(/[^\d]/g, '');
        if (cleanIdentifier.length < 10) {
          return res.status(400).json({
            error: 'El Phone Number ID de WhatsApp debe ser un ID numérico generado por Meta (ej: 105948305938492), no tu número telefónico personal.'
          });
        }
      }

      if (!accessToken || !accessToken.trim()) {
        return res.status(400).json({ error: 'El token de acceso de Meta Graph API es obligatorio' });
      }

      // Verificación en vivo con Meta Graph API para dar feedback inmediato al usuario
      const apiVersion = envConfig.meta.apiVersion || 'v26.0';
      if (platform === 'whatsapp') {
        try {
          const testRes = await fetch(
            `https://graph.facebook.com/${apiVersion}/${cleanIdentifier}?fields=verified_name,code_verification_status,display_phone_number&access_token=${accessToken.trim()}`
          );
          const testData = await testRes.json();
          if (!testRes.ok || testData.error) {
            const detail = testData.error?.message || `HTTP ${testRes.status}`;
            console.warn('⚠️ [CHANNEL CREATE] Meta rechazó verificación WhatsApp:', detail);
            return res.status(400).json({
              error: `Meta Graph API rechazó el identificador o token: ${detail}. Verifica que el Phone Number ID sea correcto y que el token tenga el permiso 'whatsapp_business_messaging'.`
            });
          }
        } catch (metaErr) {
          console.warn('⚠️ [CHANNEL CREATE] Conexión de prueba con Meta omitida por red:', metaErr.message);
        }
      }

      // Upsert atómico del canal: si ya existía (activo o archivado), actualiza credenciales y reactiva
      const channel = await channelRepository.upsert({
        teamId,
        platform,
        name: name.trim(),
        channelIdentifier: cleanIdentifier,
        appId: appId ? appId.trim() : null,
        appSecret: appSecret ? appSecret.trim() : null,
        accessToken: accessToken.trim(),
        colorTag: colorTag || (platform === 'whatsapp' ? '#25D366' : '#1877F2'),
        status: 'active'
      });

      // Si es Facebook o Instagram, intentar suscripción
      if (platform === 'facebook' || platform === 'instagram') {
        try {
          await fetch(
            `https://graph.facebook.com/${apiVersion}/${cleanIdentifier}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,standby&access_token=${accessToken.trim()}`,
            { method: 'POST' }
          );
        } catch {}
      }

      return res.status(201).json(channel);
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

      if (req.user.role !== 'superadmin' && req.user.team_id && channel.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
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

      if (req.user.role !== 'superadmin' && req.user.team_id && channel.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
      }

      await channelRepository.deleteById(id);
      return res.json({ success: true, message: 'Canal eliminado correctamente' });
    } catch (error) {
      return res.status(500).json({ error: 'Error al eliminar el canal: ' + error.message });
    }
  },

  /**
   * Prueba la validez del token y conectividad con Meta Graph API en vivo.
   * Si es exitoso, limpia error_message y restablece el canal a 'active'.
   */
  async testChannel(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de canal inválido' });
      }

      const channel = await channelRepository.findById(id);
      if (!channel) {
        return res.status(404).json({ error: 'Canal no encontrado' });
      }

      if (req.user.role !== 'superadmin' && req.user.team_id && channel.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
      }

      const apiVersion = envConfig.meta.apiVersion || 'v26.0';
      let metaData = null;
      let lastError = null;

      if (channel.platform === 'whatsapp') {
        // WhatsApp Cloud API: verificar el Phone Number ID
        const testUrls = [
          `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}?fields=verified_name,code_verification_status,display_phone_number`,
          `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}?fields=id,display_phone_number`
        ];
        for (const url of testUrls) {
          try {
            const r = await fetch(url, { headers: { 'Authorization': `Bearer ${channel.access_token}` } });
            const d = await r.json();
            if (r.ok && !d.error) {
              metaData = d;
              break;
            } else {
              lastError = d.error || { message: `HTTP ${r.status}` };
            }
          } catch (e) {
            lastError = { message: e.message };
          }
        }
      } else if (channel.platform === 'instagram') {
        // Instagram Business Account: consultar id y username
        const testUrls = [
          `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}?fields=id,username,name`,
          `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}?fields=id,username`
        ];
        for (const url of testUrls) {
          try {
            const r = await fetch(url, { headers: { 'Authorization': `Bearer ${channel.access_token}` } });
            const d = await r.json();
            if (r.ok && !d.error) {
              metaData = d;
              break;
            } else {
              lastError = d.error || { message: `HTTP ${r.status}` };
            }
          } catch (e) {
            lastError = { message: e.message };
          }
        }
      } else {
        // Facebook Fan Page:
        // IMPORTANTE: NUNCA pedir 'category' porque requiere el permiso avanzado 'pages_read_engagement'
        // o la función 'Page Public Metadata Access' que genera error (#100).
        // Con el Page Access Token se consulta /me?fields=id,name o /{page_id}?fields=id,name.
        const testUrls = [
          `https://graph.facebook.com/${apiVersion}/me?fields=id,name`,
          `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}?fields=id,name`
        ];
        for (const url of testUrls) {
          try {
            const r = await fetch(url, { headers: { 'Authorization': `Bearer ${channel.access_token}` } });
            const d = await r.json();
            if (r.ok && !d.error) {
              metaData = d;
              break;
            } else {
              lastError = d.error || { message: `HTTP ${r.status}` };
            }
          } catch (e) {
            lastError = { message: e.message };
          }
        }
      }

      if (!metaData) {
        let errMsg = lastError?.message || 'Error al validar canal con Meta Graph API';
        if (lastError?.code === 100 || (typeof errMsg === 'string' && errMsg.includes('pages_read_engagement'))) {
          errMsg = `Meta denegó la consulta (Error #100): Verifica que el token sea un Page Access Token válido y que cuente con los permisos 'pages_show_list', 'pages_messaging' y 'pages_read_engagement'.`;
        }
        await channelRepository.updateStatus(id, 'error', errMsg);
        return res.status(400).json({
          success: false,
          error: errMsg,
          metaError: lastError
        });
      }

      // Limpiar error y dejar en activo
      await channelRepository.updateStatus(id, 'active', null);

      // Si es Facebook, asegurar suscripción de webhook con soporte para standby
      if (channel.platform === 'facebook') {
        try {
          await fetch(
            `https://graph.facebook.com/${apiVersion}/${channel.channel_identifier}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,standby&access_token=${channel.access_token}`,
            { method: 'POST' }
          );
        } catch (subErr) {
          console.warn('Advertencia al suscribir página en test:', subErr.message);
        }
      }

      return res.json({
        success: true,
        message: 'Conexión con Meta validada exitosamente',
        data: metaData
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al probar el canal: ' + error.message });
    }
  },

  /**
   * Obtiene la configuración pública y del equipo para la integración con Meta.
   */
  async getMetaAppInfo(req, res) {
    try {
      const teamId = req.user?.team_id || 1;
      const metaConfig = await teamRepository.getMetaConfig(teamId);

      return res.json({
        verifyToken: envConfig.meta.verifyToken || 'meta_webhook_verify_token_secure_2026',
        apiVersion: envConfig.meta.apiVersion || 'v26.0',
        appId: metaConfig.appId || null,
        hasAppSecret: metaConfig.hasAppSecret
      });
    } catch (err) {
      return res.json({
        verifyToken: envConfig.meta.verifyToken || 'meta_webhook_verify_token_secure_2026',
        apiVersion: envConfig.meta.apiVersion || 'v26.0',
        appId: null,
        hasAppSecret: false
      });
    }
  },

  /**
   * Guarda las credenciales de la App de Meta (App ID y App Secret) para el equipo del usuario en PostgreSQL.
   */
  async saveTeamMetaConfig(req, res) {
    try {
      const teamId = req.user?.team_id || 1;
      const { appId, appSecret } = req.body;

      if (!appId || !String(appId).trim()) {
        return res.status(400).json({ error: 'El App ID es obligatorio.' });
      }

      const updated = await teamRepository.updateMetaConfig(teamId, {
        appId: String(appId).trim(),
        appSecret: appSecret ? String(appSecret).trim() : null
      });

      return res.json({
        success: true,
        message: 'Credenciales de Meta guardadas exitosamente en la base de datos para tu equipo.',
        data: {
          appId: updated.appId,
          hasAppSecret: updated.hasAppSecret
        }
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al guardar credenciales de Meta: ' + error.message });
    }
  },

  /**
   * Elimina las credenciales de Meta del equipo en la base de datos.
   */
  async clearTeamMetaConfig(req, res) {
    try {
      const teamId = req.user?.team_id || 1;
      await teamRepository.clearMetaConfig(teamId);
      return res.json({
        success: true,
        message: 'Credenciales de Meta eliminadas de la base de datos de tu equipo.'
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al eliminar credenciales: ' + error.message });
    }
  },

  /**
   * Canjea el 'code' que devuelve el Inicio de sesión con Facebook para empresas
   * por un token de usuario, y escanea las páginas con él.
   *
   * El canje se hace en el servidor porque necesita el App Secret, que nunca
   * debe viajar directamente a servicios externos no autorizados.
   *
   * POST /api/settings/channels/facebook-exchange-code   body: { code, appId, appSecret }
   */
  async exchangeFacebookCode(req, res) {
    try {
      const { code, appId = null, appSecret = null } = req.body;

      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Falta el código de autorización devuelto por Meta.' });
      }

      const fbAppId = appId ? String(appId).trim() : null;
      const fbAppSecret = appSecret ? String(appSecret).trim() : null;

      if (!fbAppId || !fbAppSecret) {
        return res.status(400).json({
          error: 'Debes configurar manualmente el App ID y la Clave Secreta (App Secret) en el navegador para canjear la autorización.'
        });
      }

      const apiVersion = envConfig.meta.apiVersion || 'v26.0';

      // En el flujo del SDK de JavaScript el redirect_uri va vacío.
      const params = new URLSearchParams({
        client_id: fbAppId,
        client_secret: fbAppSecret,
        redirect_uri: '',
        code: code.trim()
      });

      const tokenRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/oauth/access_token?${params.toString()}`
      );
      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
        const detalle = tokenData.error?.message || `HTTP ${tokenRes.status}`;
        console.error('❌ [META CODE EXCHANGE] Fallo al canjear el código:', tokenData.error || tokenData);
        return res.status(400).json({
          error: `Meta rechazó el canje del código: ${detalle}`,
          metaError: tokenData.error
        });
      }

      // Con el token en mano, el escaneo es exactamente el mismo de siempre.
      const resultado = await settingsController._scanPagesConToken(tokenData.access_token, apiVersion, fbAppId, fbAppSecret);

      if (resultado.error) {
        return res.status(400).json(resultado);
      }

      return res.json(resultado);
    } catch (error) {
      return res.status(500).json({ error: 'Error al canjear el código de Meta: ' + error.message });
    }
  },

  /**
   * Escanea las Fan Pages del perfil de Meta asociado al token proporcionado.
   * Requiere un token con permisos 'pages_show_list' (y opcionalmente 'pages_messaging', 'pages_manage_metadata').
   */
  async scanFacebookPages(req, res) {
    try {
      const { userToken, appId = null, appSecret = null } = req.body;

      if (!userToken || !userToken.trim()) {
        return res.status(400).json({
          error: 'El token de acceso de usuario de Meta (User Access Token) es obligatorio para escanear páginas.'
        });
      }

      const apiVersion = envConfig.meta.apiVersion || 'v26.0';
      const resultado = await settingsController._scanPagesConToken(userToken.trim(), apiVersion, appId, appSecret);

      if (resultado.error) {
        return res.status(400).json(resultado);
      }

      return res.json(resultado);
    } catch (error) {
      return res.status(500).json({ error: 'Error al escanear páginas de Facebook: ' + error.message });
    }
  },

  /**
   * Lógica compartida de escaneo: recibe un token de usuario ya obtenido (sea
   * pegado a mano o salido del canje del código) y devuelve las páginas del
   * perfil cruzadas con los canales ya registrados.
   *
   * @private
   * @param {string} token Token de acceso de usuario de Meta
   * @param {string} apiVersion
   * @param {string|null} customAppId
   * @param {string|null} customAppSecret
   * @returns {Promise<object>} { success, pages, permissions, missingRecommended, count } o { error }
   */
  async _scanPagesConToken(token, apiVersion, customAppId = null, customAppSecret = null) {
    let effectiveToken = token;

    // 1. Canjear por un token de larga duración si el usuario ingresó App ID y App Secret manualmente.
    //    Los tokens de página que salgan de este no expiran.
    const fbAppId = customAppId ? String(customAppId).trim() : null;
    const fbAppSecret = customAppSecret ? String(customAppSecret).trim() : null;
    if (fbAppId && fbAppSecret && !token.startsWith('EAAB_test')) {
      try {
        const exchangeUrl = `https://graph.facebook.com/${apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${fbAppId}&client_secret=${fbAppSecret}&fb_exchange_token=${token}`;
        const exRes = await fetch(exchangeUrl);
        const exData = await exRes.json();
        if (exData.access_token) {
          effectiveToken = exData.access_token;
          console.log('⚡ [TOKEN EXCHANGE] Token canjeado por uno de larga duración.');
        }
      } catch (exErr) {
        console.warn('⚠️ [TOKEN EXCHANGE] Canje omitido:', exErr.message);
      }
    }

    // 2. Consultar qué permisos concedió realmente el usuario
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
      console.warn('⚠️ [SCAN PAGES] No se pudieron verificar los permisos:', permErr.message);
    }

    // 3a. Traer las páginas asociadas directamente al perfil (/me/accounts)
    // IMPORTANTE: NUNCA solicitar 'category' ni campos de Page Public Metadata Access porque
    // disparan el error (#100) si el token no cuenta con 'pages_read_engagement' aprobado por Meta.
    const rawPages = [];
    let accountsError = null;

    try {
      // Intento 1: consultar páginas e info básica de Instagram
      let accountsRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${effectiveToken}`
      );
      let accountsData = await accountsRes.json();

      // Si falla (por ejemplo por restricción de Instagram o error 100), reintentar de forma segura solo páginas
      if (!accountsRes.ok || accountsData.error) {
        console.warn('⚠️ [SCAN PAGES] Intento con Instagram falló, reintentando solo con campos básicos de páginas:', accountsData.error?.message);
        accountsRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/me/accounts?fields=id,name,access_token&access_token=${effectiveToken}`
        );
        accountsData = await accountsRes.json();
      }

      if (accountsRes.ok && Array.isArray(accountsData.data)) {
        rawPages.push(...accountsData.data);
      } else if (accountsData.error) {
        accountsError = accountsData.error;
        console.warn('⚠️ [SCAN PAGES] Error en /me/accounts:', accountsData.error.message);
      }
    } catch (accErr) {
      console.warn('⚠️ [SCAN PAGES] Fallo al consultar /me/accounts:', accErr.message);
    }

    // 3b. Consultar también los Business Managers del usuario (/me/businesses)
    try {
      let bizRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/me/businesses?fields=id,name,owned_pages{id,name,access_token,instagram_business_account{id,username}},client_pages{id,name,access_token,instagram_business_account{id,username}}&access_token=${effectiveToken}`
      );
      let bizData = await bizRes.json();

      // Si falla por campos anidados de Instagram, reintentar solo con páginas del Business
      if (!bizRes.ok || bizData.error) {
        bizRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/me/businesses?fields=id,name,owned_pages{id,name,access_token},client_pages{id,name,access_token}&access_token=${effectiveToken}`
        );
        bizData = await bizRes.json();
      }

      if (bizRes.ok && Array.isArray(bizData.data)) {
        const businesses = bizData.data || [];
        for (const biz of businesses) {
          const owned = biz.owned_pages?.data || [];
          const client = biz.client_pages?.data || [];
          for (const p of [...owned, ...client]) {
            rawPages.push({
              ...p,
              category: p.category || `Business (${biz.name})`
            });
          }
        }
      }
    } catch (bizErr) {
      console.warn('⚠️ [SCAN BUSINESS] Consulta de Business Manager omitida:', bizErr.message);
    }

    if (rawPages.length === 0 && accountsError) {
      let friendlyError = accountsError.message || 'Error al comunicarse con Meta Graph API';
      if (accountsError.code === 100 || (typeof friendlyError === 'string' && friendlyError.includes('pages_read_engagement'))) {
        friendlyError = `Meta denegó la lectura de páginas (Error #100): El token no cuenta con los permisos necesarios o tu App de Meta está en modo 'Desarrollo'. Asegúrate de incluir los permisos 'pages_show_list', 'pages_messaging' y 'pages_read_engagement', y que tu usuario tenga rol de Administrador o Evaluador (Tester) en la App de Meta Developers.`;
      }
      return {
        error: friendlyError,
        metaError: accountsError
      };
    }

    // Deduplicar páginas devueltas por Meta (en caso de que el usuario tenga roles en Business Manager y perfil)
    const uniqueRawPages = [];
    const seenScanIds = new Set();
    for (const page of rawPages) {
      const pageId = String(page.id || '').trim();
      if (pageId && !seenScanIds.has(pageId)) {
        seenScanIds.add(pageId);
        uniqueRawPages.push(page);
      }
    }

    // 4. Cruzar con los canales ya existentes para no duplicar
    const scannedPages = await Promise.all(
      uniqueRawPages.map(async (page) => {
        const existingFb = await channelRepository.findAnyByIdentifier(page.id);
        let existingIg = null;

        if (page.instagram_business_account?.id) {
          existingIg = await channelRepository.findAnyByIdentifier(page.instagram_business_account.id);
        }

        return {
          id: page.id,
          name: page.name,
          category: page.category || 'Página de Facebook',
          accessToken: page.access_token,
          alreadyConnected: Boolean(existingFb && !existingFb.deleted_at),
          existingChannelId: (existingFb && !existingFb.deleted_at) ? existingFb.id : null,
          instagram: page.instagram_business_account ? {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username,
            name: page.instagram_business_account.name || null,
            alreadyConnected: Boolean(existingIg && !existingIg.deleted_at),
            existingChannelId: (existingIg && !existingIg.deleted_at) ? existingIg.id : null
          } : null
        };
      })
    );

    const recommended = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'business_management'];
    const missingRecommended = recommended.filter(p => !grantedPermissions.includes(p));

    return {
      success: true,
      pages: scannedPages,
      permissions: grantedPermissions,
      missingRecommended,
      count: scannedPages.length
    };
  },


  /**
   * Conecta y suscribe automáticamente una o varias Fan Pages seleccionadas como canales del CRM.
   * Utiliza UPSERT atómico idempotente para evitar colisiones de clave única ('channels_channel_identifier_key').
   */
  async connectFacebookPages(req, res) {
    try {
      const teamId = req.user?.team_id || 1;
      const { pages, appId = null, appSecret = null } = req.body;
      const finalAppId = (appId && String(appId).trim()) ? String(appId).trim() : null;
      const finalAppSecret = (appSecret && String(appSecret).trim()) ? String(appSecret).trim() : null;

      if (finalAppId) {
        await teamRepository.updateMetaConfig(teamId, { appId: finalAppId, appSecret: finalAppSecret });
      }

      if (!Array.isArray(pages) || pages.length === 0) {
        return res.status(400).json({ error: 'Debes seleccionar al menos una página para conectar.' });
      }

      // 1. Deduplicar páginas recibidas por ID para evitar procesamiento duplicado o concurrente
      const uniquePages = [];
      const seenPageIds = new Set();
      for (const p of pages) {
        const pId = String(p.id || '').trim();
        if (pId && !seenPageIds.has(pId)) {
          seenPageIds.add(pId);
          uniquePages.push(p);
        }
      }

      const connectedChannels = [];
      const processedIgIds = new Set();

      for (const p of uniquePages) {
        const pageId = String(p.id || '').trim();
        if (!pageId || !p.accessToken) continue;

        // A. Suscribir la página a los eventos de Webhook de la aplicación
        try {
          const apiVersion = envConfig.meta.apiVersion || 'v26.0';
          const subRes = await fetch(
            `https://graph.facebook.com/${apiVersion}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,standby&access_token=${p.accessToken}`,
            { method: 'POST' }
          );
          const subData = await subRes.json();
          if (subData.success) {
            console.log(`✅ [PAGE SUBSCRIBED] Página "${p.name}" (#${pageId}) suscrita al webhook.`);
          } else {
            console.warn(`⚠️ [PAGE SUBSCRIBE WARNING] Respuesta de suscripción para #${pageId}:`, subData);
          }
        } catch (subErr) {
          console.warn(`⚠️ [PAGE SUBSCRIBE ERROR] No se pudo suscribir webhook para #${pageId}:`, subErr.message);
        }

        // B. Upsert atómico del canal de Facebook (idempotente: crea, actualiza o reactiva sin errores de duplicación)
        const fbChannel = await channelRepository.upsert({
          teamId,
          platform: 'facebook',
          name: p.name || `Facebook Page ${pageId}`,
          channelIdentifier: pageId,
          accessToken: p.accessToken,
          appId: finalAppId,
          appSecret: finalAppSecret,
          colorTag: '#1877F2',
          status: 'active'
        });
        connectedChannels.push(fbChannel);

        // C. Si se solicitó conectar Instagram y la página tiene cuenta vinculada
        if (p.connectInstagram && p.instagram?.id) {
          const igId = String(p.instagram.id).trim();
          const igUsername = p.instagram.username || p.name;

          if (!processedIgIds.has(igId)) {
            processedIgIds.add(igId);

            const igChannel = await channelRepository.upsert({
              teamId,
              platform: 'instagram',
              name: `Instagram @${igUsername}`,
              channelIdentifier: igId,
              accessToken: p.accessToken,
              appId: finalAppId,
              appSecret: finalAppSecret,
              colorTag: '#E1306C',
              status: 'active'
            });
            connectedChannels.push(igChannel);
          }
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
      const parsedChannelId = req.query.channel_id ? parseInt(req.query.channel_id, 10) : null;
      const channelId = (!parsedChannelId || isNaN(parsedChannelId)) ? null : parsedChannelId;
      const teamId = req.user?.team_id || null;
      const settings = await botRepository.getSettingsForChannel(teamId, channelId);
      return res.json(settings);
    } catch (error) {
      console.error('Error al obtener la configuración del bot:', error);
      return res.status(500).json({ error: 'Error al obtener la configuración del bot: ' + error.message });
    }
  },

  /**
   * Actualiza o crea la configuración del bot.
   */
  async saveBotSettings(req, res) {
    try {
      const { channelId, isEnabled, welcomeMessage, inactivityHours } = req.body;
      const teamId = req.user?.team_id || null;

      if (!welcomeMessage || !welcomeMessage.trim()) {
        return res.status(400).json({ error: 'El mensaje de bienvenida es obligatorio' });
      }

      if (channelId && req.user.role !== 'superadmin') {
        const ch = await channelRepository.findById(parseInt(channelId, 10));
        if (ch && req.user.team_id && ch.team_id !== req.user.team_id) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      const saved = await botRepository.saveSettings({
        teamId,
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
      const teamId = req.user?.team_id || 1;
      const users = await userRepository.listAll(teamId);
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
      const teamId = req.user?.team_id || 1;
      const { email, password, name, role = 'agent', channelIds } = req.body;

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Email inválido o ausente' });
      }

      if (!password || password.length < 12) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 12 caracteres' });
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

      const passwordHash = await bcrypt.hash(password, 12);
      const newUser = await userRepository.create({
        teamId,
        email,
        passwordHash,
        name: name.trim(),
        role,
        isActive: true
      });

      // Los operadores solo ven los canales que se les asignen (A-03).
      // Si el alta viene con canales, se aplican de una vez.
      if (role === 'agent' && Array.isArray(channelIds)) {
        newUser.channel_ids = await userRepository.setAssignedChannels(newUser.id, channelIds);
      } else {
        newUser.channel_ids = [];
      }

      return res.status(201).json(newUser);
    } catch (error) {
      return res.status(500).json({ error: 'Error al registrar el usuario: ' + error.message });
    }
  },

  /**
   * Devuelve los canales asignados a un operador.
   * GET /api/settings/users/:id/channels
   */
  async getUserChannels(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
      }

      const usuario = await userRepository.findById(id);
      if (!usuario) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (req.user.role !== 'superadmin' && req.user.team_id && usuario.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'Acceso no autorizado a este usuario' });
      }

      const channelIds = await userRepository.getAssignedChannelIds(id);

      return res.json({
        userId: id,
        role: usuario.role,
        // Los administradores ven todos los canales sin necesidad de asignación.
        seesAllChannels: usuario.role === 'admin',
        channelIds
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al consultar los canales del usuario: ' + error.message });
    }
  },

  /**
   * Reemplaza los canales asignados a un operador.
   * PUT /api/settings/users/:id/channels   body: { channelIds: [1, 2] }
   */
  async setUserChannels(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
      }

      const { channelIds } = req.body;
      if (!Array.isArray(channelIds)) {
        return res.status(400).json({ error: 'channelIds debe ser una lista de IDs de canal' });
      }

      const usuario = await userRepository.findById(id);
      if (!usuario) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      if (req.user.role !== 'superadmin' && req.user.team_id && usuario.team_id !== req.user.team_id) {
        return res.status(403).json({ error: 'Acceso no autorizado a este usuario' });
      }

      const asignados = await userRepository.setAssignedChannels(id, channelIds);

      return res.json({
        success: true,
        userId: id,
        channelIds: asignados,
        message: usuario.role === 'admin'
          ? 'Guardado. Recordá que los administradores ven todos los canales igualmente.'
          : `El operador ahora ve ${asignados.length} canal(es).`
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al asignar canales: ' + error.message });
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
      const teamId = req.user.role === 'superadmin' ? null : (req.user.team_id || null);
      const logs = await logRepository.listRecent(limit, teamId);
      return res.json(logs);
    } catch (error) {
      return res.status(500).json({ error: 'Error al consultar logs de auditoría: ' + error.message });
    }
  },

  /**
   * Consulta Meta Graph API con un Access Token para detectar automáticamente
   * cuentas comerciales de Instagram vinculadas.
   */
  async instagramLookup(req, res) {
    try {
      const { accessToken } = req.body;
      if (!accessToken || !accessToken.trim()) {
        return res.status(400).json({ error: 'El Access Token es obligatorio para detectar la cuenta de Instagram.' });
      }
      const token = accessToken.trim();
      const apiVersion = envConfig.meta.apiVersion || 'v26.0';

      // 1. Consultar /me directamente por si es un token de cuenta de Instagram o de Fan Page
      try {
        const meRes = await fetch(`https://graph.facebook.com/${apiVersion}/me?fields=id,name,username,instagram_business_account{id,username,name}&access_token=${token}`);
        const meData = await meRes.json();

        if (meRes.ok && meData) {
          if (meData.instagram_business_account?.id) {
            return res.status(200).json({
              success: true,
              account: {
                id: meData.instagram_business_account.id,
                username: meData.instagram_business_account.username || meData.instagram_business_account.name,
                name: meData.instagram_business_account.name || meData.instagram_business_account.username,
                source: `Vinculada a la página ${meData.name || meData.id}`
              }
            });
          }
          if (meData.username && meData.id) {
            return res.status(200).json({
              success: true,
              account: {
                id: meData.id,
                username: meData.username,
                name: meData.name || meData.username,
                source: 'Cuenta directa'
              }
            });
          }
        }
      } catch {}

      // 2. Consultar /me/accounts (páginas administradas por el usuario con cuentas de Instagram vinculadas)
      try {
        let accRes = await fetch(`https://graph.facebook.com/${apiVersion}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${token}`);
        let accData = await accRes.json();

        if (accRes.ok && Array.isArray(accData.data)) {
          for (const page of accData.data) {
            if (page.instagram_business_account?.id) {
              return res.status(200).json({
                success: true,
                account: {
                  id: page.instagram_business_account.id,
                  username: page.instagram_business_account.username || page.name,
                  name: page.instagram_business_account.username || page.name,
                  pageAccessToken: page.access_token || null,
                  source: `Vinculada a la página "${page.name}"`
                }
              });
            }
          }
        }
      } catch {}

      return res.status(404).json({
        error: 'No se detectó automáticamente una cuenta de Instagram Business con ese token. Puedes ingresar el ID numérico manualmente.'
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error al consultar Instagram en Meta Graph API: ' + err.message });
    }
  }
};

export default settingsController;
