import { orderRepository, posicionEtapa } from '../repositories/order.repository.js';
import { comprobanteRepository, VEREDICTOS_FINALES } from '../repositories/comprobante.repository.js';
import { conversationRepository } from '../repositories/conversation.repository.js';
import { datosPagoService } from './datos-pago.service.js';
import { deliveryService } from './delivery.service.js';
import { socketManager } from '../sockets/index.js';
import { envConfig, horaEnParaguay } from '../config/env.config.js';
import {
  idDeMensaje,
  leerMontoPYG,
  construirHuella,
  antiguedadEnHoras,
  normalizarNombre,
  coincideCuenta,
  coincideTitular,
  formatoGs,
  nombreDestinoParaMostrar
} from '../utils/comprobante.util.js';
import { respuestaPara, respuestaRepetido, describirParaIA } from './respuestas-comprobante.js';
import { precioParaPersona, describirPrecio, fechaParaguay } from './precio.service.js';

/**
 * La revisión de un comprobante, de punta a punta, en un solo lugar.
 *
 * Antes la decisión estaba partida en dos: el guion de n8n contestaba algunos
 * casos por su cuenta y le pasaba otros al backend. El que más daño hizo fue
 * el del monto: el guion comparaba lo que decía la captura contra el precio,
 * y si no alcanzaba contestaba "completá la diferencia" sin preguntarle nada
 * a nadie. Nunca llegaba a mirar a QUIÉN había ido la plata. Así, a alguien
 * que mandó un pago QR de 17.000 a un supermercado se le dijo que le faltaban
 * 2.000 para llevarse el material: se le dio por buena una plata que jamás
 * llegó a nuestra cuenta, y encima se le mostró el camino.
 *
 * Ahora el guion solo lee la imagen y manda lo que leyó. Todo lo demás —si
 * cuenta, si es repetido, qué contestarle— se decide acá, en este orden, que
 * es el que importa:
 *
 *   1. ¿Se pudo leer? ¿Es un comprobante?
 *   2. ¿Ya me mandó esta misma captura?
 *   3. ¿El pedido ya estaba pagado? (pago doble, o reenvío)
 *   4. ¿Esta transferencia ya se usó en otra compra?
 *   5. ¿Está completa, o pendiente?
 *   6. ¿Fue a NUESTRA cuenta?            ← antes que el monto, siempre
 *   7. ¿En guaraníes? ¿Se lee el monto?
 *   8. ¿Es de ahora, o una captura vieja?
 *   9. ¿Tiene con qué identificarla?
 *  10. Sumar con lo que ya pagó antes: ¿alcanza? ¿sobra?
 *  11. Controles del sistema: interruptor, enlace, tope del día.
 *  12. Cobrar y entregar.
 *
 * Todo lo que no termina en entrega deja la conversación marcada con
 * "Verificar" y el motivo escrito en el pedido.
 */

const ETAPA_DATOS = posicionEtapa('recibio_datos');

/**
 * Una revisión por pedido a la vez.
 *
 * Mandar dos capturas juntas —el álbum de WhatsApp, o dos pagos parciales
 * seguidos— dispara dos revisiones en paralelo. Las dos leían lo que ya había
 * pagado ANTES de que la otra lo anotara: cada una veía solo su parte, cada
 * una decía "falta la diferencia", y el pedido quedaba pagado entero sin que
 * nadie lo entregara. En fila, la segunda ya ve la primera.
 *
 * Es en memoria, por proceso. Si algún día hay dos servidores, lo que queda
 * protegido por la base igual —que una transferencia no cobre dos pedidos, que
 * no se entregue dos veces— sigue protegido; lo único que se pierde es la suma
 * de dos parciales que lleguen en el mismo segundo a servidores distintos, y
 * esos quedan marcados para revisar.
 */
const colas = new Map();

function enFila(clave, fn) {
  const anterior = colas.get(clave) || Promise.resolve();
  const actual = anterior.catch(() => {}).then(fn);
  const cola = actual.catch(() => {});
  colas.set(clave, cola);
  cola.then(() => {
    if (colas.get(clave) === cola) colas.delete(clave);
  });
  return actual;
}

