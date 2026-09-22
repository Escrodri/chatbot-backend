import { config } from '../config/index.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { graphApiService } from './graph-api.service.js';

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

/**
 * Minutos transcurridos desde una fecha. Devuelve null si no hay fecha, que es
 * el caso del primer mensaje de una conversación.
 */
function minutosDesde(fecha) {
  if (!fecha) return null;
  const t = new Date(fecha).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

/**
 * Todo lo que sigue existe para decidir una sola cosa: si corresponde saludar.
 *
 * El servidor corre en UTC y los clientes están en Paraguay, así que la cuenta
 * hay que hacerla en hora local o el corte del día cae a las nueve de la noche.
 */
const ZONA = 'America/Asuncion';

/** Fecha en formato AAAA-MM-DD según el calendario paraguayo. */
function diaEnParaguay(fecha) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(fecha);
}

/** Hora del día (0-23) en Paraguay. */
function horaEnParaguay(fecha) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, hour: '2-digit', hour12: false
  }).formatToParts(fecha);
  const h = partes.find(p => p.type === 'hour');
  return h ? parseInt(h.value, 10) : 12;
}

/**
 * "Buen día" a secas suena a formulario. La gente saluda según la hora, y es de
 * las cosas más baratas que se pueden hacer para que no parezca un robot.
 */
