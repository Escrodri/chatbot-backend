import { orderRepository, ETAPAS, posicionEtapa, soportaEquipos } from '../repositories/order.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { deliveryService } from '../services/delivery.service.js';
import { socketManager } from '../sockets/index.js';
import { envConfig, horaEnParaguay } from '../config/env.config.js';
import { userRepository } from '../repositories/user.repository.js';
import { autoReviewService } from '../services/auto-review.service.js';
import { datosPagoService } from '../services/datos-pago.service.js';
import { idDeMensaje, formatoGs } from '../utils/comprobante.util.js';
import { revisionComprobanteService } from '../services/revision-comprobante.service.js';

// Las funciones que leen un comprobante —el monto, la huella, la antigüedad,
// el nombre— viven en utils/comprobante.util.js, y la decisión entera en
// services/revision-comprobante.service.js. Acá solo queda lo que usan las
// rutas del tablero.

/**
 * ¿Este pedido es de quien lo está pidiendo?
 *
 * Las tres rutas que modifican un pedido —cambiar estado, aprobar de
 * madrugada, marcar etapa— no comprobaban nada. Con una sesión de asesor y un
 * id cualquiera se podía confirmar el pago de otro negocio y dispararle la
 * entrega a su cliente.
 *
 * El token de servicio queda afuera del chequeo a propósito: es el bot, no
 * tiene equipo, y solo toca los pedidos que el propio flujo abrió.
 *
 * @param {object} req
 * @param {object|null} pedido Tiene que venir de `findConEntrega`, que resuelve canal y equipo
 * @returns {Promise<boolean>}
 */
async function puedeTocar(req, pedido) {
  if (!pedido) return false;

  const rol = req.user?.role;
  if (rol === 'service' || rol === 'superadmin') return true;

  // El equipo del pedido tiene que ser el de quien lo pide.
  //
  // Antes la comparación exigía que los dos lados tuvieran valor, y ahí se
  // caía: `findConEntrega` devuelve `NULL::int AS team_id` en las bases donde
  // la columna `channels.team_id` no existe, y también cuando el JOIN no
  // resuelve. Con el equipo del pedido en nulo la condición daba falso y el
  // chequeo se saltaba entero, así que un asesor sin canales asignados podía
  // confirmar el pago de cualquier id y dispararle la entrega al cliente de
  // otro negocio.
  //
  // Ahora se exige coincidencia. Pero solo donde los equipos existen de
  // verdad: en una base sin `channels.team_id` TODOS los pedidos vienen con
  // equipo nulo, y exigir coincidencia ahí dejaría al dueño sin poder abrir
  // ni uno solo de sus propios pedidos. El aislamiento tiene que proteger,
  // no tapiar la puerta.
  if (req.user?.team_id && await soportaEquipos() && pedido.team_id !== req.user.team_id) {
    return false;
  }

  if (rol === 'agent' && pedido.channel_id) {
    const asignados = await userRepository.getAssignedChannelIds(req.user.id);
    // Sin canales asignados el asesor ve todo lo de su equipo, que es la misma
    // convención que usa la bandeja. El filtro de equipo de arriba ya lo acota.
    if (asignados.length > 0 && !asignados.includes(pedido.channel_id)) return false;
  }

  return true;
}