/** El precio de lista del producto del pedido. Lo especial lo decide `precio.service.js`. */
export function precioLista(pedido) {
  return Number(pedido?.price ?? pedido?.amount ?? 0) || 0;
}

function tipoDe(entrada) {
  const crudo = String(entrada.tipo || '').trim().toUpperCase();
  const fallo = entrada.fallo_tecnico === true || entrada.fallo_tecnico === 'true';

  if (fallo) return 'FALLO';
  if (['COMPROBANTE', 'PENDIENTE', 'OTRA'].includes(crudo)) return crudo;

  // Compatibilidad con el guion viejo, que no mandaba `tipo`: solo llamaba al
  // backend con comprobantes, y cuando la lectura fallaba mandaba todo vacío.
  const vacio = ['monto', 'cuenta', 'titular', 'operacion']
    .every(k => !String(entrada[k] ?? '').replace(/[^0-9a-z]/gi, '').replace(/^0+$/, ''));
  return vacio ? 'FALLO' : 'COMPROBANTE';
}

/**
 * Revisa un comprobante y decide.
 *
 * @param {number} orderId
 * @param {object} entrada Lo que leyó el guion: tipo, monto (tal cual está
 *   escrito), cuenta, titular, operacion, fecha, hora, receipt_message_id,
 *   fallo_tecnico
 * @returns {Promise<object|null>} null si el pedido no existe
 */
export function revisar(orderId, entrada = {}) {
  return enFila(`pedido:${orderId}`, () => evaluar(orderId, entrada));
}