function saludoSegunHora(fecha) {
  const h = horaEnParaguay(fecha);
  if (h < 12) return 'Buen día';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/**
 * ¿El mensaje anterior de esta persona fue otro día?
 *
 * Se compara el día del calendario y no una cantidad de horas, porque es así
 * como lo vive el cliente: escribir a la mañana después de haber escrito anoche
 * es "otro día" aunque hayan pasado solo nueve horas, y escribir a las once de
 * la noche después de haber escrito a las nueve de la mañana sigue siendo el
 * mismo día aunque hayan pasado catorce.
 */
function esOtroDia(ultimaInteraccion) {
  if (!ultimaInteraccion) return true;
  const antes = new Date(ultimaInteraccion);
  if (isNaN(antes.getTime())) return true;
  return diaEnParaguay(antes) !== diaEnParaguay(new Date());
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

/**
 * Agrupador de mensajes.
 *
 * La gente no escribe un párrafo y lo manda: manda "hola", después "queria
 * consultar algo", después la pregunta. Tres mensajes en diez segundos. Si el
 * bot contesta cada uno por separado, salen tres respuestas encimadas y no hay
 * nada que delate más rápido que del otro lado hay una máquina — ninguna
 * persona lee y responde tres veces en diez segundos.
 *
 * Así que cada mensaje entrante reinicia un temporizador. Cuando la persona
 * deja de escribir por unos segundos, recién ahí sale una sola respuesta con
 * todo lo que dijo. Es el mismo comportamiento de alguien que mira el teléfono,
 * lee las tres líneas y contesta una vez.
 *
 * Lo que se pierde: si el servidor se reinicia con mensajes en cola, esos
 * mensajes no se contestan. Son unos pocos segundos de ventana y el mensaje del
 * cliente quedó guardado igual en la bandeja, así que el costo es que alguien
 * tenga que contestar a mano un chat. Aceptable frente a lo que se gana.
 */
const enCola = new Map();

/**
 * Enciende el "escribiendo…" en el teléfono del cliente. No se espera el
 * resultado: es decoración, y si falla no puede demorar la respuesta real.
 */
function mostrarEscribiendo(channel, message) {
  const metaId = message?.meta_message_id;
  if (!metaId) return;

  (async () => {
    try {
      const canal = await channelRepository.findById(channel.id);
      if (!canal?.accessToken) return;
      await graphApiService.marcarLeidoYEscribiendo({
        channel: canal,
        accessToken: canal.accessToken,
        metaMessageId: metaId
      });
    } catch (err) {
      console.warn('⚠️ [ESCRIBIENDO] No se pudo mostrar el indicador:', err.message);
    }
  })();
}

function programarDespacho(clave, grupo) {
  grupo.timer = setTimeout(() => {
    enCola.delete(clave);
    automationService.despachar(grupo).catch(err => {
      console.error('❌ [AUTOMATION] Falló el despacho agrupado:', err.message);
    });
  }, config.automation?.debounceMs ?? 8000);

  // Que un temporizador pendiente no impida que el proceso termine.
  if (typeof grupo.timer.unref === 'function') grupo.timer.unref();
}

function encolar({ conversation, contact, channel, message }) {
  const clave = conversation.id;
  const grupo = enCola.get(clave) || { mensajes: [], timer: null };

  // Siempre se guarda la versión más reciente: el nombre del contacto o el
  // estado del bot pueden haber cambiado entre una línea y la siguiente.
  //
  // Menos una cosa: cuándo había escrito esta persona por última vez. Eso se
  // toma del primer mensaje del grupo y no se vuelve a tocar, porque para
  // cuando llega la tercera línea la respuesta correcta sería "hace ocho
  // segundos" y el bot no saludaría nunca a alguien que arranca escribiendo
  // "hola", enter, "buenas", enter, "consulta".
  const previa = grupo.conversation
    ? grupo.conversation.interaccion_previa
    : conversation.interaccion_previa;

  grupo.conversation = { ...conversation, interaccion_previa: previa ?? null };
  grupo.contact = contact;
  grupo.channel = channel;
  grupo.mensajes.push(message);

  if (grupo.timer) clearTimeout(grupo.timer);

  // Una imagen no se hace esperar. Quien manda un comprobante quiere una
  // respuesta ya, y además no hay razón para pensar que va a seguir escribiendo.
  const esTexto = (message.content_type || 'text') === 'text';
  if (!esTexto) {
    enCola.delete(clave);
    automationService.despachar(grupo).catch(err => {
      console.error('❌ [AUTOMATION] Falló el despacho inmediato:', err.message);
    });
    return { ok: true, motivo: null, detalle: null, avisar: false, mensaje: null, en: ahora() };
  }

  // Mientras se junta lo que sigue escribiendo, del otro lado se ve el mensaje
  // como leído y los tres puntitos. Sin esto la espera se siente como un chat
  // abandonado; con esto, como alguien redactando.
  mostrarEscribiendo(channel, message);

  programarDespacho(clave, grupo);
  enCola.set(clave, grupo);

  return {
    ok: true,
    motivo: 'en_cola',
    detalle: `${grupo.mensajes.length} línea(s) en espera`,
    avisar: false,
    mensaje: null,
    en: ahora()
  };
}

/**
 * Devuelve el chat al bot si el equipo lo dejó abandonado demasiado tiempo.
 *
 * Pasarle una conversación a una persona estaba bien pensado para el horario
 * de trabajo y mal pensado para el resto del día. El que manda un comprobante
 * a las once de la noche dispara el handover, y a partir de ahí el bot no
 * vuelve a hablar: si a las dos de la mañana escribe "hola?, sigue ahí?", no
 * le contesta nadie hasta que alguien abra la bandeja. Del otro lado eso no se
 * lee como "están durmiendo", se lee como que lo estafaron.
 *
 * Así que el handover deja de ser definitivo y pasa a tener vencimiento: si
 * hace más de N horas que ninguna persona del equipo escribió en ese chat, el
 * bot lo retoma. Y lo retoma con todo lo que sabe hacer, incluida la IA, que
 * es justo para lo que está: contestar lo que el guion no sabe.
 *
 * Mientras el asesor esté atendiendo, cada mensaje suyo corre el reloj de
 * nuevo, así que esto no puede pisar una conversación activa.
 *
 * @param {object} conversation
 * @returns {Promise<boolean>} true si el bot recuperó el chat
 */
async function reactivarSiQuedoAbandonado(conversation) {
  // 'disabled' es una decisión explícita: alguien apagó el bot para este chat
  // y no es asunto de un temporizador revertirla.
  if (conversation.bot_status !== 'handed_over') return false;

  const horas = config.automation?.reactivarTrasHoras ?? 12;
  if (!horas || horas <= 0) return false;

  try {
    const estado = await conversationRepository.estadoDelBot(conversation.id);

    // Ya no está en manos de una persona: alguien lo reactivó por su cuenta.
    if (!estado || estado.bot_status !== 'handed_over') {
      return estado?.bot_status === 'active';
    }

    // Sin fecha anotada, el handover es anterior a que existiera la columna.
    // Se lo toma por vencido: si ese chat sigue esperando desde entonces, es
    // exactamente el caso que esto viene a resolver.
    const desde = estado.handed_over_at ? new Date(estado.handed_over_at).getTime() : 0;
    const transcurridas = (Date.now() - desde) / 3_600_000;

    if (transcurridas < horas) return false;

    await conversationRepository.updateBotStatus(conversation.id, 'active');
    console.info(
      `🤖 [AUTOMATION] Conversación #${conversation.id} vuelve al bot: ` +
      `${Math.floor(transcurridas)}h sin que nadie del equipo conteste.`
    );
    return true;
  } catch (err) {
    // Si esto falla, el chat se queda con la persona. Es el lado seguro del
    // error: peor que un cliente esperando es el bot hablando encima de alguien.
    console.warn('⚠️ [AUTOMATION] No se pudo revisar el handover vencido:', err.message);
    return false;
  }
}

export const automationService = {
  /**
   * Tira a la basura lo que esa conversación tenga esperando en la cola.
   *
   * Entre que alguien escribe y que el bot contesta pasan unos segundos. Si en
   * ese hueco se reinicia la conversación para volver a probar, el temporizador
   * sigue corriendo con mensajes que ya no existen en la base: el despacho sale
   * igual, el guion lo lee sobre un chat vacío y contesta algo que no tiene
   * nada que ver con lo que se está probando. Se pierden diez minutos buscando
   * un error en el flujo que en realidad es un mensaje viejo llegando tarde.
   *
   * @param {number} conversationId
   * @returns {number} Cuántas líneas quedaron sin despachar
   */
  cancelarCola(conversationId) {
    const grupo = enCola.get(conversationId);
    if (!grupo) return 0;

    if (grupo.timer) clearTimeout(grupo.timer);
    enCola.delete(conversationId);

    return grupo.mensajes?.length || 0;
  },

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
  /**
   * Recibe un mensaje entrante y lo pone en cola en vez de contestarlo al toque.
   *
   * Ver el comentario del agrupador, más arriba. Lo importante acá: esta función
   * ya no manda nada, solo decide si corresponde y encola. El envío real ocurre
   * unos segundos después, en `despachar`, con todo lo que la persona haya
   * escrito mientras tanto junto.
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
      // Un chat en manos de una persona puede haber quedado ahí de casualidad:
      // el asesor se fue a dormir, era domingo, nadie lo miró. Antes de callar
      // al bot se chequea hace cuánto que nadie del equipo contesta.
      const retomado = await reactivarSiQuedoAbandonado(conversation);

      if (!retomado) {
        console.info(
          `ℹ️ [AUTOMATION] Conversación #${conversation.id} en estado "${conversation.bot_status}": ` +
          'no se reenvía a n8n porque el chat está en manos de una persona. ' +
          'Para que vuelva a contestar el bot, reactivalo desde la bandeja.'
        );
        return resultado({ ok: false, motivo: MOTIVOS.BOT_PAUSADO, detalle: conversation.bot_status, conversationId: conversation.id });
      }

      conversation.bot_status = 'active';
    }

    return encolar({ conversation, contact, channel, message });
  },

  /**
   * Manda a n8n todo lo que se juntó de una conversación, como un solo mensaje.
   *
   * No se llama desde afuera: la dispara el temporizador del agrupador.
   */
  async despachar(grupo) {
    const { conversation, contact, channel, mensajes } = grupo;

    // Última verificación antes de hablar, contra la base y no contra la copia
    // que quedó guardada al encolar.
    //
    // Entre que el cliente escribió y este momento pasaron unos segundos, y en
    // esos segundos el asesor pudo haber tomado el chat: abrió la bandeja, vio
    // el mensaje y contestó a mano. La copia de la conversación que arrastra la
    // cola sigue diciendo que el bot manda, porque se sacó antes de todo eso.
    // Sin este chequeo el bot manda su respuesta igual, encima de la de la
    // persona, y el cliente recibe dos contestaciones distintas a lo mismo.
    try {
      const estado = await conversationRepository.estadoDelBot(conversation.id);
      if (estado && estado.bot_status !== 'active') {
        console.info(
          `ℹ️ [AUTOMATION] Conversación #${conversation.id}: se cancela la respuesta automática, ` +
          'una persona tomó el chat mientras se juntaban los mensajes.'
        );
        return resultado({ ok: false, motivo: MOTIVOS.BOT_PAUSADO, detalle: estado.bot_status, conversationId: conversation.id });
      }
    } catch (err) {
      console.warn('⚠️ [AUTOMATION] No se pudo confirmar el estado del bot antes de despachar:', err.message);
    }

    // El último mensaje manda para el tipo: si alguien escribe "ya pagué" y
    // después manda la captura, lo que importa es la captura.
    const ultimo = mensajes[mensajes.length - 1];

    // El texto va todo junto, en el orden en que lo escribieron. Para n8n es
    // un solo mensaje de varias líneas, que es exactamente como lo lee una
    // persona que mira la pantalla después de un rato.
    const textoJunto = mensajes
      .map(m => (m.text || '').trim())
      .filter(Boolean)
      .join('\n');

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
        id: ultimo.id,
        type: ultimo.content_type || 'text',
        text: textoJunto,
        media_url: ultimo.media_url || null,
        meta_media_id: ultimo.meta_media_id || null
      },

      // Cuántas líneas mandó de corrido. Sirve para saber, mirando una
      // ejecución, si el agrupador está haciendo su trabajo.
      lineas_agrupadas: mensajes.length,

      bot_status: conversation.bot_status,

      // Cuánto hace que esta persona no escribía, en minutos.
      //
      // Sirve para una sola cosa, pero importante: saber si corresponde
      // saludar. Un bot que dice "hola de nuevo" treinta segundos después del
      // último mensaje suena a máquina, y es de las cosas que más rápido
      // delatan que del otro lado no hay nadie.
      //
      // Se usa `interaccion_previa` y no `last_customer_interaction`. No son lo
      // mismo: para cuando el mensaje llega hasta acá, la segunda ya fue
      // pisada con la hora de este mismo mensaje, así que siempre dice "hace
      // cero minutos" y siempre da falso el primer contacto. Con ese dato el
      // bot no saludó nunca a nadie: arrancaba todas las conversaciones del
      // mundo con "Dale!", como si viniera contestando desde antes.
      //
      // `interaccion_previa` es la foto tomada antes de tocar la fila, y en el
      // primer mensaje de una conversación viene null.
      minutos_desde_ultimo_mensaje: minutosDesde(conversation.interaccion_previa),

      // Es la primera vez que esta persona escribe. Solo acá corresponde
      // presentarse; repetir "soy el asistente de Lecturas de Tarde" cada
      // mañana es de las cosas que más cansan de un bot.
      primer_contacto: !conversation.interaccion_previa,

      // El mensaje anterior fue otro día del calendario paraguayo.
      dia_distinto: esOtroDia(conversation.interaccion_previa),

      // "Buen día", "Buenas tardes" o "Buenas noches" según la hora en Paraguay.
      saludo_hora: saludoSegunHora(new Date()),

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