export const orderController = {
  /**
   * Tablero de pedidos: quién pagó, quién dejó el comprobante colgado y quién
   * preguntó y nunca volvió.
   * GET /api/orders?status=pagado&phone=...
   */
  async list(req, res) {
    try {
      const { status = null, phone = null, limit = 100, offset = 0 } = req.query;

      const teamId = req.user?.role === 'superadmin' ? null : (req.user?.team_id || null);

      let assignedChannelIds = null;
      if (req.user?.role === 'agent') {
        const ids = await userRepository.getAssignedChannelIds(req.user.id);
        if (ids && ids.length > 0) assignedChannelIds = ids;
      }

      const pedidos = await orderRepository.list({
        status,
        phone,
        teamId,
        assignedChannelIds,
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

      // Lo que pasó con la plata de esta persona, en palabras, para la IA.
      //
      // Sin esto, cuando alguien escribía "te pasé de más" o "ya te pagué",
      // la IA no tenía idea de que esa persona había mandado un comprobante a
      // un supermercado, ni de cuánto faltaba, ni de qué se le había dicho.
      // Improvisaba, y lo que improvisa una IA sin datos sobre plata es
      // exactamente lo que no queremos que diga.
      const pago = await revisionComprobanteService.resumenDePago(
        pedido,
        Number(producto?.price ?? pedido?.amount ?? 0) || 0,
        { conversationId, productId: producto?.id ?? pedido?.product_id ?? null }
      );

      // El precio que le corresponde a ESTA persona ahora, para que el guion lo
      // muestre en la tarjeta del producto y en los datos de pago. Sin esto,
      // alguien que vuelve desde el anuncio de 15 mil vería 19 mil en la
      // tarjeta: la promo del anuncio y el precio del chat no coincidirían, y
      // ahí se cae la venta y encima parece un engaño.
      const pp = pago.precio_persona || {};
      const esGuaranies = !producto?.currency || producto.currency === 'PYG';
      const precio = {
        monto: pp.precio ?? null,
        formateado: esGuaranies && pp.precio ? formatoGs(pp.precio) : null,
        lista: pp.lista ?? null,
        lista_formateado: esGuaranies && pp.lista ? formatoGs(pp.lista) : null,
        es_promo: Boolean(pp.es_promo),
        etiqueta: pp.etiqueta || null,
        hasta: pp.hasta || null,
        hasta_texto: pp.hasta_texto || ''
      };
      delete pago.precio_persona;

      return res.status(existente ? 200 : 201).json({
        order: pedido,
        product: producto
          ? { id: producto.id, slug: producto.slug, name: producto.name, price: Number(producto.price) }
          : null,
        duplicado: Boolean(existente),
        // Lo que el flujo necesita saber de una: ¿esta persona ya pagó?
        ya_pago: Boolean(existente && ['pagado', 'entregado'].includes(existente.status)),
        pago,
        precio
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
        receipt_operacion = null,
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

      // Se contesta 404 y no 403 a propósito: decir "existe pero no es tuyo"
      // ya confirma que existe, y con eso se puede barrer los ids ajenos.
      if (!(await puedeTocar(req, conEntrega))) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      // Si se confirma pago con entrega automática (notify !== false)
      // pero el producto NO tiene delivery_url, BLOQUEAR sin modificar el estado en BD
      const quiereEntrega = status === 'pagado' && notify !== false;
      if (quiereEntrega && (!conEntrega.delivery_url || !conEntrega.delivery_url.trim())) {
        return res.status(400).json({
          error: `El producto "${conEntrega.product_name || 'seleccionado'}" no tiene enlace de entrega cargado. Cárgalo en Productos antes de confirmar la entrega.`,
          code: 'ERR_SIN_ENLACE_ENTREGA'
        });
      }

      // Entregar dos veces el mismo pedido no es corregir un estado, es mandar
      // el material de nuevo y volver a sellar la fecha de cobro. El tablero ya
      // esconde el botón cuando el pedido está entregado, pero esconder un
      // botón no es una regla: dos clics rápidos, una pestaña vieja o el guion
      // reintentando llegan igual hasta acá.
      //
      // Reintentar sí se permite: si la entrega falló, el pedido quedó en
      // 'pagado' y este camino es justamente cómo se vuelve a intentar.
      if (quiereEntrega && conEntrega.status === 'entregado') {
        return res.status(409).json({
          error: 'Este pedido ya fue entregado. Si el cliente dice que no le llegó, reenviale el enlace desde el chat.',
          code: 'ERR_YA_ENTREGADO'
        });
      }

      // El número de operación del comprobante, que es lo único que impide que
      // la misma captura cobre dos veces.
      //
      // Antes solo se guardaba en la aprobación automática de madrugada, así
      // que todo comprobante confirmado a mano durante el día quedaba sin
      // número registrado. Esa captura servía de nuevo esa misma noche, cuando
      // ya no hay nadie mirando: una venta real se convertía en una llave para
      // sacar copias gratis.
      //
      // Se acepta explícito, y si no viene se lo saca del texto de revisión que
      // ya manda el guion, para no depender de que el flujo se actualice.
      const operacion = receipt_operacion
        || (String(receipt_check || '').match(/operacion\s*=\s*(\d+)/i) || [])[1]
        || null;

      let actualizado;
      try {
        actualizado = await orderRepository.cambiarEstado(id, status, {
          confirmedBy: esServicio ? null : req.user?.id || null,
          note,
          receiptCheck: receipt_check,
          receiptMessageId: idDeMensaje(receipt_message_id),
          receiptOperacion: operacion,
          // Solo si el pedido sigue en el estado que leímos hace un momento.
          // Es lo que hace que dos clics rápidos entreguen una vez y no dos:
          // ver `siEstadoEs` en el repositorio.
          siEstadoEs: quiereEntrega ? conEntrega.status : null
        });
      } catch (err) {
        if (err.code === 'ERR_OPERACION_REPETIDA') {
          return res.status(409).json({
            error: 'Ese comprobante ya se usó para cobrar otro pedido. Revisá el número de operación antes de confirmar.',
            code: 'ERR_OPERACION_REPETIDA'
          });
        }
        throw err;
      }

      // Sin fila actualizada y con la guarda puesta, el pedido cambió de estado
      // entre que lo leímos y lo escribimos: otra petición ganó la carrera y ya
      // hizo la entrega. Contestar 404 acá sería mentir.
      if (!actualizado && quiereEntrega) {
        return res.status(409).json({
          error: 'Otro pedido de confirmación llegó primero y ya se está procesando. Actualizá la pantalla.',
          code: 'ERR_CONFIRMACION_EN_CURSO'
        });
      }

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

      const pedido = await orderRepository.findConEntrega(id);
      if (!pedido || !(await puedeTocar(req, pedido))) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
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
   * Cómo está configurada la aprobación automática en este momento.
   *
   * GET /api/orders/revision-config
   */
  async configRevision(req, res) {
    try {
      const estado = await autoReviewService.estado();

      return res.json({
        ...estado,
        modos: autoReviewService.MODOS,
        // Para que la pantalla pueda explicar de qué franja habla sin tener
        // que repetir el horario escrito a mano en otro lado.
        franja_nocturna: {
          desde: envConfig.entregaAutomatica.desdeHora,
          hasta: envConfig.entregaAutomatica.hastaHora
        },
        monto_maximo: envConfig.entregaAutomatica.montoMaximo,
        habilitada_en_servidor: envConfig.entregaAutomatica.habilitada,
        max_por_dia: envConfig.entregaAutomatica.maxPorDia,
        // Si falta la cuenta, la aprobación automática no puede entregar nada
        // por más encendida que esté. Vale más decirlo acá, antes de que un
        // cliente pague, que descubrirlo con la plata ya transferida.
        datos_pago: await datosPagoService.leer().catch(() => ({ configurado: false })),
        // Cuántas lleva hechas hoy. Es lo primero que uno quiere ver al volver
        // de la calle, y lo que dice si el tope está por frenar la entrega.
        entregadas_hoy: await orderRepository.autoAprobadosDelDia().catch(() => 0)
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al leer la configuración: ' + error.message });
    }
  },

  /**
   * Cambia el modo de aprobación automática.
   *
   * Solo administradores. No es un ajuste cosmético: decide si el sistema
   * puede entregar material cobrando sin que lo mire una persona, y quien
   * atiende chats no tiene por qué poder cambiar esa regla para todos.
   *
   * PATCH /api/orders/revision-config
   */
  async cambiarConfigRevision(req, res) {
    try {
      if (!['admin', 'superadmin'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'Solo un administrador puede cambiar esto.' });
      }

      const { modo, horas = null, hasta = null, nota = null } = req.body || {};

      const estado = await autoReviewService.cambiar({ modo, horas, hasta, nota }, req.user.id);

      console.log(
        `⚙️ [REVISION AUTO] ${req.user.name || req.user.email || 'alguien'} puso el modo en "${estado.modo}"` +
        `${estado.hasta ? ` hasta ${estado.hasta}` : ''}.`
      );

      return res.json({ ...estado, modos: autoReviewService.MODOS });
    } catch (error) {
      if (['ERR_MODO_INVALIDO', 'ERR_VENCIMIENTO_INVALIDO'].includes(error.code)) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Error al guardar la configuración: ' + error.message });
    }
  },

  /**
   * Guarda la cuenta que recibe las transferencias.
   *
   * Solo administradores: es el dato contra el que se valida cada comprobante
   * antes de entregar sin revisión, así que cambiarlo es cambiar quién puede
   * cobrar.
   *
   * PATCH /api/orders/datos-pago
   */
  async guardarDatosPago(req, res) {
    try {
      if (!['admin', 'superadmin'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'Solo un administrador puede cambiar esto.' });
      }

      const datos = await datosPagoService.guardar(req.body || {}, req.user.id);

      console.log(
        `⚙️ [DATOS DE PAGO] ${req.user.name || req.user.email || 'alguien'} actualizó la cuenta de cobro.`
      );

      return res.json(datos);
    } catch (error) {
      if (error.code === 'ERR_DATOS_PAGO_INCOMPLETOS') {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Error al guardar los datos de pago: ' + error.message });
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

      const pedido = await orderRepository.findConEntrega(id);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

      if (!(await puedeTocar(req, pedido))) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      // Toda la decisión —qué cuenta, qué se repite, qué se le contesta— está
      // en el servicio. Ver la explicación del orden de los pasos allá.
      const resultado = await revisionComprobanteService.revisar(id, req.body || {});
      if (!resultado) return res.status(404).json({ error: 'Pedido no encontrado' });

      return res.json({ ...resultado, hora_paraguay: horaEnParaguay() });
    } catch (error) {
      // Ante cualquier problema, el comprobante queda para una persona. Nunca
      // al revés.
      //
      // Y queda marcado, que es distinto de "queda para una persona": sin la
      // etiqueta, un error acá se ve desde el tablero exactamente igual que un
      // chat donde nunca pasó nada.
      console.error('❌ [COMPROBANTE] La revisión falló:', error.message);

      const conversacion = parseInt(req.body?.conversation_id, 10);
      if (Number.isInteger(conversacion) && conversacion > 0) {
        await deliveryService
          .marcarParaVerificar(conversacion, 'error', error.message)
          .catch(() => {});
      }

      return res.status(500).json({
        entregado: false,
        motivo: 'error',
        error: error.message,
        // Que el cliente no quede sin respuesta porque el servidor falló.
        respuesta: 'Recibí tu comprobante ✅ Lo reviso y te confirmo por acá.'
      });
    }
  }
};

export default orderController;