async function evaluar(orderId, entrada) {
  // Se relee adentro de la fila: la revisión anterior pudo haberlo cobrado.
  const pedido = await orderRepository.findConEntrega(orderId);
  if (!pedido) return null;

  const id = pedido.id;
  const conversationId = pedido.conversation_id;
  const yaPago = ['pagado', 'entregado'].includes(pedido.status);
  const tieneDatos = posicionEtapa(pedido.etapa) >= ETAPA_DATOS;

  // ── Lo que se leyó ─────────────────────────────────────────────────────
  const tipo = tipoDe(entrada);
  const { monto: montoLeido, moneda } = leerMontoPYG(entrada.monto);
  const cuentaLeida = String(entrada.cuenta || '').replace(/[^0-9]/g, '');
  const titularLeido = String(entrada.titular || '').trim().slice(0, 120);
  const operacion = String(entrada.operacion || '').replace(/[^0-9]/g, '');
  const fecha = String(entrada.fecha || '').replace(/[^0-9]/g, '');
  const hora = String(entrada.hora || '').replace(/[^0-9]/g, '');
  const messageId = idDeMensaje(entrada.receipt_message_id);

  // Un número de operación de menos de cuatro cifras no identifica nada: es un
  // recorte o una lectura a medias. Ahí manda la huella.
  const clave = operacion.length >= 4
    ? operacion
    : construirHuella({ fecha, hora, monto: montoLeido });

  const fechaTexto = /^\d{8}$/.test(fecha) ? `${fecha.slice(0, 2)}/${fecha.slice(2, 4)}` : null;
  const destino = nombreDestinoParaMostrar(titularLeido);

  // ── Qué precio le corresponde a ESTA persona ───────────────────────────
  //
  // Con remarketing el mismo comprobante de 15.000 es un pago completo para
  // quien llegó por la promo y uno a medias para quien no. Se mira en dos
  // momentos: cuando hizo la transferencia —la hora que dice la captura— y
  // ahora. El que pagó a las 23:50 del último día de la promo y manda la
  // captura a la mañana, pagó dentro de ella.
  //
  // La hora de la captura solo se usa si es creíble: ni del futuro, ni más
  // vieja que el plazo de los comprobantes. Una fecha rara no puede ser la
  // llave para meterse en una promo que ya terminó.
  const antiguedad = antiguedadEnHoras({ fecha, hora });
  const horasMax = Number(envConfig.entregaAutomatica.horasMaximasComprobante) || 0;
  const esViejo = horasMax > 0 && antiguedad !== null && antiguedad > horasMax;
  const horaCreible = antiguedad !== null && antiguedad >= -1 && (!horasMax || antiguedad <= horasMax);
  const momentoTransferencia = horaCreible ? Date.now() - antiguedad * 3600000 : null;

  // Lo que ya pasó en este pedido. Se lee antes del precio porque las horas
  // de los pagos que ya contaron también importan: quien empezó a pagar en
  // partes durante la promo la terminó de pagar dentro de ella.
  const historial = await comprobanteRepository.delPedido(id);
  const momentosPrevios = historial
    .filter(f => f.recibido && f.fecha && f.hora)
    .map(f => {
      const a = antiguedadEnHoras({ fecha: f.fecha, hora: f.hora });
      return a === null ? null : Date.now() - a * 3600000;
    });

  const precioPersona = await precioParaPersona({
    conversationId,
    productId: pedido.product_id,
    precioLista: precioLista(pedido),
    momentos: [momentoTransferencia, Date.now(), ...momentosPrevios]
  });
  const precio = precioPersona.precio;
  const origenPrecio = describirPrecio(precioPersona);
  const cuentaFinal = cuentaLeida.length >= 4 ? cuentaLeida.slice(-4) : null;

  // ── Lo que ya pasó en este pedido ──────────────────────────────────────
  const totalPrevio = historial
    .filter(f => f.recibido)
    .reduce((s, f) => s + (Number(f.monto) || 0), 0);

  const contexto = {
    montoLeido,
    precio,
    total: totalPrevio,
    totalPrevio,
    faltan: Math.max(0, precio - totalPrevio),
    exceso: Math.max(0, totalPrevio - precio),
    destino,
    cuentaFinal,
    fechaTexto,
    tieneDatos,
    yaPago,
    precioLista: precioPersona.lista,
    esPromo: precioPersona.es_promo,
    promoHasta: precioPersona.hasta_texto
  };

  const datosFila = {
    orderId: id,
    conversationId,
    messageId,
    clave: clave || null,
    monto: montoLeido,
    moneda,
    cuenta: cuentaLeida || null,
    titular: titularLeido || null,
    fecha: fecha || null,
    hora: hora || null,
    tipo,
    precioAplicado: precio || null,
    precioOrigen: origenPrecio,
    ofertaId: precioPersona.oferta_id
  };

  const receiptCheck =
    `monto=${montoLeido || 0} cuenta=${cuentaLeida} titular=${titularLeido} operacion=${clave || ''}`;

  /**
   * Termina la revisión sin entregar.
   *
   * @param {string} motivo
   * @param {object} o
   * @param {string|null} o.detalle Para el equipo, no para el cliente
   * @param {boolean} o.registrar Anotar la captura en el historial
   * @param {boolean} o.marcar Poner la etiqueta "Verificar"
   * @param {boolean} o.mover Pasar el pedido a "comprobante recibido"
   * @param {string|null} o.respuesta Texto ya armado; si no, sale de `respuestaPara`
   */
  const cerrar = async (motivo, {
    detalle = null,
    registrar = true,
    marcar = true,
    mover = true,
    respuesta = null
  } = {}) => {
    if (registrar) {
      await comprobanteRepository.registrar({ ...datosFila, veredicto: motivo, recibido: false });
    }

    const nota = `sin entregar (${motivo})${detalle ? ': ' + detalle : ''}`;

    if (mover && !yaPago) {
      await moverAComprobanteRecibido(id, { receiptCheck, messageId, nota });
      emitirEstado(conversationId, 'comprobante_recibido');
    } else if (marcar) {
      await orderRepository.anotarRevision(id, nota).catch(() => {});
    }

    if (marcar) {
      await deliveryService.marcarParaVerificar(conversationId, motivo, detalle);
    }

    return {
      entregado: false,
      motivo,
      detalle,
      respuesta: respuesta ?? respuestaPara(motivo, contexto),
      verificar: Boolean(marcar),
      total_recibido: contexto.total,
      precio,
      faltan: contexto.faltan
    };
  };

  // ── 1. ¿Se pudo leer? ¿Es un comprobante? ──────────────────────────────
  if (tipo === 'FALLO') {
    if (yaPago) return cerrar('ya_pago_otra_imagen', { registrar: false, marcar: false, mover: false });
    return cerrar('lectura_fallida', { detalle: 'La lectura de la imagen falló o vino vacía.' });
  }

  if (tipo === 'OTRA') {
    if (yaPago) return cerrar('ya_pago_otra_imagen', { registrar: false, marcar: false, mover: false });

    // Antes de tener los datos de pago, una foto cualquiera es una foto
    // cualquiera. Después, puede ser un comprobante que el modelo no
    // reconoció, y ese es exactamente el caso que hay que mirar.
    return cerrar('no_es_comprobante', {
      detalle: 'El modelo dijo que la imagen no es un comprobante.',
      registrar: false,
      marcar: tieneDatos,
      mover: false
    });
  }

  // ── 2. ¿Ya me mandó esta misma captura? ────────────────────────────────
  //
  // Solo cuenta como repetida si la vez anterior se decidió algo firme. Si la
  // anterior no se pudo leer, o estaba pendiente, esta es una segunda
  // oportunidad y se revisa de nuevo: la transferencia pendiente de hace un
  // rato tiene el mismo número que la exitosa de ahora.
  const previo = clave ? [...historial].reverse().find(f => f.clave === clave) : null;
  if (previo && VEREDICTOS_FINALES.includes(previo.veredicto)) {
    return {
      entregado: false,
      motivo: 'repetido',
      detalle: `Misma captura que antes (${previo.veredicto}).`,
      respuesta: respuestaRepetido(previo, {
        ...contexto,
        destino: nombreDestinoParaMostrar(previo.titular) || destino,
        cuentaFinal: previo.cuenta ? String(previo.cuenta).slice(-4) : cuentaFinal,
        fechaTexto: previo.fecha ? `${previo.fecha.slice(0, 2)}/${previo.fecha.slice(2, 4)}` : fechaTexto
      }),
      verificar: false,
      total_recibido: contexto.total,
      precio,
      faltan: contexto.faltan
    };
  }

  // ── Destino: se calcula una vez, lo usan varios pasos ──────────────────
  let nuestros = await datosPagoService.leerDelChat(conversationId);
  if (!nuestros) nuestros = await datosPagoService.leer();

  const propios = datosPagoService.identificadores(nuestros);
  const hayPropios = propios.length > 0 || normalizarNombre(nuestros.titular).length > 0;
  const okCuenta = coincideCuenta(propios, cuentaLeida);
  const okTitular = coincideTitular(nuestros.titular, titularLeido);
  const destinoOk = okCuenta || okTitular;
  const destinoLegible = cuentaLeida.length >= 4 || normalizarNombre(titularLeido).length > 0;

  // ── 3. ¿El pedido ya estaba pagado? ────────────────────────────────────
  if (yaPago) {
    const mismo = clave && pedido.receipt_operacion && String(pedido.receipt_operacion) === String(clave);
    if (mismo) return cerrar('ya_estaba_pago', { registrar: false, marcar: false, mover: false });

    // Otro comprobante, a nuestra cuenta, de ahora, con la compra ya pagada:
    // casi seguro transfirió dos veces. Es plata de más que llegó, y si nadie
    // la ve se entera recién con el reclamo.
    const pareceOtroPago =
      tipo === 'COMPROBANTE' && destinoOk && montoLeido && moneda !== 'OTRA' && clave && !esViejo;

    if (pareceOtroPago) {
      const r = await comprobanteRepository.registrar({ ...datosFila, veredicto: 'posible_pago_doble', recibido: true });
      if (r.repetido) {
        return cerrar('operacion_repetida', {
          detalle: 'Con la compra ya pagada, mandó un comprobante que figura usado en otra compra.',
          mover: false
        });
      }
      return cerrar('posible_pago_doble', {
        detalle: `Ya estaba pagado y mandó otro comprobante de ${formatoGs(montoLeido)} a nuestra cuenta.`,
        registrar: false,
        mover: false
      });
    }

    return cerrar('ya_pago_otra_imagen', { registrar: false, marcar: false, mover: false });
  }

  // ── 4. ¿Esta transferencia ya se usó en otra compra? ───────────────────
  if (clave) {
    const enOtro =
      (await comprobanteRepository.recibidoEnOtroPedido(clave, id)) ||
      (await orderRepository.operacionYaUsada(clave, id));
    if (enOtro) {
      return cerrar('operacion_repetida', {
        detalle: `Ya se usó en el pedido #${enOtro.order_id || enOtro.id}.`
      });
    }
  }

  // ── 5. ¿Está completa? ─────────────────────────────────────────────────
  if (tipo === 'PENDIENTE') {
    return cerrar('pendiente', { detalle: 'La captura muestra una transferencia sin completar.' });
  }

  // ── 6. ¿Fue a NUESTRA cuenta? Antes que el monto, siempre. ─────────────
  if (!hayPropios) {
    console.warn(`🚨 [COMPROBANTE] Pedido #${id}: no se sabe cuál es la cuenta propia (ni en el chat, ni en el panel, ni en el entorno).`);
    return cerrar('sin_cuenta_configurada', { detalle: 'No se pudo determinar a qué cuenta le dijimos que transfiera.' });
  }

  if (!destinoLegible) {
    return cerrar('destino_ilegible', { detalle: 'No se lee ni la cuenta ni el nombre de destino.' });
  }

  if (!destinoOk) {
    const leido = [
      titularLeido ? `a nombre de "${titularLeido}"` : null,
      cuentaLeida ? `cuenta ${cuentaLeida}` : null
    ].filter(Boolean).join(', ');
    return cerrar('destino_no_reconocido', {
      detalle: `Figura ${leido}${montoLeido ? `, por ${formatoGs(montoLeido)}` : ''}. No coincide con nuestros datos.`
    });
  }

  // ── 7. ¿En guaraníes? ¿Se lee el monto? ────────────────────────────────
  if (moneda === 'OTRA') {
    return cerrar('moneda_distinta', { detalle: `El monto figura como "${String(entrada.monto || '').slice(0, 30)}".` });
  }

  if (!montoLeido) {
    return cerrar('monto_ilegible', { detalle: 'No se pudo leer el monto.' });
  }

  // ── 8. ¿Es de ahora? ───────────────────────────────────────────────────
  if (esViejo) {
    return cerrar('comprobante_viejo', {
      detalle: `Es del ${fechaTexto} a las ${hora.slice(0, 2)}:${hora.slice(2, 4)}, hace ${Math.round(antiguedad / 24)} día(s).`
    });
  }

  if (antiguedad !== null && antiguedad < -12) {
    return cerrar('fecha_futura', { detalle: `La captura dice ${fechaTexto} ${hora}, que todavía no llegó.` });
  }

  // ── 9. ¿Tiene con qué identificarla? ───────────────────────────────────
  if (!clave) {
    return cerrar('sin_identificador', { detalle: 'Sin número de operación ni fecha y hora legibles.' });
  }

  // ── 10. Cuenta como plata recibida. Sumar con lo anterior. ─────────────
  const anotado = await comprobanteRepository.registrar({ ...datosFila, veredicto: 'recibido', recibido: true });
  if (anotado.repetido) {
    // Otro pedido la tomó entre el paso 4 y este: la base no dejó.
    return cerrar('operacion_repetida', { detalle: 'Otro pedido la registró en el mismo momento.' });
  }

  const total = await comprobanteRepository.totalRecibido(id);
  contexto.total = total;
  contexto.faltan = Math.max(0, precio - total);
  contexto.exceso = Math.max(0, total - precio);

  if (!precio) {
    return cerrar('sin_precio', { detalle: 'El producto no tiene precio cargado.', registrar: false });
  }

  if (total < precio) {
    // ¿Pagó el precio de una promo que ya terminó para esta persona?
    //
    // Es el caso más delicado del remarketing: alguien vio la promo, la dejó
    // para después, y transfirió cuando ya había vencido. Pagó de buena fe.
    // No se le entrega solo —la promo terminó— pero se le dice exactamente
    // eso, con la fecha, y queda marcado para que decidas si se la respetás.
    const vencida = precioPersona.vencidas
      .filter(v => total >= v.precio)
      .sort((a, b) => a.precio - b.precio)[0];
    if (vencida) {
      contexto.promoVencidaPrecio = vencida.precio;
      contexto.promoVencidaHasta = vencida.hasta ? fechaParaguay(vencida.hasta) : '';
      return cerrar('promo_vencida', {
        detalle:
          `Pagó ${formatoGs(total)}, el precio de la ${vencida.etiqueta}, que venció el ${contexto.promoVencidaHasta}. ` +
          `Hoy le corresponde ${formatoGs(precio)}: faltan ${formatoGs(precio - total)}.`,
        registrar: false
      });
    }

    // ¿Pagó el precio de una campaña para invitados sin haber entrado a ella?
    // Al cliente se le contesta como a cualquier pago parcial —no hay por qué
    // decirle que existe una promo a la que no llegó—, pero el motivo queda
    // distinto para que se entienda al revisarlo.
    const sinInvitacion = precioPersona.sin_invitacion.find(v => total >= v.precio);
    if (sinInvitacion) {
      return cerrar('promo_sin_invitacion', {
        detalle:
          `Pagó ${formatoGs(total)}, el precio de la ${sinInvitacion.etiqueta}, pero no llegó por el anuncio ` +
          `ni escribió la palabra clave. Le corresponde ${formatoGs(precio)}.`,
        registrar: false,
        respuesta: respuestaPara('pago_parcial', contexto)
      });
    }

    return cerrar('pago_parcial', {
      detalle: `Suma ${formatoGs(total)} de ${formatoGs(precio)} (${origenPrecio}). Faltan ${formatoGs(precio - total)}.`,
      registrar: false
    });
  }

  // ── 11. Controles del sistema ──────────────────────────────────────────
  //
  // Después de validar el comprobante y no antes: así, si algo del sistema
  // frena la entrega, el comprobante igual queda revisado y sumado, y la
  // persona que lo mire a la mañana solo tiene que confirmar.
  if (!envConfig.entregaAutomatica.habilitada) {
    return cerrar('desactivada', { detalle: 'La entrega automática está apagada (ENTREGA_AUTO_NOCTURNA=false).', registrar: false });
  }

  if (!pedido.delivery_url || !String(pedido.delivery_url).trim()) {
    return cerrar('sin_enlace', { detalle: 'El producto no tiene enlace de entrega cargado.', registrar: false });
  }

  if (precio > envConfig.entregaAutomatica.montoMaximo) {
    return cerrar('monto_alto', { detalle: 'Precio por encima del tope para aprobar sin revisión.', registrar: false });
  }

  const tope = envConfig.entregaAutomatica.maxPorDia;
  if (tope > 0) {
    const hechas = await orderRepository.autoAprobadosDelDia();
    if (hechas >= tope) {
      console.warn(`🚨 [ENTREGA AUTO] Tope de ${tope} entregas automáticas alcanzado. El resto lo revisa una persona.`);
      return cerrar('tope_diario', { detalle: `Ya se entregaron ${hechas} pedidos solos hoy.`, registrar: false });
    }
  }

  // ── 12. Cobrar y entregar ──────────────────────────────────────────────
  const verificadoPor = [okCuenta ? 'cuenta' : null, okTitular ? 'titular' : null].filter(Boolean).join('+');

  let pagado;
  try {
    pagado = await orderRepository.cambiarEstado(id, 'pagado', {
      confirmedBy: null,
      autoAprobado: true,
      receiptOperacion: clave,
      siEstadoEs: pedido.status,
      receiptMessageId: messageId,
      receiptCheck,
      note:
        `Aprobado automáticamente a las ${horaEnParaguay()}h: ` +
        `${historial.some(f => f.recibido) ? `pagó en partes, total ${formatoGs(total)}` : `monto ${formatoGs(montoLeido)}`}, ` +
        `${operacion.length >= 4 ? 'operación ' + operacion : 'huella ' + clave}, verificado por ${verificadoPor}. ` +
        `Precio: ${origenPrecio}.`
    });
  } catch (err) {
    if (err.code === 'ERR_OPERACION_REPETIDA' || err.code === '23503') {
      // 23505 en el índice viejo de pedidos cobrados, o un id de mensaje que
      // no es nuestro. Ninguno de los dos se arregla reintentando acá.
      return cerrar(err.code === '23503' ? 'error' : 'operacion_repetida', {
        detalle: err.code === '23503' ? 'No se pudo vincular el mensaje del comprobante.' : 'Ese número ya cobró otro pedido.',
        registrar: false
      });
    }
    throw err;
  }

  if (!pagado) {
    // Alguien lo confirmó a mano en este mismo instante.
    return cerrar('ya_estaba_pago', { registrar: false, marcar: false, mover: false });
  }

  // A qué precio se vendió y por qué campaña. Es lo que después permite
  // contar cuánto vendió cada una.
  await orderRepository
    .anotarPrecioCobrado(id, { precio, origen: origenPrecio, campanaId: precioPersona.campana_id })
    .catch(err => console.warn('⚠️ [PRECIO] No se pudo anotar el precio cobrado:', err.message));

  const entrega = await deliveryService.entregar(pedido, null);

  let estadoFinal = pagado;
  if (entrega.enviado) {
    const entregado = await orderRepository.cambiarEstado(id, 'entregado', { autoAprobado: true });
    if (entregado) estadoFinal = entregado;
    await deliveryService.marcarClienteQueCompro(conversationId);
  } else {
    // El peor caso y el que menos se nota: cobrado, y el enlace no salió.
    await deliveryService.marcarParaVerificar(
      conversationId,
      'cobrado_sin_entregar',
      entrega.detalle || entrega.motivo || 'El enlace no se pudo enviar.'
    );
  }

  const sobra = total - precio;
  if (sobra > 0) {
    await deliveryService.marcarParaVerificar(
      conversationId,
      'sobrepago',
      `Transfirió ${formatoGs(total)} y le correspondía ${origenPrecio}: ${formatoGs(sobra)} de más.`
    );
  }

  emitirEstado(conversationId, estadoFinal.status);

  console.log(
    `🌙 [ENTREGA AUTO] Pedido #${id} cobrado ${entrega.enviado ? 'y entregado' : 'SIN ENTREGAR'} ` +
    `(${horaEnParaguay()}h, ${formatoGs(total)}, ${verificadoPor}).`
  );

  let respuesta = null;
  if (!entrega.enviado) respuesta = respuestaPara('cobrado_sin_entregar', contexto);
  else if (sobra > 0) respuesta = respuestaPara('sobrepago', contexto);

  return {
    entregado: Boolean(entrega.enviado),
    motivo: entrega.enviado ? (sobra > 0 ? 'sobrepago' : null) : 'cobrado_sin_entregar',
    detalle: entrega.detalle || null,
    respuesta,
    verificar: !entrega.enviado || sobra > 0,
    estado: estadoFinal.status,
    total_recibido: total,
    precio,
    faltan: 0,
    verificado_por: verificadoPor || null
  };
}

