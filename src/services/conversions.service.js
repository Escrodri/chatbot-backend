import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * API de Conversiones de Meta para mensajería.
 *
 * Sirve para avisarle a Meta que una conversación terminó en una venta. Con eso
 * Meta puede atribuir la venta al anuncio que originó el chat y optimizar la
 * pauta con resultados reales en vez de con clics.
 *
 * Como la venta ocurre en una charla y no en una página web, el píxel no ve
 * nada: el evento lo manda este servidor cuando el operador marca la venta.
 *
 * Cada canal se identifica de una forma distinta, y esto es lo delicado:
 *
 *   WhatsApp   → cuenta de WhatsApp Business + el identificador del clic
 *                (ctwa_clid), que Meta manda UNA SOLA VEZ en el webhook del
 *                primer mensaje. Sin él no hay atribución posible.
 *   Messenger  → identificador de la página + el del usuario dentro de esa
 *                página (PSID), que ya guardamos de siempre.
 *   Instagram  → identificador de la cuenta + el del usuario (IGSID).
 *
 * Es opcional: si no hay credenciales configuradas, marcar una venta igual
 * queda registrado en la base, simplemente no se le informa a Meta.
 */

const API_BASE = 'https://graph.facebook.com';

/** Nombre del canal tal como lo espera Meta. */
const CANAL_META = {
  whatsapp: 'whatsapp',
  facebook: 'messenger',
  instagram: 'instagram'
};

