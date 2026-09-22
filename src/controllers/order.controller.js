import { orderRepository, ETAPAS, posicionEtapa } from '../repositories/order.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { deliveryService } from '../services/delivery.service.js';
import { socketManager } from '../sockets/index.js';
import { envConfig, esHorarioNocturno, horaEnParaguay } from '../config/env.config.js';

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
  },

  /**
   * Anota hasta dónde llegó esta persona en el recorrido de compra.
   *
   * Lo llama el guion en cada paso: cuando le presentó el producto, cuando
   * pidió ver muestras, cuando dijo que quería comprar, cuando recibió los
   * datos de la transferencia. Cada llamada es barata y el registro que deja
   * es lo que después permite comparar anuncios por ventas y no por
   * conversaciones abiertas.
   *
   * Nunca retrocede: pedirle que marque una etapa anterior a la que ya tiene
   * no es un error, simplemente no hace nada.
   *
   * POST /api/orders/:id/etapa
   */
  async marcarEtapa(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const { etapa } = req.body || {};
      if (posicionEtapa(etapa) < 0) {
        return res.status(400).json({ error: `Etapa inválida. Debe ser una de: ${ETAPAS.join(', ')}` });
      }

      const movido = await orderRepository.marcarEtapa(id, etapa);

      // Sin cambio significa que ya venía igual o más adelante. Es el caso
      // normal cuando alguien repite un paso, así que se contesta con éxito.
      return res.json({
        ok: true,
        avanzo: Boolean(movido),
        etapa: movido ? movido.etapa : null
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al marcar la etapa: ' + error.message });
    }
  },

  /**
   * El embudo: cuánta gente llegó a cada paso, en total y por anuncio.
   *
   * GET /api/orders/embudo?dias=30
   */
  async embudo(req, res) {
    try {
      const dias = Math.min(parseInt(req.query.dias, 10) || 30, 365);
      const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

      const datos = await orderRepository.embudo({ desde });

      return res.json({ dias, desde, ...datos });
    } catch (error) {
      return res.status(500).json({ error: 'Error al armar el embudo: ' + error.message });
    }
  },

  /**
   * Decide si un comprobante se puede aprobar y entregar sin que lo mire nadie.
   *
   * Existe por una sola razón: de madrugada no hay nadie revisando, y alguien
   * que transfirió a las dos de la mañana no espera tranquilo hasta las nueve.
   * A esa altura ya escribió tres veces preguntando si lo estafaron, y esa
   * conversación no se recupera aunque después llegue el material.
   *
   * La decisión vive acá y no en el guion a propósito. n8n puede mandar
   * cualquier cosa en el cuerpo de la petición, así que todo lo que importa se
   * vuelve a verificar contra la base: el precio sale del producto, el número
   * de cuenta de la configuración, y el número de operación se contrasta
   * contra los pedidos ya cobrados. Un flujo mal armado no debería poder
   * regalar el material.
   *
   * Solo entrega sola cuando no queda ninguna duda. Cualquier ambigüedad —una
   * foto borrosa, un monto que no se leyó, una cuenta a medias— cae en la
   * revisión humana de siempre. Rechazarle el pago a alguien que pagó de
   * verdad es mucho peor que hacerlo esperar.
   *
   * POST /api/orders/:id/revision-automatica
   */
  async revisionAutomatica(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

      const { monto = null, cuenta = null, operacion = null, receipt_message_id = null } = req.body || {};

      const pedido = await orderRepository.findConEntrega(id);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

      // Guarda siempre el número de operación, aunque después no se entregue
      // solo. Si no se guarda acá, el comprobante que revisa una persona a la
      // mañana queda sin número registrado y esa misma captura sirve de nuevo
      // la noche siguiente.
      const operacionLimpia = String(operacion || '').replace(/[^0-9]/g, '');
      if (operacionLimpia) {
        await orderRepository.cambiarEstado(id, pedido.status, { receiptOperacion: operacionLimpia });
      }

      const rechazar = (motivo, detalle) => res.json({
        entregado: false,
        motivo,
        detalle,
        hora_paraguay: horaEnParaguay()
      });

      if (!envConfig.entregaAutomatica.habilitada) {
        return rechazar('desactivada', 'La entrega automática está apagada.');
      }

      if (!esHorarioNocturno()) {
        return rechazar('horario_humano', 'Es horario de atención: lo revisa una persona.');
      }

      if (['pagado', 'entregado'].includes(pedido.status)) {
        return rechazar('ya_estaba_pago', 'Este pedido ya figura cobrado.');
      }

      if (!pedido.delivery_url || !pedido.delivery_url.trim()) {
        return rechazar('sin_enlace', 'El producto no tiene enlace de entrega cargado.');
      }

      // El precio sale del producto, no de lo que mandó el guion.
      const precio = Number(pedido.price ?? pedido.amount ?? 0);
      const montoLeido = Number(String(monto || '').replace(/[^0-9]/g, '')) || 0;

      if (!precio || !montoLeido) {
        return rechazar('monto_ilegible', 'No se pudo leer el monto con seguridad.');
      }

      if (montoLeido < precio) {
        return rechazar('monto_insuficiente', `Transfirió ${montoLeido} y el material sale ${precio}.`);
      }

      if (precio > envConfig.entregaAutomatica.montoMaximo) {
        return rechazar('monto_alto', 'Por encima del tope para aprobar sin revisión.');
      }

      // La cuenta que recibe tiene que ser la nuestra. Se comparan solo los
      // dígitos y por terminación, porque cada banco recorta el número de una
      // forma distinta en la captura.
      const cuentaPropia = String(process.env.PAGO_CUENTA || '').replace(/[^0-9]/g, '');
      const cuentaLeida = String(cuenta || '').replace(/[^0-9]/g, '');

      if (!cuentaPropia || !cuentaLeida) {
        return rechazar('cuenta_ilegible', 'No se pudo leer la cuenta de destino.');
      }

      if (!cuentaPropia.endsWith(cuentaLeida) && !cuentaLeida.endsWith(cuentaPropia)) {
        return rechazar('cuenta_ajena', 'La transferencia figura a otra cuenta.');
      }

      if (!operacionLimpia) {
        return rechazar('sin_operacion', 'El comprobante no muestra número de operación.');
      }

      const repetida = await orderRepository.operacionYaUsada(operacionLimpia, id);
      if (repetida) {
        console.warn(
          `🚨 [ENTREGA AUTO] Pedido #${id}: la operación ${operacionLimpia} ya cobró el pedido #${repetida.id}. ` +
          'Se manda a revisión humana.'
        );
        return rechazar('operacion_repetida', `Ese comprobante ya se usó en el pedido #${repetida.id}.`);
      }

      // Pasó todo. Se cobra y se entrega, marcado como aprobado por el sistema
      // para que a la mañana se pueda repasar contra el extracto.
      const pagado = await orderRepository.cambiarEstado(id, 'pagado', {
        confirmedBy: null,
        autoAprobado: true,
        receiptOperacion: operacionLimpia,
        // Solo si es un id numérico de la base. El guion a veces manda acá el
        // identificador de Meta ("wamid.…"), que no es un número y rompería el
        // UPDATE justo en el momento de cobrar.
        receiptMessageId: Number.isInteger(Number(receipt_message_id)) ? Number(receipt_message_id) : null,
        note: `Aprobado automáticamente a las ${horaEnParaguay()}h: monto ${montoLeido}, operación ${operacionLimpia}.`
      });

      const entrega = await deliveryService.entregar(pedido, null);

      let estadoFinal = pagado;
      if (entrega.enviado) {
        const entregado = await orderRepository.cambiarEstado(id, 'entregado', { autoAprobado: true });
        if (entregado) estadoFinal = entregado;
        await deliveryService.marcarClienteQueCompro(pedido.conversation_id);
      }

      const conv = await conversationRepository.findById(pedido.conversation_id);
      if (conv) {
        socketManager.emitConversationUpdated(conv.channel_id, {
          id: conv.id,
          order_status: estadoFinal.status
        });
      }

      console.log(
        `🌙 [ENTREGA AUTO] Pedido #${id} cobrado y entregado sin revisión humana ` +
        `(${horaEnParaguay()}h, operación ${operacionLimpia}).`
      );

      return res.json({
        entregado: Boolean(entrega.enviado),
        motivo: entrega.enviado ? null : entrega.motivo,
        detalle: entrega.detalle || null,
        estado: estadoFinal.status,
        hora_paraguay: horaEnParaguay()
      });
    } catch (error) {
      // Ante cualquier problema, el comprobante queda para una persona. Nunca
      // al revés.
      return res.status(500).json({ entregado: false, motivo: 'error', error: error.message });
    }
  }
};

export default orderController;