/**
 * Pasa el pedido a "comprobante recibido", para que aparezca en el tablero
 * como pendiente de revisar.
 *
 * Si el id de mensaje no es de nuestra base, la clave foránea rechaza la
 * escritura entera. Eso ya tiró un 500 en el momento de cobrar una vez; acá
 * se reintenta sin el id, que es un dato de adorno.
 */
async function moverAComprobanteRecibido(id, { receiptCheck, messageId, nota }) {
  try {
    await orderRepository.cambiarEstado(id, 'comprobante_recibido', {
      receiptCheck,
      receiptMessageId: messageId,
      note: nota
    });
  } catch (err) {
    if (err.code !== '23503') throw err;
    await orderRepository.cambiarEstado(id, 'comprobante_recibido', { receiptCheck, note: nota });
  }
}

function emitirEstado(conversationId, estado) {
  conversationRepository.findById(conversationId)
    .then(conv => {
      if (conv) socketManager.emitConversationUpdated(conv.channel_id, { id: conv.id, order_status: estado });
    })
    .catch(() => {});
}

/**
 * Lo que la IA necesita saber de la plata de esta persona.
 *
 * Sin esto, cuando alguien escribía "te pasé de más", la IA no sabía que esa
 * persona había mandado un comprobante a un supermercado, ni cuánto, ni qué
 * se le había contestado. Improvisó una pregunta confusa y después se rindió
 * pasándole el chat a una persona a las cuatro de la mañana.
 *
 * Nunca lanza: si algo falla devuelve un resumen vacío y el agente sigue.
 *
 * El precio se resuelve con las mismas reglas que la revisión —ofertas de
 * esta persona, mirando ahora y las horas de los pagos que ya contaron—, así
 * la IA no le dice "faltan 4.000" a alguien que pagó completo dentro de su
 * promo.
 *
 * @param {object} pedido Una fila de `orders`
 * @param {number} lista Precio de lista del producto
 * @param {{conversationId?: number, productId?: number}} [persona] Sin esto se usa el de lista
 */
