import { orderRepository, ETAPAS, posicionEtapa, soportaEquipos } from '../repositories/order.repository.js';
import { productRepository } from '../repositories/product.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { deliveryService } from '../services/delivery.service.js';
import { socketManager } from '../sockets/index.js';
import { envConfig, horaEnParaguay } from '../config/env.config.js';
import { userRepository } from '../repositories/user.repository.js';
import { autoReviewService } from '../services/auto-review.service.js';
import { datosPagoService } from '../services/datos-pago.service.js';

/**
 * El id de un mensaje de nuestra base, o null.
 *
 * Existe porque `Number()` convierte null, undefined y la cadena vacía en 0, y
 * `Number.isInteger(0)` es verdadero. La guarda que había —"pasalo solo si es
 * un entero"— dejaba pasar el cero, y cero no es ningún mensaje: la clave
 * foránea contra `messages` hacía fallar el UPDATE justo en el momento de
 * cobrar, con un error 23503 que nadie atrapaba.
 *
 * El guion no manda ese campo casi nunca, así que la entrega automática
 * terminaba en 500 en el caso normal. El comprobante era bueno, el dinero
 * estaba, y el cliente esperaba hasta la mañana igual.
 *
 * @param {*} valor
 * @returns {number|null}
 */
function idDeMensaje(valor) {
  if (valor === null || valor === undefined) return null;

  const texto = String(valor).trim();
  // Solo dígitos: el guion a veces manda el identificador de Meta ("wamid.…"),
  // que no es un número de nuestra base.
  if (!/^\d+$/.test(texto)) return null;

  const numero = Number(texto);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

/**
 * Una llave para el comprobante que no muestra número de operación.
 *
 * Se arma con fecha + hora + monto, todo en dígitos, porque son los tres datos
 * que cualquier pantalla de resumen muestra siempre. La misma captura reenviada
 * da exactamente la misma huella y el índice único la rechaza; dos pagos
 * distintos solo chocarían si ocurrieran en el mismo minuto por el mismo
 * importe, y ese caso cae en revisión humana.
 *
 * Se exige que estén los tres: con dos, la huella empieza a repetirse por
 * casualidad y dejaría afuera pagos buenos.
 *
 * El prefijo 9 evita que una huella pueda coincidir de casualidad con un
 * número de operación real de otro comprobante.
 *
 * @param {{fecha: *, hora: *, monto: *}} datos
 * @returns {string} Vacío si no alcanza para armarla
 */
function construirHuella({ fecha, hora, monto }) {
  const f = String(fecha || '').trim();
  const h = String(hora || '').trim();
  const m = String(monto || '').replace(/[^0-9]/g, '');

  // Forma exacta o nada.
  //
  // Antes esto limpiaba los caracteres raros y seguía adelante con lo que
  // quedara. Eso convertía una lectura rota en una huella con pinta de válida:
  // el modelo devolvió una vez la hora seguida de su propio razonamiento
  // —"0048. They included recipient name..."— y de ahí salían dígitos
  // suficientes para armar algo.
  //
  // Una fecha son ocho dígitos y una hora son cuatro. Cualquier otra cosa no
  // es un dato mal escrito: es una lectura que no se entendió, y con eso no se
  // cobra.
  if (!/^\d{8}$/.test(f) || !/^\d{4}$/.test(h) || !m) return '';

  return `9${f}${h}${m}`;
}

/**
 * Un nombre partido en palabras comparables: sin tildes, sin puntuación y en
 * minúsculas.
 *
 * Los bancos escriben el titular de cualquier manera —"RODRIGUEZ, E.",
 * "Enmanuel R.", todo en mayúsculas, con o sin tildes—, así que comparar las
 * cadenas enteras no sirve para nada. Lo que sobrevive a todas esas formas es
 * el apellido, y para eso alcanza con ver si comparten alguna palabra larga.
 *
 * @param {string|null|undefined} valor
 * @returns {string[]}
 */
/**
 * Cuántas horas hace que se hizo la transferencia, según la propia captura.
 *
 * La fecha viene como ddmmaaaa y la hora como hhmm, las dos en hora de
 * Paraguay, que es UTC-3 todo el año. Devuelve null cuando no se pueden leer:
 * quien llama decide, y decide no bloquear por eso, porque un comprobante sin
 * fecha legible no es un comprobante sospechoso, es uno mal leído.
 *
 * El número puede salir negativo si la captura dice una hora que todavía no
 * llegó. Un ratito de diferencia es normal —relojes, redondeos—, pero varias
 * horas adelantado no es un reloj: es una fecha que no salió de un banco.
 *
 * @param {{fecha: *, hora: *}} datos
 * @returns {number|null} Horas de antigüedad, negativas si está en el futuro
 */
function antiguedadEnHoras({ fecha, hora }) {
  const f = String(fecha || '').trim();
  const h = String(hora || '').trim();
  if (!/^\d{8}$/.test(f) || !/^\d{4}$/.test(h)) return null;

  const dia = Number(f.slice(0, 2));
  const mes = Number(f.slice(2, 4));
  const anio = Number(f.slice(4, 8));
  const hh = Number(h.slice(0, 2));
  const mm = Number(h.slice(2, 4));

  if (dia < 1 || dia > 31 || mes < 1 || mes > 12 || anio < 2000 || hh > 23 || mm > 59) {
    return null;
  }

  // Una fecha imposible —31 de febrero, 30 de febrero— no la rechaza nadie:
  // Date.UTC la corre en silencio al 3 de marzo y devuelve una fecha que no
  // estaba en la captura. Se comprueba a mediodía, lejos de los bordes del
  // día, que el día siga siendo el que se leyó.
  const control = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  if (
    control.getUTCFullYear() !== anio ||
    control.getUTCMonth() !== mes - 1 ||
    control.getUTCDate() !== dia
  ) {
    return null;
  }

  // Paraguay es UTC-3 todo el año desde 2024: no hay horario de verano que
  // corregir, así que la hora local más tres horas es la hora universal.
  return (Date.now() - Date.UTC(anio, mes - 1, dia, hh + 3, mm, 0)) / 3600000;
}

function normalizarNombre(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

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

      const {
        monto = null,
        cuenta = null,
        titular = null,
        operacion = null,
        // Fecha y hora de la operación. Con ellas se arma la huella que
        // reemplaza al número de operación en los comprobantes que no lo
        // muestran, que en Paraguay son la mayoría.
        fecha = null,
        hora = null,
        receipt_message_id = null
      } = req.body || {};

      const pedido = await orderRepository.findConEntrega(id);
      if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

      if (!(await puedeTocar(req, pedido))) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }

      // La llave que impide que la misma captura cobre dos veces.
      //
      // Lo ideal es el número de operación. El problema es que medio Paraguay
      // transfiere con apps cuya pantalla de resumen no lo muestra: dice
      // "¡Transferencia cargada con éxito!", el monto, a quién fue, la fecha y
      // la hora, y nada más. Exigir el número ahí no protege de nada, porque
      // esos comprobantes son perfectamente legítimos: solo manda a revisión
      // humana a la mayoría de la gente que paga, que es justo lo contrario de
      // para lo que existe todo esto.
      //
      // Cuando no hay número se arma una huella con fecha, hora y monto. Dos
      // transferencias distintas no coinciden en los tres datos salvo que
      // ocurran en el mismo minuto por el mismo importe, y en ese caso la
      // segunda cae en revisión humana, que es el lado correcto del error.
      // Reenviar la misma captura, en cambio, da siempre la misma huella y
      // queda bloqueado por el mismo índice único de siempre.
      const operacionLimpia = String(operacion || '').replace(/[^0-9]/g, '');
      const huella = construirHuella({ fecha, hora, monto });
      const claveComprobante = operacionLimpia || huella;

      // Todo lo que no termina en entrega queda marcado para que alguien mire.
      //
      // Esto está acá, en el único lugar por donde salen TODOS los rechazos, y
      // no repartido por cada uno. Cada motivo nuevo que se agregue de ahora en
      // más queda cubierto solo, que es la única forma de que no se escape
      // ninguno dentro de seis meses.
      //
      // La marca se pone sin esperarla. Del otro lado hay alguien mirando la
      // pantalla del teléfono, y no tiene por qué esperar a que se escriba una
      // etiqueta para recibir su respuesta. Si la etiqueta falla se pierde la
      // marca; si la respuesta se demora, se pierde el cliente.
      const rechazar = (motivo, detalle) => {
        // El único que no se marca: el cliente reenvía la captura de algo que
        // ya se le entregó. Eso no es un problema, es alguien contento, y
        // llenaría el filtro de chats que no hay que revisar. Un filtro con
        // ruido deja de mirarse a la semana.
        if (motivo !== 'ya_estaba_pago') {
          Promise.resolve()
            .then(() => deliveryService.marcarParaVerificar(pedido.conversation_id, motivo, detalle))
            .then(() => orderRepository.anotarRevision(
              id,
              `sin entregar (${motivo})${detalle ? ': ' + detalle : ''}`
            ))
            .catch(err => console.warn('⚠️ [VERIFICAR] Quedó sin marcar:', err.message));
        }

        return res.json({
          entregado: false,
          motivo,
          detalle,
          hora_paraguay: horaEnParaguay()
        });
      };

      // El pedido ya cobrado se corta acá, antes de tocar nada.
      //
      // Esto estaba más abajo, después de guardar el número de operación, y esa
      // diferencia de diez líneas era un agujero: la clienta pagaba, se le
      // entregaba, y cualquier imagen que mandara después por el mismo chat
      // llegaba hasta acá con un número nuevo que PISABA el de la venta real.
      // El número original quedaba libre, y esa misma captura volvía a servir
      // para cobrar otro pedido de madrugada. Un mensaje del cliente borraba
      // la huella de su propia compra.
      if (['pagado', 'entregado'].includes(pedido.status)) {
        return rechazar('ya_estaba_pago', 'Este pedido ya figura cobrado.');
      }

      // Recién ahora se anota el número, aunque después no se entregue solo.
      // Si no se guardara, el comprobante que revisa una persona a la mañana
      // queda sin número registrado y esa misma captura sirve de nuevo la
      // noche siguiente.
      //
      // Con su propio método y no pasando por `cambiarEstado`: esa función
      // vuelve a sellar la fecha de cobro cada vez que el estado es 'pagado',
      // así que anotar el número borraba quién había confirmado el pago.
      if (claveComprobante) {
        await orderRepository.guardarOperacion(id, claveComprobante);
      }

      // Un solo interruptor, y vive en el entorno del servidor.
      //
      // Acá había un segundo sistema encima: un modo guardado en la base
      // —noche, siempre, apagado— que se cambiaba desde el tablero. Eran dos
      // mecanismos decidiendo lo mismo, y cada uno sumaba sus propias formas
      // de fallar: que la tabla de ajustes no se pudiera leer, que el modo
      // quedara en 'noche' de día, que el panel no llegara al servidor. Un
      // comprobante bueno se rechazaba y desde afuera no se podía saber cuál
      // de los dos lo había frenado.
      //
      // Queda uno solo: si ENTREGA_AUTO_NOCTURNA no está en false, el sistema
      // verifica y entrega. El horario, el modo y el tablero se vuelven a
      // sumar cuando esto esté andando y se pueda probar de a una cosa.
      if (!envConfig.entregaAutomatica.habilitada) {
        return rechazar(
          'desactivada',
          'La entrega automática está apagada (ENTREGA_AUTO_NOCTURNA=false).'
        );
      }

      if (!pedido.delivery_url || !pedido.delivery_url.trim()) {
        return rechazar('sin_enlace', 'El producto no tiene enlace de entrega cargado.');
      }

      // El precio sale del producto, no de lo que mandó el guion.
      //
      // Con una excepción: si a esta persona ya se le ofreció el precio de
      // recuperación, lo que tiene que haber transferido es ese, no el de
      // lista. Sin esto, el seguimiento le ofrecía el material a Gs. 15.000,
      // la persona transfería 15.000, y la entrega automática lo rechazaba por
      // monto insuficiente contra los 19.000 del producto: quedaba esperando
      // hasta la mañana justo el cliente al que le habíamos pedido que
      // confiara en una rebaja.
      //
      // El nivel 1 no cambia nada porque no ofrece descuento.
      const precioLista = Number(pedido.price ?? pedido.amount ?? 0);
      const precioRebajado = Number(pedido.precio_recuperacion) || 0;
      const seLeOfrecioRebaja =
        Number(pedido.recuperacion_nivel || 0) >= 2 &&
        precioRebajado > 0 &&
        precioRebajado < precioLista;

      const precio = seLeOfrecioRebaja ? precioRebajado : precioLista;
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

      // El dinero tiene que haber llegado a nosotros, y alcanza con UNA señal
      // de las tres: el número de cuenta, el alias o documento, o el nombre.
      //
      // Es así y no "las tres a la vez" porque cada banco y cada billetera del
      // Paraguay muestra cosas distintas en la captura. Uno pone la cuenta
      // completa y ningún nombre; otro pone "Enviado a: ENMANUEL RODRIGUEZ" y
      // nada más; el que transfiere por alias ve el alias y no la cuenta.
      // Exigir las tres era rechazar comprobantes buenos por el formato del
      // banco del cliente, y rechazarlos justo en la franja en la que no hay
      // nadie para revisarlos a mano.
      //
      // Lo que no se hace es tomar una contradicción como fraude. Si la cuenta
      // coincide pero el nombre no, lo más probable de lejos es que el modelo
      // haya leído al que ENVÍA en vez de al que recibe —muchos comprobantes
      // muestran el nombre del ordenante más grande—, y el dinero igual entró
      // a nuestra cuenta. Se entrega.
      //
      // La dirección de falla es la correcta: si no coincide ninguna de las
      // tres, no se rechaza el pago, se manda a revisión humana.
      const cuentaLeida = String(cuenta || '').replace(/[^0-9]/g, '');

      // Contra qué se compara: PRIMERO el mensaje que el bot ya le escribió a
      // esta persona en este chat.
      //
      // El orden importa y antes estaba al revés. Buscar primero en el panel y
      // en el entorno significaba depender de que alguien hubiera cargado la
      // cuenta en un tercer lugar, además de en el guion; y como no estaba
      // cargada, se rechazaban pagos reales con "falta configurar la cuenta".
      //
      // El mensaje del chat, en cambio, existe SIEMPRE: el bot no puede haber
      // recibido un comprobante sin haber mandado antes los datos para pagar.
      // Y es el dato correcto, porque la pregunta que hay que contestar es
      // exactamente "¿transfirió a donde le dijimos que transfiera?".
      //
      // Nada de esto viene del guion: se lee de nuestra base, de un mensaje
      // que salió de nuestro servidor.
      let nuestros = await datosPagoService.leerDelChat(pedido.conversation_id);
      if (!nuestros) nuestros = await datosPagoService.leer();

      const propios = datosPagoService.identificadores(nuestros);
      const titularPropio = normalizarNombre(nuestros.titular);
      const titularLeido = normalizarNombre(titular);

      if (!propios.length && !titularPropio.length) {
        console.warn(
          `🚨 [ENTREGA AUTO] Pedido #${id}: no se pudo determinar la cuenta propia. ` +
          'No está en el chat, ni en el panel, ni en el entorno.'
        );
        return rechazar(
          'sin_cuenta_configurada',
          'No se pudo determinar a qué cuenta le dijimos que transfiera.'
        );
      }

      // Cuenta, alias o documento. Se compara por terminación y no la cadena
      // entera porque cada banco recorta el número distinto; y cuantos más
      // dígitos haya de los dos lados, más se comparan. Cuatro es el piso que
      // impone el banco que menos muestra, no el criterio que querríamos: con
      // menos, cualquier cuenta ajena que termine en esa cifra pasaría.
      const coincideCuenta = cuentaLeida.length >= 4 && propios.some(propio => {
        const largo = Math.min(propio.length, cuentaLeida.length, 6);
        return propio.slice(-largo) === cuentaLeida.slice(-largo);
      });

      // El nombre. Tienen que coincidir DOS palabras, no una.
      //
      // Antes alcanzaba con una palabra larga, y en la práctica esa palabra era
      // el apellido. En Paraguay eso no identifica a nadie: cualquier captura
      // de una transferencia a cualquier González, cualquier Rodríguez o
      // cualquier Benítez del país pasaba el control de destino y cobraba. No
      // hacía falta ni falsificar nada, bastaba con una captura ajena de verdad.
      //
      // Con dos palabras hay que compartir nombre Y apellido, que ya es una
      // persona y no un padrón entero. Se comparan de a palabras, y no la
      // cadena entera, porque los bancos las ordenan y recortan a su gusto:
      // "RODRIGUEZ, ENMANUEL", "Enmanuel Rodriguez", en mayúsculas, con o sin
      // tildes; todas esas formas comparten las mismas dos palabras.
      //
      // Lo que se pierde es el comprobante que muestra "E. RODRIGUEZ" y ninguna
      // cuenta. Ese no se rechaza: lo mira una persona. Perder la inmediatez en
      // un caso raro pesa mucho menos que regalar el material a cualquiera que
      // comparta apellido.
      const coincideTitular = (() => {
        if (!titularPropio.length || !titularLeido.length) return false;

        const propias = new Set(titularPropio.filter(p => p.length >= 3));
        const compartidas = new Set(
          titularLeido.filter(p => p.length >= 3 && propias.has(p))
        );

        // Si nuestro propio titular es una sola palabra —un nombre de fantasía,
        // un comercio—, no se le puede exigir dos. Ahí esa única palabra tiene
        // que estar, y alcanza.
        const exigidas = propias.size >= 2 ? 2 : 1;
        return compartidas.size >= exigidas;
      })();

      if (!coincideCuenta && !coincideTitular) {
        const leido = [
          cuentaLeida ? `cuenta ${cuentaLeida}` : null,
          String(titular || '').trim() ? `a nombre de "${String(titular).trim()}"` : null
        ].filter(Boolean).join(', ');

        return rechazar(
          'destino_no_reconocido',
          leido
            ? `El comprobante figura ${leido}, y eso no coincide con ninguno de nuestros datos.`
            : 'No se pudo leer ni la cuenta ni el titular de destino.'
        );
      }

      // Sin número de operación Y sin fecha/hora/monto no hay forma de saber
      // si esta captura ya se usó antes, y sin eso la misma imagen cobra todas
      // las veces que la manden.
      if (!claveComprobante) {
        return rechazar(
          'sin_identificador',
          'El comprobante no muestra número de operación ni fecha y hora legibles.'
        );
      }

      // Que la transferencia sea de recién.
      //
      // Los controles de arriba comprueban que el comprobante sea coherente, y
      // una captura vieja y auténtica es perfectamente coherente: el monto
      // alcanza, el destino somos nosotros, y ese número no se usó nunca
      // porque nunca se usó para comprar nada. Cualquiera que alguna vez le
      // haya transferido plata a este negocio se queda con una imagen que
      // cobra, y cobra cada vez que abra una conversación nueva.
      //
      // La fecha corta eso: el comprobante tiene que ser de una transferencia
      // que acaba de pasar, que es lo que se está afirmando al mandarlo.
      //
      // Si la fecha no se pudo leer no se bloquea: eso es una lectura mala, no
      // un fraude, y el número de operación sigue impidiendo que la misma
      // captura cobre dos veces.
      const horasMax = Number(envConfig.entregaAutomatica.horasMaximasComprobante) || 0;
      const antiguedad = antiguedadEnHoras({ fecha, hora });

      if (horasMax > 0 && antiguedad !== null) {
        if (antiguedad > horasMax) {
          const dias = Math.floor(antiguedad / 24);
          console.warn(
            `🚨 [ENTREGA AUTO] Pedido #${id}: comprobante de hace ${Math.round(antiguedad)}h ` +
            `(${fecha} ${hora}). El tope son ${horasMax}h. Se manda a revisión humana.`
          );
          return rechazar(
            'comprobante_viejo',
            dias >= 1
              ? `El comprobante es del ${fecha.slice(0, 2)}/${fecha.slice(2, 4)}, hace ${dias} día(s).`
              : `El comprobante tiene ${Math.round(antiguedad)} horas.`
          );
        }

        // Adelantado en el tiempo. Un par de horas puede ser un reloj o un
        // redondeo; medio día no es ninguna de las dos cosas.
        if (antiguedad < -12) {
          console.warn(
            `🚨 [ENTREGA AUTO] Pedido #${id}: comprobante con fecha futura ` +
            `(${fecha} ${hora}). Se manda a revisión humana.`
          );
          return rechazar(
            'fecha_futura',
            'El comprobante figura con una fecha que todavía no llegó.'
          );
        }
      }

      // El tope del día. Ver la nota en la configuración: ningún control
      // individual puede ver que TODOS los comprobantes estén pasando.
      const tope = envConfig.entregaAutomatica.maxPorDia;
      if (tope > 0) {
        const hechas = await orderRepository.autoAprobadosDelDia();
        if (hechas >= tope) {
          console.warn(
            `🚨 [ENTREGA AUTO] Se alcanzó el tope de ${tope} entregas automáticas en el día. ` +
            'El resto pasa a revisión humana hasta mañana.'
          );
          return rechazar(
            'tope_diario',
            `Ya se entregaron ${hechas} pedidos solos hoy. El resto los revisa una persona.`
          );
        }
      }

      const repetida = await orderRepository.operacionYaUsada(claveComprobante, id);
      if (repetida) {
        console.warn(
          `🚨 [ENTREGA AUTO] Pedido #${id}: el comprobante ${claveComprobante} ya cobró el pedido #${repetida.id}. ` +
          'Se manda a revisión humana.'
        );
        return rechazar('operacion_repetida', `Ese comprobante ya se usó en el pedido #${repetida.id}.`);
      }

      // Pasó todo. Se cobra y se entrega, marcado como aprobado por el sistema
      // para que a la mañana se pueda repasar contra el extracto.
      let pagado;
      try {
        pagado = await orderRepository.cambiarEstado(id, 'pagado', {
          confirmedBy: null,
          autoAprobado: true,
          receiptOperacion: claveComprobante,
          // La misma guarda contra la carrera que usa la confirmación manual:
          // dos comprobantes del mismo chat llegando juntos de madrugada
          // entregaban dos veces.
          siEstadoEs: pedido.status,
          // Solo si es un id de mensaje de nuestra base. Ver `idDeMensaje`:
          // acá había un cero disfrazado de entero válido que hacía fallar el
          // UPDATE justo en el momento de cobrar.
          receiptMessageId: idDeMensaje(receipt_message_id),
          note:
            `Aprobado automáticamente a las ${horaEnParaguay()}h ` +
            `(verificación automática): ` +
            `monto ${montoLeido}, ${operacionLimpia ? 'operación ' + operacionLimpia : 'huella ' + huella}, ` +
            `verificado por ${[coincideCuenta ? 'cuenta/alias' : null, coincideTitular ? 'titular' : null].filter(Boolean).join(' y ')}.`
        });
      } catch (err) {
        // Última red: si entre el chequeo de arriba y este momento otro pedido
        // se quedó con el mismo número, la base lo rechaza y esto queda para
        // una persona. Que se escape a revisión humana es el resultado
        // correcto; cobrar dos veces con el mismo comprobante no.
        if (err.code === 'ERR_OPERACION_REPETIDA') {
          return rechazar('operacion_repetida', 'Ese comprobante ya se usó para cobrar otro pedido.');
        }
        throw err;
      }

      // Sin fila actualizada, otro comprobante del mismo chat llegó primero y
      // ya cobró este pedido. No se entrega de nuevo.
      if (!pagado) {
        return rechazar('ya_estaba_pago', 'Otro comprobante del mismo chat ya cobró este pedido.');
      }

      const entrega = await deliveryService.entregar(pedido, null);

      let estadoFinal = pagado;
      if (entrega.enviado) {
        const entregado = await orderRepository.cambiarEstado(id, 'entregado', { autoAprobado: true });
        if (entregado) estadoFinal = entregado;
        await deliveryService.marcarClienteQueCompro(pedido.conversation_id);
      } else {
        // Este es el peor caso de todos y el que menos se nota: el comprobante
        // pasó todos los controles, el pedido quedó COBRADO, y el mensaje con
        // el enlace no salió. Del otro lado hay alguien que pagó, a quien el
        // sistema ya le dio por bueno el pago, y que no recibió nada.
        //
        // No entra por `rechazar` —acá no se rechazó nada— así que la marca
        // hay que ponerla a mano. Es la que más urge de todas.
        await deliveryService.marcarParaVerificar(
          pedido.conversation_id,
          'cobrado_sin_entregar',
          entrega.detalle || entrega.motivo || 'El enlace no se pudo enviar.'
        );
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
        `(${horaEnParaguay()}h, ` +
        `${operacionLimpia ? 'operación ' + operacionLimpia : 'huella ' + huella}).`
      );

      return res.json({
        entregado: Boolean(entrega.enviado),
        motivo: entrega.enviado ? null : entrega.motivo,
        detalle: entrega.detalle || null,
        estado: estadoFinal.status,
        hora_paraguay: horaEnParaguay(),
        verificado_por: [coincideCuenta ? 'cuenta' : null, coincideTitular ? 'titular' : null]
          .filter(Boolean).join('+') || null
      });
    } catch (error) {
      // Ante cualquier problema, el comprobante queda para una persona. Nunca
      // al revés.
      //
      // Y queda marcado, que es distinto de "queda para una persona": sin la
      // etiqueta, un error acá se ve desde el tablero exactamente igual que un
      // chat donde nunca pasó nada. La falla que más cuesta encontrar es la
      // que no deja rastro en ningún lado salvo el registro del servidor.
      const conversacion = parseInt(req.body?.conversation_id, 10);
      if (Number.isInteger(conversacion) && conversacion > 0) {
        await deliveryService
          .marcarParaVerificar(conversacion, 'error', error.message)
          .catch(() => {});
      }

      return res.status(500).json({ entregado: false, motivo: 'error', error: error.message });
    }
  }
};

export default orderController;
