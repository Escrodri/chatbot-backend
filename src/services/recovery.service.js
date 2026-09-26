import { orderRepository } from '../repositories/order.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { settingRepository } from '../repositories/setting.repository.js';
import { graphApiService } from './graph-api.service.js';
import { socketManager } from '../sockets/index.js';
import { timeUtil } from '../utils/time.util.js';
import {
  envConfig,
  enHorarioDeSilencio,
  proximoHorarioParaEscribir
} from '../config/env.config.js';
import { precioParaPersona, registrarOfertaRecuperacion } from './precio.service.js';

export const CLAVE_AJUSTE_MENSAJES = 'mensajes_recuperacion';

export const DEFAULT_MENSAJES_RECUPERACION = Object.freeze({
  nivel_1_decidido: '¡Hola, {{nombre}}! 🤍\nTe escribo por las dudas: ¿tuviste algún inconveniente con la transferencia o necesitás ayuda con algún dato bancario?\nAvisame y te ayudo con gusto así tus peques ya pueden tener sus historias listas para colorear hoy mismo 🙌🏻✨',
  nivel_1_mirando: '¡Hola, {{nombre}}! 🤍\n¿Te quedó alguna duda con {{producto}}? Si querés te muestro unas páginas por dentro o me preguntás lo que necesites, con total confianza 🙌🏻',
  nivel_2_decidido: '¡Hola, {{nombre}}! 🤍\nSi lo que te frenó fue el monto, te lo puedo dejar en {{precio}}. ¿Te paso los datos así lo cerramos hoy mismo? 🙌🏻',
  nivel_2_mirando: '¡Hola, {{nombre}}! 🤍\nTe hago una propuesta especial: {{producto}} te lo puedo dejar hoy en {{precio}}. Si te interesa, decime y te paso los datos 🙌🏻',
  nivel_3: '¡Hola, {{nombre}}! No quiero insistir de más, así que te dejo esto simple:\n\nSi todavía querés {{producto}}, te lo dejo en {{precio}} y te paso los datos ahora mismo.\n\nY si no era para vos, todo bien igual. Acá quedo si algún día lo necesitás 🤍'
});

/**
 * Recuperación de abandonos: volver a escribirle al que se quedó a mitad.
 *
 * La mayoría de las conversaciones no terminan en "no". Terminan en nada: la
 * persona mira el precio, dice que lo va a pensar, y se va. Nadie vuelve solo.
 *
 * Tres escalones y se termina, contados desde el último movimiento de la
 * persona: a las 2 horas un recordatorio al precio de siempre, a las 8 y a las
 * 20 el precio de recuperación si el producto tiene uno cargado. El cuarto
 * mensaje no existe a propósito. No recupera a nadie y sí consigue que
 * reporten el número, y un número reportado no vende más nunca.
 *
 * Tres reglas que no se negocian, y cada una está acá porque romperla cuesta
 * plata o cuesta el número:
 *
 * 1. Nada entre las 21:00 y las 08:00 de Paraguay. Un recordatorio a las tres
 *    de la mañana despierta a alguien para ofrecerle un PDF, y eso no se
 *    perdona: no cancela una venta, la convierte en un reporte.
 *
 * 2. Nada fuera de la ventana de 24 horas de Meta. Dentro es gratis; fuera hay
 *    que mandar una plantilla aprobada y se paga entre Gs. 300 y 900 por
 *    mensaje. Pagar eso por insistirle a alguien que se fue hace un día es
 *    tirar el margen de la venta que no hubo.
 *
 * 3. Un solo mensaje por pasada y por persona. Si un pedido quedó con dos
 *    seguimientos vencidos —porque los dos cayeron de madrugada y esperaron
 *    juntos a la mañana— sale únicamente el más avanzado. Dos mensajes
 *    seguidos a las ocho de la mañana no son dos oportunidades: son un bot
 *    descargando su cola encima de alguien que recién se despertó.
 */

/** Los estados del ciclo, para que el registro se lea de un vistazo. */
const MOTIVOS = Object.freeze({
  enviado: 'enviado',
  silencio: 'horario_silencio',
  ventana: 'ventana_cerrada',
  humano: 'lo_atiende_una_persona',
  fallo: 'meta_rechazo'
});

