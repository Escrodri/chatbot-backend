import { config } from '../config/index.js';

/**
 * Puente hacia n8n.
 *
 * Meta manda sus webhooks a UNA sola dirección, y esa dirección es este backend:
 * acá viven la validación de firma, la deduplicación por meta_message_id, el
 * cifrado de los tokens de canal y la bandeja que ven los asesores. Nada de eso
 * se mueve. Lo que hace este servicio es reenviarle a n8n una copia ya limpia
 * del mensaje entrante, para que arme la respuesta.
 *
 * n8n no le habla a Meta: contesta llamando de vuelta a
 * POST /api/conversations/:id/messages con la cabecera x-service-token. Así la
 * respuesta del bot queda guardada, aparece en la bandeja y reutiliza el token
 * cifrado del canal como cualquier otro mensaje.
 *
 * El reenvío nunca puede tumbar la recepción del webhook: si n8n está caído o
 * tarda, se registra el problema y el mensaje del cliente queda guardado igual.
 *
 * Antes este servicio devolvía un booleano pelado y abandonaba en silencio
 * cuando la conversación no estaba en turno del bot. Eso hacía imposible
 * distinguir "n8n está caído" de "el bot no tenía que hablar": las dos cosas se
 * veían igual desde afuera, es decir, no se veían. Ahora cada salida deja dicho
 * por qué, queda en memoria para que la bandeja lo muestre, y solo las fallas
 * reales piden atención humana.
 */

/** Razones por las que un mensaje no termina en n8n. */
export const MOTIVOS = Object.freeze({
  APAGADA: 'apagada',
  SIN_URL: 'sin_url',
  BOT_PAUSADO: 'bot_pausado',
  HTTP: 'http',
  TIMEOUT: 'timeout',
  RED: 'red'
});

/** Texto para humanos de cada motivo. Lo usa el aviso de la bandeja. */
const TEXTO = Object.freeze({
  [MOTIVOS.APAGADA]: 'La automatización está apagada: AUTOMATION_ENABLED no vale true.',
  [MOTIVOS.SIN_URL]: 'Falta configurar N8N_WEBHOOK_URL.',
  [MOTIVOS.BOT_PAUSADO]: 'Un asesor tomó la conversación, así que el bot no interviene.',
  [MOTIVOS.HTTP]: 'n8n contestó con un código de error.',
  [MOTIVOS.TIMEOUT]: 'n8n no contestó a tiempo.',
  [MOTIVOS.RED]: 'No se pudo abrir la conexión con n8n.'
});

/**
 * Motivos que merecen molestar a una persona. Que el bot esté en pausa o que la
 * automatización esté apagada son decisiones tomadas a propósito, no averías.
 */
const MOTIVOS_DE_AVERIA = new Set([MOTIVOS.HTTP, MOTIVOS.TIMEOUT, MOTIVOS.RED, MOTIVOS.SIN_URL]);

/**
 * Memoria corta del último resultado.
 *
 * No reemplaza a los logs del servidor: existe para que la bandeja pueda
 * preguntar "¿esto anda?" con un GET, en lugar de obligar a alguien a entrar al
 * panel del hosting a leer la salida del contenedor.
 */
const estado = {
  ultimoIntento: null,
  ultimoExito: null,
  ultimoFallo: null,
  fallosSeguidos: 0,
  enviadosOk: 0
};

function ahora() {
  return new Date().toISOString();
}

function resultado({ ok, motivo = null, detalle = null, conversationId = null }) {
  const salida = {
    ok,
    motivo,
    detalle,
    conversationId,
    // Solo las averías piden atención; una pausa deliberada no.
    avisar: Boolean(!ok && motivo && MOTIVOS_DE_AVERIA.has(motivo)),
    mensaje: motivo ? TEXTO[motivo] || motivo : null,
    en: ahora()
  };

  estado.ultimoIntento = salida;

  if (ok) {
    estado.ultimoExito = salida;
    estado.fallosSeguidos = 0;
    estado.enviadosOk += 1;
  } else if (salida.avisar) {
    estado.ultimoFallo = salida;
    estado.fallosSeguidos += 1;
  }

  return salida;
}

