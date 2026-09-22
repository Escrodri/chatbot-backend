import { orderRepository } from '../repositories/order.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { deliveryService } from '../services/delivery.service.js';
import { socketManager } from '../sockets/index.js';

export const orderController = {
  /**
   * Tablero de pedidos: quién pagó, quién dejó el comprobante colgado y quién
   * preguntó y nunca volvió.
   * GET /api/orders?status=pagado&phone=...
   */
  async list(req, res) {
    try {
      const { status = null, phone = null, limit = 100, offset = 0 } = req.query;
      const pedidos = await orderRepository.list({
        status,
        phone,
        limit: parseInt(limit, 10) || 100,
        offset: parseInt(offset, 10) || 0
      });
      return res.json(pedidos);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar pedidos: ' + error.message });
    }
  },

  /** GET /api/orders/summary — conteo y monto por estado. */
  async summary(req, res) {
    try {
      return res.json(await orderRepository.resumen());
    } catch (error) {
      return res.status(500).json({ error: 'Error al resumir pedidos: ' + error.message });
    }
  },

  /**
   * Abre (o recupera) el pedido de una conversación.
   *
   * Lo llama n8n cuando alguien muestra interés concreto en un producto. Si ya
   * existía, devuelve el existente con `duplicado: true`, y ese es el dato que
   * el flujo usa para no volver a cobrarle a quien ya pagó.
   *
   * POST /api/orders
   */
  async createOrGet(req, res) {
    try {
      const { conversation_id, product_id = null, product_slug = null, status = 'interesado' } = req.body || {};

      const conversationId = parseInt(conversation_id, 10);
      if (isNaN(conversationId)) {
        return res.status(400).json({ error: 'conversation_id es obligatorio' });
      }

      const conv = await conversationRepository.findById(conversationId);
      if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

      // El producto puede venir por id o por slug: n8n trabaja más cómodo con slug.
      let producto = null;
      if (product_id) {
        producto = await productRepository.findById(parseInt(product_id, 10));
      } else if (product_slug) {
        producto = await productRepository.findBySlug(String(product_slug).trim());
      }

      const existente = await orderRepository.findByConversationAndProduct(
        conversationId,
        producto?.id || null
      );

      const pedido = await orderRepository.crearOObtener({
        conversationId,
        productId: producto?.id || null,
        contactPhone: conv.platform_user_id || conv.contact_phone || null,
        contactName: conv.contact_name || null,
        amount: producto ? Number(producto.price) : null,
        currency: producto?.currency || 'PYG',
        status
      });

      return res.status(existente ? 200 : 201).json({
        order: pedido,
        product: producto
          ? { id: producto.id, slug: producto.slug, name: producto.name, price: Number(producto.price) }
          : null,
        duplicado: Boolean(existente),
        // Lo que el flujo necesita saber de una: ¿esta persona ya pagó?
        ya_pago: Boolean(existente && ['pagado', 'entregado'].includes(existente.status))
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al registrar el pedido: ' + error.message });
    }
  },

  /** GET /api/orders/conversation/:conversationId */
  async byConversation(req, res) {
    try {
      const id = parseInt(req.params.conversationId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const pedidos = await orderRepository.listByConversation(id);

      // El link de entrega solo viaja si el pedido está pagado. Que el dato
      // esté en la tabla no significa que pueda salir por cualquier respuesta.
      const seguros = pedidos.map(p => {
        const habilitado = ['pagado', 'entregado'].includes(p.status);
        return {
          ...p,
          product_entregable: Boolean(p.delivery_url && p.delivery_url.trim()),
          delivery_url: habilitado ? p.delivery_url : null,
          delivery_note: habilitado ? p.delivery_note : null
        };
      });

      return res.json(seguros);
    } catch (error) {
      return res.status(500).json({ error: 'Error al buscar pedidos: ' + error.message });
    }
  },

  /**
   * Cambia el estado del pedido.
   *
   * Marcar 'pagado' es la única transición que NO puede hacer el bot: la hace
   * una persona después de mirar el banco. Un comprobante es una foto, y una
   * foto se edita o se reenvía; lo único que no se falsifica es el extracto.
   *
   * PATCH /api/orders/:id/status
   */
  async updateStatus(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const {
        status,
        note = null,
        receipt_check = null,
        receipt_message_id = null,
        notify = true
      } = req.body || {};

      const validos = ['interesado', 'comprobante_recibido', 'pagado', 'entregado', 'rechazado'];
      if (!validos.includes(status)) {
        return res.status(400).json({ error: `Estado inválido. Debe ser uno de: ${validos.join(', ')}` });
      }

      const esServicio = req.user?.role === 'service';
      if (esServicio && status === 'pagado') {
        return res.status(403).json({
          error: 'Un pago solo lo confirma una persona después de verificar la transferencia en el banco.',
          code: 'ERR_PAGO_REQUIERE_HUMANO'
        });
      }

      // Buscar el pedido y su información de entrega ANTES de realizar cambios
      const conEntrega = await orderRepository.findConEntrega(id);
      if (!conEntrega) return res.status(404).json({ error: 'Pedido no encontrado' });

      // Si se confirma pago con entrega automática (notify !== false)
      // pero el producto NO tiene delivery_url, BLOQUEAR sin modificar el estado en BD
      const quiereEntrega = status === 'pagado' && notify !== false;
      if (quiereEntrega && (!conEntrega.delivery_url || !conEntrega.delivery_url.trim())) {
        return res.status(400).json({
          error: `El producto "${conEntrega.product_name || 'seleccionado'}" no tiene enlace de entrega cargado. Cárgalo en Productos antes de confirmar la entrega.`,
          code: 'ERR_SIN_ENLACE_ENTREGA'
        });
      }

      const actualizado = await orderRepository.cambiarEstado(id, status, {
        confirmedBy: esServicio ? null : req.user?.id || null,
        note,
        receiptCheck: receipt_check,
        receiptMessageId: receipt_message_id ? parseInt(receipt_message_id, 10) : null
      });

      if (!actualizado) return res.status(404).json({ error: 'Pedido no encontrado' });

      let entrega = null;
      let estadoFinal = actualizado;

      if (status === 'pagado' && notify !== false) {
        entrega = await deliveryService.entregar(conEntrega, req.user?.id || null);

        // Solo se marca entregado si el mensaje salió de verdad. Si falló, el
        // pedido queda en 'pagado' y sigue visible en el tablero como pendiente
        // de entrega, que es exactamente lo que hay que hacer con él.
        if (entrega.enviado) {
          const entregado = await orderRepository.cambiarEstado(actualizado.id, 'entregado', {
            confirmedBy: req.user?.id || null
          });
          if (entregado) estadoFinal = entregado;
        }

        // La etiqueta sobrevive al pedido: mañana esta persona puede querer otro
        // producto, y entonces el pedido viejo ya no dice nada útil sobre ella.
        await deliveryService.marcarClienteQueCompro(actualizado.conversation_id);
      }

      // Rechazar con aviso por WhatsApp solo si notify !== false
      if (status === 'rechazado' && notify !== false) {
        entrega = await deliveryService.avisarRechazo(conEntrega, req.user?.id || null);
      }

      const conv = await conversationRepository.findById(estadoFinal.conversation_id);
      if (conv) {
        socketManager.emitConversationUpdated(conv.channel_id, {
          id: conv.id,
          order_status: estadoFinal.status
        });
      }

      return res.json({ ...estadoFinal, entrega });
    } catch (error) {
      return res.status(500).json({ error: 'Error al actualizar el pedido: ' + error.message });
    }
  }
};

export default orderController;
