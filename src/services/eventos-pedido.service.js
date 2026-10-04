import { query } from '../database/index.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { conversionRepository } from '../repositories/conversion.repository.js';
import { pedidoItemRepository } from '../repositories/pedido-item.repository.js';
import { conversionsService } from './conversions.service.js';

/**
 * Le avisa a Meta lo que pasa con un pedido, sin que nadie toque un botón.
 *
 *   InitiateCheckout  cuando le llegan los datos para transferir
 *   Purchase          cuando el pago queda confirmado (solo o a mano)
 *
 * Con esto Meta sabe qué anuncio terminó en una compra de verdad y con qué
 * monto (25 mil, o 35 mil con el extra), y puede optimizar la pauta por
 * compras en vez de por mensajes.
 *
 * Reglas:
 *   - Solo se informa si la charla empezó desde un anuncio de clic a WhatsApp
 *     (sin el `ctwa_clid` Meta no tiene a qué atribuirlo). Si no, no se anota nada.
 *   - Cada pedido informa cada evento una sola vez: el id del evento sale del
 *     pedido ("pedido_12_purchase"), y la tabla no acepta dos iguales. Un
 *     pago confirmado dos veces, o los datos reenviados, no cuentan doble.
 *   - Nunca rompe lo que lo llamó: un fallo con Meta queda anotado en
 *     `conversion_events` y el cobro o la entrega siguen igual.
 */

const EVENTOS = Object.freeze({
  checkout: 'InitiateCheckout',
  compra: 'Purchase'
});

async function leerPedido(orderId) {
  const { rows } = await query(
    `SELECT o.id, o.conversation_id, o.product_id, o.amount, o.precio_cobrado, o.currency, o.status,
            p.name AS product_name
       FROM orders o LEFT JOIN products p ON p.id = o.product_id
      WHERE o.id = $1`,
    [orderId]
  );
  return rows[0] || null;
}

export const eventosPedidoService = {
  EVENTOS,

  /**
   * Informa un evento de un pedido.
   *
   * @param {number} orderId
   * @param {'checkout'|'compra'} tipo
   * @param {{ valor?: number|null, registradoPor?: number|null }} [opciones]
   *        valor: el total a informar; si no viene, se calcula del pedido.
   * @returns {Promise<{ ok: boolean, omitido?: string, estado?: string, error?: string }>}
   */
  async informar(orderId, tipo, { valor = null, registradoPor = null } = {}) {
    try {
      const eventName = EVENTOS[tipo];
      if (!eventName) return { ok: false, omitido: 'tipo_desconocido' };

      const pedido = await leerPedido(orderId);
      if (!pedido) return { ok: false, omitido: 'sin_pedido' };

      const conv = await conversationRepository.findById(pedido.conversation_id);
      if (!conv) return { ok: false, omitido: 'sin_conversacion' };
      if (conv.platform === 'whatsapp' && !conv.ctwa_clid) return { ok: false, omitido: 'no_vino_de_anuncio' };

      let monto = valor;
      if (monto === null || monto === undefined) {
        const base = Number(pedido.precio_cobrado) || Number(pedido.amount) || 0;
        const extras = await pedidoItemRepository.totalExtras(pedido.id).catch(() => 0);
        monto = base + (Number(extras) || 0);
      }
      const moneda = pedido.currency || 'PYG';
      const eventId = `pedido_${pedido.id}_${tipo === 'compra' ? 'purchase' : 'checkout'}`;

      let registro;
      try {
        registro = await conversionRepository.create({
          conversationId: conv.id,
          channelId: conv.channel_id,
          registeredBy: registradoPor,
          eventName,
          eventId,
          value: monto || null,
          currency: monto ? moneda : null,
          note: tipo === 'compra' ? `Pedido #${pedido.id}` : `Pedido #${pedido.id}: recibió los datos`,
          product: pedido.product_name ? String(pedido.product_name).slice(0, 200) : null
        });
      } catch (err) {
        // Ya se informó este evento de este pedido.
        if (err?.code === '23505') return { ok: true, omitido: 'ya_informado' };
        throw err;
      }

      const canal = await channelRepository.findById(conv.channel_id);
      const resultado = await conversionsService.informarVenta({
        conversation: conv,
        canal,
        eventName,
        value: monto || null,
        currency: monto ? moneda : null,
        product: pedido.product_name || null,
        eventId
      });

      const estado = resultado.ok ? 'sent' : (resultado.skipped ? 'skipped' : 'failed');
      await conversionRepository.updateStatus(
        registro.id,
        estado,
        resultado.ok ? null : { code: resultado.code, message: resultado.error }
      );
      return { ok: resultado.ok, estado, error: resultado.ok ? undefined : resultado.error };
    } catch (err) {
      console.warn(`⚠️ [CONVERSIONES] No se pudo informar ${tipo} del pedido #${orderId}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  },

  /** Igual que informar, pero sin esperar: para no demorar al cliente. */
  avisar(orderId, tipo, opciones) {
    this.informar(orderId, tipo, opciones).catch(() => {});
  }
};

export default eventosPedidoService;