export const conversionsService = {
  /**
   * Devuelve a qué conjunto de datos y con qué token informar, según el canal.
   *
   * Lo específico de la plataforma manda sobre lo general, porque en la práctica
   * casi nunca es el mismo destino: el conjunto de datos de WhatsApp es el que
   * Meta tiene atado a la cuenta de WhatsApp Business, mientras que Messenger e
   * Instagram informan a un píxel del negocio. Si además cada uno vive en un
   * Business Manager distinto, también cambia el token.
   *
   * @param {string} plataforma 'whatsapp' | 'facebook' | 'instagram'
   * @returns {{ datasetId: string, accessToken: string }}
   */
  resolverDestino(plataforma) {
    const general = config.conversions || {};
    const propio = general.porPlataforma?.[plataforma] || {};

    return {
      datasetId: propio.datasetId || general.datasetId || '',
      accessToken: propio.accessToken || general.accessToken || ''
    };
  },

  /**
   * ¿Hay conjunto de datos y token para informar ventas de este canal?
   * Sin argumento responde por la configuración general.
   */
  estaConfigurado(plataforma = null) {
    const destino = plataforma
      ? this.resolverDestino(plataforma)
      : { datasetId: config.conversions?.datasetId, accessToken: config.conversions?.accessToken };

    return Boolean(destino.datasetId && destino.accessToken);
  },

  /** Identificador único e irrepetible para cada venta informada. */
  generarEventId() {
    return `venta_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  },

  /**
   * Arma el bloque que identifica a la persona según el canal.
   *
   * Devuelve `null` cuando faltan los datos imprescindibles, para no mandarle a
   * Meta un evento que va a rechazar o, peor, que va a aceptar sin poder
   * atribuir a nada.
   *
   * @param {object} conversation Conversación completa (incluye datos del canal y del contacto)
   * @returns {{ userData: object }|{ error: string, code: string }}
   */
  construirUserData(conversation) {
    const plataforma = conversation.platform;

    if (plataforma === 'whatsapp') {
      if (!conversation.ctwa_clid) {
        return {
          error: 'Esta conversación no empezó desde un anuncio de clic a WhatsApp, así que Meta no tiene a qué atribuir la venta.',
          code: 'ERR_SIN_CLIC_DE_ANUNCIO'
        };
      }
      if (!conversation.waba_id) {
        return {
          error: 'Todavía no conocemos el identificador de la cuenta de WhatsApp Business. Se guarda solo con el próximo mensaje que entre.',
          code: 'ERR_SIN_CUENTA_WHATSAPP'
        };
      }
      return {
        userData: {
          whatsapp_business_account_id: String(conversation.waba_id),
          ctwa_clid: String(conversation.ctwa_clid)
        }
      };
    }

    if (plataforma === 'facebook') {
      if (!conversation.channel_identifier || !conversation.platform_user_id) {
        return {
          error: 'Faltan el identificador de la página o el de la persona para informar la venta.',
          code: 'ERR_SIN_IDENTIFICADORES'
        };
      }
      return {
        userData: {
          page_id: String(conversation.channel_identifier),
          page_scoped_user_id: String(conversation.platform_user_id)
        }
      };
    }

    if (plataforma === 'instagram') {
      if (!conversation.channel_identifier || !conversation.platform_user_id) {
        return {
          error: 'Faltan el identificador de la cuenta de Instagram o el de la persona para informar la venta.',
          code: 'ERR_SIN_IDENTIFICADORES'
        };
      }
      return {
        userData: {
          instagram_business_account_id: String(conversation.channel_identifier),
          ig_sid: String(conversation.platform_user_id)
        }
      };
    }

    return {
      error: `El canal "${plataforma}" no admite informar ventas a Meta.`,
      code: 'ERR_CANAL_NO_COMPATIBLE'
    };
  },

  /**
   * Informa una venta (u otro evento) a Meta.
   *
   * Nunca lanza: devuelve siempre un objeto que dice qué pasó, porque una falla
   * al informar no debe hacer fracasar el registro de la venta en la bandeja.
   *
   * @param {{
   *   conversation: object,
   *   eventName?: string,
   *   value?: number|null,
   *   currency?: string|null,
   *   eventId: string,
   *   eventTime?: Date
   * }} params
   * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, code?: string, respuesta?: object }>}
   */
  async informarVenta({ conversation, eventName = 'Purchase', value = null, currency = null, eventId, eventTime = new Date() }) {
    const destino = this.resolverDestino(conversation.platform);

    if (!destino.datasetId || !destino.accessToken) {
      return {
        ok: false,
        skipped: true,
        code: 'ERR_CONVERSIONES_SIN_CONFIGURAR',
        error: `Falta configurar el conjunto de datos y el token de la API de Conversiones para ${conversation.platform}. La venta quedó registrada, pero no se le informó a Meta.`
      };
    }

    const identificacion = this.construirUserData(conversation);
    if (identificacion.error) {
      return { ok: false, skipped: true, code: identificacion.code, error: identificacion.error };
    }

    const apiVersion = config.meta.apiVersion || 'v26.0';
    const canal = CANAL_META[conversation.platform];

    const evento = {
      event_name: eventName,
      event_time: Math.floor(eventTime.getTime() / 1000),
      event_id: eventId,
      action_source: 'business_messaging',
      messaging_channel: canal,
      user_data: identificacion.userData
    };

    if (value !== null && value !== undefined && currency) {
      evento.custom_data = {
        currency: String(currency).toUpperCase(),
        value: Number(value)
      };
    }

    const cuerpo = {
      data: [evento],
      access_token: destino.accessToken
    };

    if (config.conversions.testEventCode) {
      cuerpo.test_event_code = config.conversions.testEventCode;
    }

    try {
      const url = `${API_BASE}/${apiVersion}/${destino.datasetId}/events`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo)
      });

      const datos = await res.json().catch(() => ({}));

      if (!res.ok || datos.error) {
        const mensaje = datos.error?.message || `HTTP ${res.status}`;
        console.error('❌ [CONVERSIONES] Meta rechazó el evento de venta:', mensaje);
        return {
          ok: false,
          code: `ERR_META_${datos.error?.code || res.status}`,
          error: `Meta rechazó el evento: ${mensaje}`,
          respuesta: datos
        };
      }

      console.log(
        `💰 [CONVERSIONES] Venta informada a Meta (${canal}, evento ${eventId}). ` +
        `Recibidos: ${datos.events_received ?? 1}.`
      );
      return { ok: true, respuesta: datos };
    } catch (err) {
      console.error('❌ [CONVERSIONES] Error de red al informar la venta:', err.message);
      return {
        ok: false,
        code: 'ERR_RED',
        error: `No se pudo contactar a Meta: ${err.message}`
      };
    }
  }
};

export default conversionsService;
