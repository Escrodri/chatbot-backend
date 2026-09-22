import { conversationRepository } from '../repositories/conversation.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { tagRepository } from '../repositories/tag.repository.js';
import { graphApiService } from './graph-api.service.js';
import { socketManager } from '../sockets/index.js';

/**
 * Entrega del producto digital y aviso de comprobante rechazado.
 *
 * Confirmar un pago y entregar el producto eran, hasta ahora, dos cosas
 * separadas: el tablero cambiaba el estado en la base y ahí se terminaba todo.
 * El cliente que acababa de transferir no recibía nada. Lo mismo al rechazar:
 * el pedido quedaba marcado y del otro lado había alguien esperando en silencio
 * un material que nunca iba a llegar.
 *
 * Sobre el tono de los mensajes: el que rechaza es el más delicado de todo el
 * sistema. Del otro lado puede haber alguien que pagó de verdad y cuya
 * transferencia todavía no impactó, o que sacó la foto torcida. Tratarlo como
 * si hubiera intentado estafarte, cuando lo más probable es que no, es la forma
 * más rápida de perder un cliente y ganarte una mala reseña. Por eso el mensaje
 * no acusa a nadie: explica que todavía no figura, da un paso concreto, y deja
 * claro que si el dinero salió se va a resolver.
 */

/** El enlace vive en el producto, no en el pedido: es el mismo para todos. */
function primerNombre(pedido) {
  return (pedido.contact_name || '').trim().split(' ')[0] || '';
}

/**
 * ¿Corresponde saludar?
 *
 * Se mira el día del calendario paraguayo y no una cantidad de horas, porque es
 * así como lo vive el cliente: escribir a la mañana después de haber escrito
 * anoche es "otro día" aunque hayan pasado nueve horas, y escribir a las once
 * de la noche después de haber escrito a la mañana sigue siendo el mismo día
 * aunque hayan pasado catorce.
 *
 * El piso de una hora es para el borde de la medianoche: dos mensajes separados
 * por veinte minutos, uno a las 23:50 y otro a las 00:10, caen en días
 * distintos pero son obviamente la misma conversación.
 */
const ZONA = 'America/Asuncion';
const MINUTOS_MINIMOS_PARA_SALUDAR = 60;

function diaEnParaguay(fecha) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(fecha);
}

function corresponderSaludar(ultimaInteraccion) {
  if (!ultimaInteraccion) return true;

  const antes = new Date(ultimaInteraccion);
  if (isNaN(antes.getTime())) return true;

  const minutos = (Date.now() - antes.getTime()) / 60000;
  if (minutos < MINUTOS_MINIMOS_PARA_SALUDAR) return false;

  return diaEnParaguay(antes) !== diaEnParaguay(new Date());
}