/** Elige al azar una de las variantes. */
function variar(opciones) {
  return opciones[Math.floor(Math.random() * opciones.length)];
}

/**
 * Arranca la frase en mayúscula cuando no hay nombre adelante.
 *
 * Los textos están escritos como "{nombre}, te escribo por…", y cuando Meta no
 * da el nombre real el mensaje empezaba en minúscula. Es un detalle chico y es
 * exactamente de los que delatan que el texto lo armó una plantilla.
 *
 * Salta los signos de apertura, que en castellano van antes de la mayúscula.
 */
function empezarEnMayuscula(texto) {
  const i = texto.search(/[^¿¡\s]/);
  if (i < 0) return texto;
  return texto.slice(0, i) + texto.charAt(i).toUpperCase() + texto.slice(i + 1);
}

/** Gs. 15.000 y no 15000: el número suelto se lee como un error de carga. */
function formatearMonto(valor, moneda = 'PYG') {
  const numero = Number(valor) || 0;
  const locales = { PYG: 'es-PY', USD: 'en-US', ARS: 'es-AR', BRL: 'pt-BR' };
  const simbolos = { PYG: 'Gs.', USD: 'US$', ARS: '$', BRL: 'R$' };

  const formateado = new Intl.NumberFormat(locales[moneda] || 'es-PY', {
    maximumFractionDigits: moneda === 'PYG' ? 0 : 2
  }).format(numero);

  return `${simbolos[moneda] || ''} ${formateado}`.trim();
}

/**
 * El nombre de pila, o vacío.
 *
 * Vacío incluye los nombres que Meta inventa cuando no tiene el real
 * ("Usuario 4821"): escribirle "Hola Usuario 4821" es peor que no saludar por
 * nombre, porque muestra exactamente de dónde salió el mensaje.
 */
function primerNombre(candidato) {
  const bruto = (candidato.contact_name || '').trim();
  if (!bruto || /^usuario\s*\d*$/i.test(bruto)) return '';
  return bruto.split(/\s+/)[0];
}

/**
 * ¿Esta persona apenas miró, o ya había decidido comprar?
 *
 * La diferencia importa más que el tiempo transcurrido. Al que pidió los datos
 * de la transferencia y no transfirió no le falta información: algo se le
 * cruzó, o se arrepintió del monto. Al que solo vio el precio todavía le
 * faltan razones. Mandarle el mismo mensaje a los dos desperdicia el único
 * mensaje que se tiene.
 */
function segmento(etapa) {
  return (etapa === 'pidio_comprar' || etapa === 'recibio_datos') ? 'decidido' : 'mirando';
}