export async function resumenDePago(pedido, lista, persona = {}) {
  const base = { precio: Number(lista) || 0, lista: Number(lista) || 0, es_promo: false, etiqueta: 'precio de lista', hasta_texto: '', vencidas: [] };
  const vacio = { texto: '', comprobantes: 0, total_recibido: 0, precio: base.precio, faltan: base.precio, precio_persona: base };
  if (!pedido?.id) return vacio;

  try {
    const filas = await comprobanteRepository.delPedido(pedido.id);
    const yaPago = ['pagado', 'entregado'].includes(pedido.status);
    const recibidos = filas.filter(f => f.recibido);
    const total = recibidos.reduce((s, f) => s + (Number(f.monto) || 0), 0);

    const precioPersona = persona.conversationId
      ? await precioParaPersona({
          conversationId: persona.conversationId,
          productId: persona.productId ?? pedido.product_id ?? null,
          precioLista: lista,
          momentos: [
            Date.now(),
            ...recibidos
              .filter(f => f.fecha && f.hora)
              .map(f => {
                const a = antiguedadEnHoras({ fecha: f.fecha, hora: f.hora });
                return a === null ? null : Date.now() - a * 3600000;
              })
          ]
        })
      : base;
    const precio = precioPersona.precio;
    const lineas = [];

    if (yaPago) {
      lineas.push('Ya pagó y ya se le mandó el material.');
      if (precio && total > precio) {
        lineas.push(
          `Según sus comprobantes transfirió ${formatoGs(total)} y le correspondía ${formatoGs(precio)}: ` +
          `hay ${formatoGs(total - precio)} de más. Lo revisa una persona del equipo con el banco. No prometas devolución.`
        );
      }
    } else if (!filas.length) {
      lineas.push('Todavía no mandó ningún comprobante.');
    } else if (total > 0 && precio && total < precio) {
      const vencida = (precioPersona.vencidas || []).find(v => total >= v.precio);
      lineas.push(
        vencida
          ? `Según sus comprobantes transfirió ${formatoGs(total)}, que era el precio de una promo que ya terminó ` +
            `(${fechaParaguay(vencida.hasta)}). Hoy le corresponde ${formatoGs(precio)}. Lo revisa una persona del ` +
            'equipo: no le pidas la diferencia ni le prometas la promo.'
          : `Según sus comprobantes transfirió ${formatoGs(total)} de ${formatoGs(precio)}. Faltan ${formatoGs(precio - total)}.`
      );
    } else if (total > 0) {
      lineas.push(
        `Sus comprobantes suman ${formatoGs(total)}, que alcanza. Lo está revisando una persona del equipo para confirmar y mandarle el material.`
      );
    } else {
      lineas.push('Mandó comprobantes, pero ninguno cuenta como pago todavía.');
    }

    if (filas.length) {
      const ultimo = filas[filas.length - 1];
      lineas.push(`Su último comprobante: ${describirParaIA(ultimo)}`);
    }

    return {
      texto: lineas.join('\n'),
      comprobantes: filas.length,
      total_recibido: total,
      precio,
      faltan: Math.max(0, precio - total),
      precio_persona: precioPersona
    };
  } catch (err) {
    console.warn('⚠️ [COMPROBANTE] No se pudo armar el resumen de pagos:', err.message);
    return vacio;
  }
}

export const revisionComprobanteService = { revisar, resumenDePago, precioLista };
export default revisionComprobanteService;