/** "Buen día", "Buenas tardes" o "Buenas noches" según la hora en Paraguay. */
function saludoSegunHora() {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = partes.find(p => p.type === 'hour');
  const hora = h ? parseInt(h.value, 10) : 12;
  if (hora < 12) return 'Buen día';
  if (hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export const deliveryService = {
  /** Mensaje de entrega. Sale del producto para poder editarlo sin tocar código. */
  armarMensajeEntrega(pedido) {
    const nombre = primerNombre(pedido);
    const partes = [
      nombre ? `Listo ${nombre}, ya te confirmamos el pago.` : 'Listo, ya te confirmamos el pago.',
      'Acá tenés tu material:',
      '',
      `*${pedido.product_name || 'Tu compra'}*`,
      pedido.delivery_url
    ];

    if (pedido.delivery_note) partes.push('', pedido.delivery_note);

    partes.push(
      '',
      'Es tuyo para siempre: podés descargarlo y volver a entrar las veces que quieras.',
      'Si tenés algún problema para abrirlo, escribime por acá nomás y lo vemos juntos.',
      '',
      'Gracias por la compra, que lo disfruten.'
    );

    return partes.join('\n');
  },

  /**
   * Mensaje de comprobante no acreditado.
   *
   * El saludo solo aparece si la charla estaba fría. Decirle "hola" a alguien
   * que escribió hace dos minutos suena a máquina, y en este mensaje en
   * particular —que ya de por sí trae una mala noticia— cualquier cosa que
   * suene automática empeora la reacción.
   */
  armarMensajeRechazo(pedido, saludar = true) {
    const nombre = primerNombre(pedido);
    const apertura = saludar
      ? `${saludoSegunHora()}${nombre ? ` ${nombre}` : ''}, te escribo por el comprobante que mandaste.`
      : 'Te escribo por el comprobante que mandaste.';

    return [
      apertura,
      '',
      'Todavía no nos figura acreditada la transferencia, así que no te pude habilitar la descarga. ' +
      'A veces pasa que tarda un poco en impactar, o que la captura no se llega a leer del todo bien.',
      '',
      '¿Me la mandás de nuevo, donde se vea el monto y el número de operación? Con eso lo reviso enseguida.',
      '',
      'Si ya te lo debitaron quedate tranquilo, lo resolvemos igual.'
    ].join('\n');
  },

  /**
   * Manda un texto al cliente por el canal de la conversación.
   *
   * Nunca lanza: el tablero tiene que poder confirmar o rechazar aunque el
   * envío falle. Que el mensaje no salga es un problema; perder la decisión que
   * tomó la persona es peor.
   */
  async enviar(pedido, texto, actorUserId = null, estadoParaBandeja = null) {
    const conv = await conversationRepository.findById(pedido.conversation_id);
    if (!conv) return { enviado: false, motivo: 'sin_conversacion', detalle: null };

    const canal = await channelRepository.findById(conv.channel_id);
    if (!canal) {
      return { enviado: false, motivo: 'sin_canal', detalle: 'El canal de este chat ya no existe.' };
    }
    if (!canal.accessToken) {
      return {
        enviado: false,
        motivo: 'sin_token',
        detalle: `El canal "${canal.name}" no tiene token de Meta configurado.`
      };
    }

    // Se guarda antes de despachar: si Meta rechaza, el mensaje queda en la
    // bandeja marcado como fallido y se puede reintentar desde ahí.
    const guardado = await messageRepository.insertMessage({
      conversationId: conv.id,
      channelId: conv.channel_id,
      direction: 'outbound',
      senderType: 'agent',
      senderUserId: actorUserId,
      contentType: 'text',
      text: texto,
      mediaUrl: null,
      mediaMime: null,
      status: 'pending',
      viewOnce: false
    });
    guardado.sender_user_name = 'Sistema';

    try {
      const resultado = await graphApiService.sendMessage({
        channel: canal,
        recipientId: conv.platform_user_id || conv.contact_phone,
        text: texto,
        contentType: 'text',
        lastCustomerInteraction: conv.last_customer_interaction
      });

      const metaId = resultado?.metaMessageId || null;
      await messageRepository.updateStatus(guardado.id, 'sent', metaId);
      guardado.status = 'sent';
      guardado.meta_message_id = metaId;

      await conversationRepository.updateOutboundMessage(conv.id, texto);

      // Confirmar un pago o rechazar un comprobante lo decide una persona
      // mirando el extracto del banco, así que el chat queda en sus manos.
      //
      // Sin esto el bot seguía figurando como el que contesta, y el "muchas
      // gracias" que llega después de la entrega volvía a caer en el guion de
      // venta, que le ofrecía a alguien que acaba de comprar el material que
      // recién le mandaron. El reloj del handover se sella acá, así que si
      // nadie sigue la conversación, el bot la retoma solo pasadas las horas
      // configuradas.
      await conversationRepository.updateBotStatus(conv.id, 'handed_over', actorUserId);

      socketManager.emitMessageSent(conv.channel_id, guardado);
      socketManager.emitConversationUpdated(conv.channel_id, {
        id: conv.id,
        last_message_text: texto,
        last_message_time: new Date(),
        bot_status: 'handed_over',
        order_status: estadoParaBandeja
      });

      return { enviado: true, motivo: null, detalle: null };
    } catch (err) {
      const detalle = err.message || 'Meta rechazó el envío.';
      const fallido = await messageRepository.markFailed(guardado.id, {
        code: err.code || 'ERR_ENVIO_FALLIDO',
        message: detalle
      });
      if (fallido) Object.assign(guardado, fallido);
      guardado.status = 'failed';

      socketManager.emitMessageSent(conv.channel_id, guardado);
      console.error(`❌ [PEDIDO #${pedido.id}] No se pudo mandar el mensaje. ${detalle}`);
      return { enviado: false, motivo: 'meta_rechazo', detalle };
    }
  },

  /** Manda el enlace de descarga. */
  async entregar(pedido, actorUserId = null) {
    if (!pedido) return { enviado: false, motivo: 'sin_pedido', detalle: null };

    if (!pedido.delivery_url) {
      return {
        enviado: false,
        motivo: 'sin_enlace',
        detalle: `El producto "${pedido.product_name || 'sin nombre'}" no tiene enlace de entrega cargado.`
      };
    }

    return this.enviar(pedido, this.armarMensajeEntrega(pedido), actorUserId, 'entregado');
  },

  /** Avisa que el comprobante todavía no figura acreditado. */
  async avisarRechazo(pedido, actorUserId = null) {
    if (!pedido) return { enviado: false, motivo: 'sin_pedido', detalle: null };

    const conv = await conversationRepository.findById(pedido.conversation_id);
    const saludar = corresponderSaludar(conv?.last_customer_interaction);

    return this.enviar(pedido, this.armarMensajeRechazo(pedido, saludar), actorUserId, 'rechazado');
  },

  /**
   * Marca la conversación como de alguien que ya compró.
   *
   * Es una etiqueta, no un estado: un cliente que ya compró puede querer otro
   * producto mañana, y el estado del pedido viejo no tiene que estorbarle. La
   * etiqueta dice "esta persona ya confió en nosotros una vez", que es una
   * información distinta y que no caduca.
   */
  async marcarClienteQueCompro(conversationId) {
    try {
      const conv = await conversationRepository.findById(conversationId);
      if (!conv) return false;

      const etiqueta = await tagRepository.asegurar({
        teamId: conv.team_id || null,
        name: 'Ya compró',
        color: '#047857'
      });

      if (etiqueta) await tagRepository.assign(conversationId, etiqueta.id, null);
      return true;
    } catch (err) {
      // Que falle la etiqueta no puede romper una entrega que salió bien.
      console.warn('⚠️ [ETIQUETA] No se pudo marcar como cliente:', err.message);
      return false;
    }
  }
};

export default deliveryService;