export const recoveryService = {
  MOTIVOS,

  /**
   * Arma el texto del seguimiento.
   *
   * Todos terminan en una pregunta y ninguno trae botones. El "sí" vuelve como
   * texto y lo lee el mismo detector del guion, que ya lo manda a los datos de
   * la transferencia: así el precio y la cuenta los sigue diciendo el flujo, en
   * un solo lugar, y este servicio no tiene que saber en qué banco cobramos.
   *
   * Lo que sí evita es prometer algo que después no se cumple. No hay cuentas
   * regresivas ni "últimas unidades" de un PDF, porque son mentira y cuando se
   * notan se llevan puesta la única cosa que hace que alguien transfiera a un
   * desconocido.
   *
   * @param {object} candidato Fila de `paraRecuperar`
   * @param {number} nivel 1, 2 o 3
   * @returns {string}
   */
  /**
   * Obtiene los mensajes de recuperación vigentes (de la tabla ajustes o defaults).
   */
  async obtenerMensajesConfigurados() {
    try {
      const guardados = await settingRepository.leer(CLAVE_AJUSTE_MENSAJES, null);
      return {
        ...DEFAULT_MENSAJES_RECUPERACION,
        ...(guardados || {})
      };
    } catch (err) {
      console.warn('⚠️ [RECUPERACION] No se pudieron leer mensajes de ajustes:', err.message);
      return { ...DEFAULT_MENSAJES_RECUPERACION };
    }
  },

  /**
   * Guarda los mensajes de recuperación editados por el usuario.
   */
  async guardarMensajesConfigurados(mensajes, userId = null) {
    const limpios = {
      nivel_1_decidido: String(mensajes.nivel_1_decidido || '').trim() || DEFAULT_MENSAJES_RECUPERACION.nivel_1_decidido,
      nivel_1_mirando: String(mensajes.nivel_1_mirando || '').trim() || DEFAULT_MENSAJES_RECUPERACION.nivel_1_mirando,
      nivel_2_decidido: String(mensajes.nivel_2_decidido || '').trim() || DEFAULT_MENSAJES_RECUPERACION.nivel_2_decidido,
      nivel_2_mirando: String(mensajes.nivel_2_mirando || '').trim() || DEFAULT_MENSAJES_RECUPERACION.nivel_2_mirando,
      nivel_3: String(mensajes.nivel_3 || '').trim() || DEFAULT_MENSAJES_RECUPERACION.nivel_3
    };
    await settingRepository.guardar(CLAVE_AJUSTE_MENSAJES, limpios, userId);
    return limpios;
  },

  /**
   * Restablece los mensajes a sus valores originales por defecto.
   */
  async restablecerMensajes(userId = null) {
    await settingRepository.guardar(CLAVE_AJUSTE_MENSAJES, { ...DEFAULT_MENSAJES_RECUPERACION }, userId);
    return { ...DEFAULT_MENSAJES_RECUPERACION };
  },

  /**
   * Arma el texto del seguimiento usando la plantilla configurada e interpolando variables.
   *
   * @param {object} candidato Fila de `paraRecuperar`
   * @param {number} nivel 1, 2 o 3
   * @returns {Promise<string>}
   */
  async armarMensaje(candidato, nivel) {
    const crudo = await this.redactar(candidato, nivel);
    return empezarEnMayuscula(crudo);
  },

  /** El texto procesado con variables. */
  async redactar(candidato, nivel) {
    const nombre = primerNombre(candidato);
    const producto = candidato.product_name || 'el material';
    const moneda = candidato.product_currency || candidato.currency || 'PYG';

    const rebajado = this.descuentoPara(candidato);
    const precio = rebajado > 0
      ? formatearMonto(rebajado, moneda)
      : (candidato.precio_vigente ? formatearMonto(candidato.precio_vigente, moneda) : '');

    const cual = segmento(candidato.etapa);
    const cfg = await this.obtenerMensajesConfigurados();

    let plantilla = '';
    if (nivel === 1) {
      plantilla = cual === 'decidido' ? cfg.nivel_1_decidido : cfg.nivel_1_mirando;
    } else if (nivel === 2) {
      plantilla = cual === 'decidido' ? cfg.nivel_2_decidido : cfg.nivel_2_mirando;
    } else {
      plantilla = cfg.nivel_3;
    }

    let texto = plantilla
      .replace(/\{\{\s*nombre\s*\}\}/gi, nombre || '')
      .replace(/\[\s*nombre\s*\]/gi, nombre || '')
      .replace(/\{\{\s*producto\s*\}\}/gi, producto)
      .replace(/\{\{\s*precio\s*\}\}/gi, precio)
      .replace(/\{\{\s*moneda\s*\}\}/gi, moneda);

    // Si no había nombre de persona, limpiar saludos residuales como "¡Hola, !" -> "¡Hola!"
    if (!nombre) {
      texto = texto
        .replace(/¡Hola,\s*!/gi, '¡Hola!')
        .replace(/Hola,\s*!/gi, 'Hola!')
        .replace(/,\s*,/g, ',')
        .replace(/^[,\s]+/g, '')
        .replace(/\s{2,}/g, ' ');
    }

    return texto.trim();
  },

  /**
   * El precio de recuperación que se le puede ofrecer, o 0 si no hay.
   *
   * Se compara contra el precio que esta persona YA tiene, no contra el de
   * lista. Si entró por el anuncio de remarketing a 15.000 y el seguimiento
   * le ofreciera "te lo dejo en 15.000", le estaría vendiendo como descuento
   * lo que ya tenía, y si la campaña es de 12.000, le estaría subiendo el
   * precio con cara de rebaja.
   *
   * Solo es un descuento si es más barato. Un precio de recuperación cargado
   * más alto que el real sería un error de tipeo, y anunciarlo como oferta es
   * la clase de cosa que se descubre en la reseña.
   *
   * @param {object} candidato Con `precio_vigente` si ya se calculó
   * @returns {number}
   */
  descuentoPara(candidato) {
    const vigente = Number(candidato.precio_vigente || candidato.product_price || candidato.amount) || 0;
    const rebajado = Number(candidato.precio_recuperacion) || 0;
    return rebajado > 0 && vigente > 0 && rebajado < vigente ? rebajado : 0;
  },

  /**
   * ¿Qué escalón le toca a este pedido, si le toca alguno?
   *
   * @param {object} candidato
   * @returns {number} 0 si todavía no le toca nada
   */
  nivelQueCorresponde(candidato) {
    const escalones = envConfig.recuperacion.escalones;
    const yaHecho = Number(candidato.recuperacion_nivel) || 0;
    const silencio = Number(candidato.minutos_silencio) || 0;

    // Se recorre de atrás para adelante: si dos escalones están vencidos
    // —porque los dos esperaron a que terminara la franja de silencio— sale
    // solo el más avanzado. Esa es la regla de no descargar la cola encima de
    // alguien a las ocho de la mañana.
    for (let i = escalones.length - 1; i >= 0; i--) {
      if (i + 1 > yaHecho && silencio >= escalones[i]) return i + 1;
    }

    return 0;
  },

  /**
   * ¿Se le puede escribir gratis a esta persona, y ahora?
   *
   * @param {object} candidato
   * @returns {{ puede: boolean, motivo: string|null }}
   */
  sePuedeEscribir(candidato) {
    // 1. Si lo está atendiendo una persona, el bot no habla. La única
    //    excepción es el chat que quedó abandonado en manos de nadie más
    //    horas que las configuradas, que es la misma regla que ya usa el
    //    guion para retomar la conversación.
    if (candidato.bot_status === 'handed_over') {
      const desde = candidato.handed_over_at ? new Date(candidato.handed_over_at).getTime() : 0;
      const horas = desde ? (Date.now() - desde) / 3600000 : Infinity;
      if (horas < envConfig.automation.reactivarTrasHoras) {
        return { puede: false, motivo: MOTIVOS.humano };
      }
    }

    // 2. Horario de silencio. No es un descarte: el seguimiento espera.
    if (enHorarioDeSilencio()) {
      const apertura = proximoHorarioParaEscribir();
      const ventana = this.ventanaSigueAbiertaEn(candidato, apertura);

      // Si a la hora de abrir ya no se puede escribir gratis, esperar no sirve
      // para nada: se descarta ahora y el nivel sube igual, para que la pasada
      // siguiente no vuelva a encontrar el mismo pedido vencido.
      return ventana
        ? { puede: false, motivo: MOTIVOS.silencio }
        : { puede: false, motivo: MOTIVOS.ventana };
    }

    // 3. Ventana de Meta. Fuera de ella el mensaje cuesta una plantilla.
    const estado = timeUtil.checkMessagingWindow(
      candidato.last_customer_interaction,
      candidato.platform
    );
    if (!estado.canSendFreeText) return { puede: false, motivo: MOTIVOS.ventana };

    return { puede: true, motivo: null };
  },

  /**
   * ¿En tal momento futuro seguirá abierta la ventana gratuita?
   *
   * Se calcula a mano y no con `checkMessagingWindow`, que mira el reloj de
   * ahora: acá la pregunta es si a las ocho de la mañana todavía se va a poder
   * escribir sin pagar, y eso decide si el seguimiento espera o se tira.
   *
   * @param {object} candidato
   * @param {Date} momento
   * @returns {boolean}
   */
  ventanaSigueAbiertaEn(candidato, momento) {
    const ultima = candidato.last_customer_interaction
      ? new Date(candidato.last_customer_interaction).getTime()
      : 0;
    if (!ultima) return false;

    // Messenger e Instagram admiten hasta 7 días con la etiqueta HUMAN_AGENT;
    // WhatsApp corta a las 24 horas y después solo acepta plantillas pagas.
    const horas = candidato.platform === 'whatsapp' ? 24 : 168;
    return momento.getTime() <= ultima + horas * 3600000;
  },

  /**
   * Manda el texto sin sacarle el chat al bot.
   *
   * No se reutiliza `deliveryService.enviar` justamente por eso: esa función
   * marca la conversación como atendida por una persona, que es lo correcto
   * cuando alguien confirma un pago a mano, y es exactamente lo contrario de lo
   * que hace falta acá. Un seguimiento que apaga el bot deja la respuesta
   * —"sí, pasame los datos"— esperando a que alguien la lea, y esa respuesta es
   * la venta.
   *
   * @returns {{ enviado: boolean, detalle: string|null }}
   */
  async enviarTexto(candidato, texto) {
    const canal = await channelRepository.findById(candidato.channel_id);
    if (!canal || !canal.accessToken) {
      return { enviado: false, detalle: 'El canal no tiene token de Meta.' };
    }

    const guardado = await messageRepository.insertMessage({
      conversationId: candidato.conversation_id,
      channelId: candidato.channel_id,
      direction: 'outbound',
      senderType: 'bot',
      contentType: 'text',
      text: texto,
      status: 'pending',
      viewOnce: false
    });

    try {
      const resultado = await graphApiService.sendMessage({
        channel: canal,
        recipientId: candidato.platform_user_id || candidato.contact_phone,
        text: texto,
        contentType: 'text',
        lastCustomerInteraction: candidato.last_customer_interaction
      });

      const metaId = resultado?.metaMessageId || null;
      if (guardado) {
        await messageRepository.updateStatus(guardado.id, 'sent', metaId);
        guardado.status = 'sent';
        guardado.meta_message_id = metaId;
      }

      await conversationRepository.updateOutboundMessage(candidato.conversation_id, texto);

      if (guardado) socketManager.emitMessageSent(candidato.channel_id, guardado);
      socketManager.emitConversationUpdated(candidato.channel_id, {
        id: candidato.conversation_id,
        last_message_text: texto,
        last_message_time: new Date()
      });

      return { enviado: true, detalle: null };
    } catch (err) {
      const detalle = err.message || 'Meta rechazó el envío.';
      if (guardado) {
        await messageRepository.markFailed(guardado.id, {
          code: err.code || 'ERR_RECUPERACION',
          message: detalle
        });
      }
      return { enviado: false, detalle };
    }
  },

  /**
   * Una pasada completa: busca, decide y manda.
   *
   * Nunca lanza. Este ciclo corre solo, cada quince minutos, sin nadie
   * mirando: si una fila mal formada tirara la pasada entera, el sistema
   * dejaría de recuperar abandonos y nadie se enteraría hasta revisar por qué
   * bajaron las ventas.
   *
   * @returns {Promise<{revisados: number, enviados: number, pospuestos: number, descartados: number}>}
   */
  async pasada() {
    const cfg = envConfig.recuperacion;
    const balance = { revisados: 0, enviados: 0, pospuestos: 0, descartados: 0, fallidos: 0 };

    if (!cfg.habilitada) return balance;

    let candidatos = [];
    try {
      candidatos = await orderRepository.paraRecuperar({
        maxNivel: cfg.escalones.length,
        limite: Math.max(cfg.maxPorPasada * 5, 100)
      });
    } catch (err) {
      console.warn('⚠️ [RECUPERACION] No se pudo leer los pedidos:', err.message);
      return balance;
    }

    for (const candidato of candidatos) {
      if (balance.enviados >= cfg.maxPorPasada) break;

      try {
        balance.revisados++;

        const nivel = this.nivelQueCorresponde(candidato);
        if (nivel === 0) continue;

        const { puede, motivo } = this.sePuedeEscribir(candidato);

        if (!puede) {
          // Posponer es no tocar nada: el pedido vuelve a aparecer en la
          // pasada siguiente con el mismo nivel pendiente.
          if (motivo === MOTIVOS.silencio || motivo === MOTIVOS.humano) {
            balance.pospuestos++;
            continue;
          }

          // Descartar sí sube el nivel, o el pedido queda vencido para
          // siempre y se lo revisa cada quince minutos hasta el fin de los
          // tiempos.
          await orderRepository.marcarRecuperacion(candidato.id, nivel, false);
          balance.descartados++;
          continue;
        }

        // Qué precio tiene hoy esta persona, por si entró a una campaña.
        try {
          const pp = await precioParaPersona({
            conversationId: candidato.conversation_id,
            productId: candidato.product_id,
            precioLista: Number(candidato.product_price || candidato.amount) || 0,
            momentos: [Date.now()]
          });
          candidato.precio_vigente = pp.precio;
        } catch {
          // Sin el precio vigente se compara contra el de lista, como antes.
        }

        const texto = await this.armarMensaje(candidato, nivel);

        // Se anota ANTES de mandar, no después. Si Meta acepta el mensaje y
        // después se corta la conexión con la base, anotar al final significa
        // que la pasada siguiente lo manda de nuevo. Es mejor perder un
        // seguimiento que mandarlo dos veces: lo primero no se nota, lo
        // segundo es la definición de bot molesto.
        await orderRepository.marcarRecuperacion(candidato.id, nivel, true);

        const { enviado, detalle } = await this.enviarTexto(candidato, texto);

        if (enviado) {
          balance.enviados++;

          // El descuento existe recién ahora que el mensaje salió, y vence.
          // Antes dependía del escalón, que sube aunque el mensaje no se mande:
          // se le terminaba cobrando 15.000 a gente a la que nunca se le
          // ofreció nada.
          const rebajado = nivel >= 2 ? this.descuentoPara(candidato) : 0;
          if (rebajado > 0) {
            await registrarOfertaRecuperacion({
              conversationId: candidato.conversation_id,
              productId: candidato.product_id,
              precio: rebajado,
              nivel
            });
          }
        } else {
          balance.fallidos++;
          console.warn(`⚠️ [RECUPERACION] Pedido #${candidato.id} nivel ${nivel}: ${detalle}`);
        }
      } catch (err) {
        balance.fallidos++;
        console.warn(`⚠️ [RECUPERACION] Pedido #${candidato?.id}: ${err.message}`);
      }
    }

    if (balance.enviados || balance.descartados || balance.fallidos) {
      console.log(
        `🔁 [RECUPERACION] ${balance.enviados} enviado(s), ${balance.pospuestos} en espera, ` +
        `${balance.descartados} descartado(s), ${balance.fallidos} con error, ` +
        `de ${balance.revisados} revisado(s).`
      );
    }

    return balance;
  },

  /**
   * Enciende el ciclo.
   *
   * El temporizador queda con `unref` para que no sea el motivo de que el
   * proceso no pueda terminar: Render manda SIGTERM en cada despliegue y un
   * intervalo vivo demora el cierre hasta que lo mata por tiempo.
   *
   * La primera pasada espera un minuto. Arrancar y escribirle a gente en el
   * mismo segundo en que sube una versión nueva es la peor forma de descubrir
   * que la versión nueva tenía un error en el texto.
   *
   * @returns {NodeJS.Timeout|null}
   */
  iniciar() {
    const cfg = envConfig.recuperacion;
    if (!cfg.habilitada) {
      console.log('🔁 [RECUPERACION] Desactivada por configuración.');
      return null;
    }

    const cada = Math.max(5, cfg.cadaMinutos) * 60 * 1000;

    const arranque = setTimeout(() => this.pasada(), 60 * 1000);
    if (typeof arranque.unref === 'function') arranque.unref();

    const reloj = setInterval(() => this.pasada(), cada);
    if (typeof reloj.unref === 'function') reloj.unref();

    console.log(
      `🔁 [RECUPERACION] Activa: revisión cada ${cfg.cadaMinutos} min, ` +
      `escalones a los ${cfg.escalones.join(' / ')} min, ` +
      `silencio de ${cfg.silencioDesde}:00 a ${cfg.silencioHasta}:00 (Paraguay).`
    );

    return reloj;
  }
};

export default recoveryService;