export const automationService = {
  /**
   * ¿Está la automatización configurada y encendida?
   */
  estaActiva() {
    return Boolean(config.automation?.webhookUrl && config.automation?.enabled);
  },

  /**
   * Foto del estado para el endpoint de diagnóstico y para la bandeja.
   */
  diagnostico() {
    return {
      habilitada: Boolean(config.automation?.enabled),
      urlConfigurada: Boolean(config.automation?.webhookUrl),
      tokenConfigurado: Boolean(config.automation?.serviceToken),
      url: config.automation?.webhookUrl || null,
      timeoutMs: config.automation?.timeoutMs ?? null,
      enviadosOk: estado.enviadosOk,
      fallosSeguidos: estado.fallosSeguidos,
      ultimoIntento: estado.ultimoIntento,
      ultimoExito: estado.ultimoExito,
      ultimoFallo: estado.ultimoFallo,
      // Hay problema mientras el último intento haya sido una avería y no se
      // haya recuperado después.
      hayProblema: estado.fallosSeguidos > 0
    };
  },

  /**
   * Borra el aviso una vez que alguien lo leyó en la bandeja.
   */
  reconocerFallo() {
    estado.fallosSeguidos = 0;
    estado.ultimoFallo = null;
  },

  /**
   * Comprueba que n8n esté escuchando, sin disparar el flujo.
   *
   * Se hace un GET a la misma URL del webhook. El nodo está declarado para POST,
   * así que n8n va a contestar 404 o 405: cualquiera de las dos sirve, porque lo
   * que se quiere saber es si hay alguien del otro lado, no si acepta el método.
   * Un fallo de red, en cambio, sí significa que n8n no está.
   *
   * @returns {Promise<{alcanzable: boolean, status: number|null, detalle: string|null, latenciaMs: number|null}>}
   */
  async probarConexion() {
    const url = config.automation?.webhookUrl;
    if (!url) {
      return { alcanzable: false, status: null, detalle: TEXTO[MOTIVOS.SIN_URL], latenciaMs: null };
    }

    const controlador = new AbortController();
    const corte = setTimeout(() => controlador.abort(), config.automation.timeoutMs);
    const arranque = Date.now();

    try {
      const respuesta = await fetch(url, { method: 'GET', signal: controlador.signal });
      return {
        alcanzable: true,
        status: respuesta.status,
        detalle: null,
        latenciaMs: Date.now() - arranque
      };
    } catch (err) {
      const detalle = err.name === 'AbortError'
        ? `no respondió en ${config.automation.timeoutMs}ms`
        : err.message;
      return { alcanzable: false, status: null, detalle, latenciaMs: Date.now() - arranque };
    } finally {
      clearTimeout(corte);
    }
  },

  /**
   * Reenvía un mensaje entrante a n8n.
   *
   * @param {{
   *   conversation: object,
   *   contact: object,
   *   channel: object,
   *   message: object
   * }} params
   * @returns {Promise<{ok: boolean, motivo: string|null, detalle: string|null, avisar: boolean, mensaje: string|null, en: string}>}
   */
  async reenviarMensajeEntrante({ conversation, contact, channel, message }) {
    if (!config.automation?.enabled) {
      return resultado({ ok: false, motivo: MOTIVOS.APAGADA, conversationId: conversation?.id ?? null });
    }

    if (!config.automation?.webhookUrl) {
      console.warn('⚠️ [AUTOMATION] AUTOMATION_ENABLED=true pero N8N_WEBHOOK_URL está vacía.');
      return resultado({ ok: false, motivo: MOTIVOS.SIN_URL, conversationId: conversation?.id ?? null });
    }

    // El bot solo habla cuando la conversación está en su turno. Si un asesor
    // tomó el chat, n8n no se entera del mensaje y no puede pisarlo.
    //
    // Esto se registra igual: es la causa más fácil de confundir con una caída,
    // porque el cliente escribe, el mensaje aparece en la bandeja y nadie
    // contesta, exactamente igual que si n8n estuviera muerto.
    if (conversation.bot_status !== 'active') {
      console.info(
        `ℹ️ [AUTOMATION] Conversación #${conversation.id} en estado "${conversation.bot_status}": ` +
        'no se reenvía a n8n porque el chat está en manos de una persona. ' +
        'Para que vuelva a contestar el bot, reactivalo desde la bandeja.'
      );
      return resultado({ ok: false, motivo: MOTIVOS.BOT_PAUSADO, detalle: conversation.bot_status, conversationId: conversation.id });
    }

    const payload = {
      conversation_id: conversation.id,
      channel_id: channel.id,
      platform: channel.platform,
      contact: {
        id: contact.id,
        name: contact.name || null,
        phone: contact.platform_user_id || contact.phone_or_username || null
      },
      message: {
        id: message.id,
        type: message.content_type || 'text',
        text: message.text || '',
        media_url: message.media_url || null,
        meta_media_id: message.meta_media_id || null
      },
      bot_status: conversation.bot_status,
      enviado_en: ahora()
    };

    const controlador = new AbortController();
    const corte = setTimeout(() => controlador.abort(), config.automation.timeoutMs);

    try {
      const respuesta = await fetch(config.automation.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': config.automation.serviceToken || ''
        },
        body: JSON.stringify(payload),
        signal: controlador.signal
      });

      if (!respuesta.ok) {
        // El cuerpo de la respuesta suele decir exactamente qué pasó: un 404 acá
        // casi siempre es el flujo desactivado o la URL apuntando a /webhook-test/.
        const cuerpo = await respuesta.text().catch(() => '');
        const detalle = `HTTP ${respuesta.status}${cuerpo ? ` — ${cuerpo.slice(0, 300)}` : ''}`;
        console.warn(
          `⚠️ [AUTOMATION] n8n respondió ${respuesta.status} para la conversación #${conversation.id}. ${detalle}`
        );
        return resultado({ ok: false, motivo: MOTIVOS.HTTP, detalle, conversationId: conversation.id });
      }

      console.info(`✅ [AUTOMATION] Mensaje de la conversación #${conversation.id} reenviado a n8n.`);
      return resultado({ ok: true, conversationId: conversation.id });
    } catch (err) {
      const esTimeout = err.name === 'AbortError';
      const detalle = esTimeout
        ? `no respondió en ${config.automation.timeoutMs}ms`
        : err.message;
      console.warn(
        `⚠️ [AUTOMATION] No se pudo avisar a n8n (${detalle}). El mensaje del cliente quedó guardado igual.`
      );
      return resultado({
        ok: false,
        motivo: esTimeout ? MOTIVOS.TIMEOUT : MOTIVOS.RED,
        detalle,
        conversationId: conversation.id
      });
    } finally {
      clearTimeout(corte);
    }
  }
};

export default automationService;
