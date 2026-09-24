import { formatoGs as gs, nombreDestinoParaMostrar } from '../utils/comprobante.util.js';

/**
 * Qué se le contesta al cliente después de revisar su comprobante.
 *
 * Todas las respuestas viven acá, juntas, y no repartidas entre el guion y el
 * backend. Antes el guion contestaba algunos casos por su cuenta —el del monto
 * que no alcanza, por ejemplo— sin haber preguntado nada al backend, y así fue
 * como a un pago QR a un supermercado se le contestó "completá la diferencia":
 * el guion miró el monto, vio que faltaba, y nunca llegó a mirar a quién había
 * ido la plata.
 *
 * Tres reglas para todos los textos:
 *
 *   1. Nunca afirmar que la plata llegó. Una captura es una foto, y una foto se
 *      edita. Se dice "figura", "según el comprobante", "recibí tu captura";
 *      nunca "me llegó tu pago". El único mensaje que da el pago por bueno es
 *      el de la entrega, porque ahí ya se decidió entregar.
 *   2. Nunca acusar. Del otro lado casi siempre hay alguien que se equivocó de
 *      captura, no alguien que intenta estafar. El texto le dice qué pasó y qué
 *      tiene que hacer, y nada más.
 *   3. Siempre un paso siguiente que exista de verdad.
 */

/** Los que no dependen del comprobante sino de algo del sistema: los mira una persona. */
const REVISION_HUMANA =
  'Recibí tu comprobante ✅ Lo reviso y te confirmo por acá.';

const LEER_DE_NUEVO =
  'No llegué a leer bien esa captura 🙈\n\n' +
  '¿Me la mandás de nuevo, entera y sin recortar? Que se vean el monto, a quién fue, la fecha y el número de operación.';

function aQuien(c) {
  if (c.destino) return `a ${c.destino}`;
  if (c.cuentaFinal) return `a una cuenta terminada en ${c.cuentaFinal}`;
  return 'a otra cuenta';
}

/**
 * @param {string} motivo
 * @param {object} c Contexto: montoLeido, precio, total, totalPrevio, faltan, exceso,
 *                   destino, cuentaFinal, fechaTexto, tieneDatos
 * @returns {string|null} null cuando no hay nada que agregar
 */
export function respuestaPara(motivo, c = {}) {
  switch (motivo) {
    case 'entregado':
      return null;

    case 'sobrepago':
      // Solo se menciona si la diferencia es de verdad. Quinientos guaraníes
      // de más no justifican un mensaje que suene a trámite.
      if ((c.exceso || 0) < 1000) return null;
      return (
        (c.esPromo
          ? `Vi que tus comprobantes suman ${gs(c.total)} y con tu promo el material te salía ${gs(c.precio)}. `
          : `Vi que tus comprobantes suman ${gs(c.total)} y el material sale ${gs(c.precio)}. `) +
        'Ya le avisé al equipo para que lo revise y te escribimos por acá.'
      );

    case 'pago_parcial':
      return (
        (c.totalPrevio > 0
          ? `Revisé tu comprobante: figura ${gs(c.montoLeido)}. Con lo anterior suman ${gs(c.total)}.`
          : `Revisé tu comprobante: figura una transferencia de ${gs(c.montoLeido)}.`) +
        (c.esPromo
          ? `\n\nCon tu promo el material sale ${gs(c.precio)}${c.promoHasta ? ` (vale hasta el ${c.promoHasta})` : ''}, así que faltan ${gs(c.faltan)}. `
          : `\n\nEl material sale ${gs(c.precio)}, así que faltan ${gs(c.faltan)}. `) +
        'Cuando transfieras la diferencia, mandame esa captura y te habilito la descarga.'
      );

    case 'promo_vencida':
      // Pagó de buena fe el precio de una promo que ya había terminado. No se
      // le pide la diferencia todavía: puede que decidas respetársela, y
      // pedirle plata que después no hace falta es peor que hacerlo esperar.
      return (
        `Revisé tu comprobante: figura una transferencia de ${gs(c.total)}. ` +
        `La promo de ${gs(c.promoVencidaPrecio)} era hasta el ${c.promoVencidaHasta || 'día anterior'}, ` +
        `y ahora el material sale ${gs(c.precio)}.\n\n` +
        'Lo reviso con el equipo y te escribo por acá.'
      );

    case 'destino_no_reconocido':
      return (
        `Revisé la captura y esa transferencia figura ${aQuien(c)}, no a nuestra cuenta, así que no la puedo tomar como pago 🙏\n\n` +
        '¿Querés que te pase de nuevo los datos para transferir?'
      );

    case 'destino_ilegible':
      return (
        'No llego a ver a quién fue la transferencia en esa captura 🙈\n\n' +
        '¿Me la mandás completa, donde se vea el nombre o la cuenta de destino?'
      );

    case 'pendiente':
      return (
        'Esa captura muestra la transferencia todavía sin completar (pendiente o sin confirmar).\n\n' +
        'Cuando te figure como realizada, mandame esa captura y te habilito la descarga.'
      );

    case 'lectura_fallida':
    case 'monto_ilegible':
    case 'sin_identificador':
    case 'fecha_futura':
      return LEER_DE_NUEVO;

    case 'moneda_distinta':
      return (
        `Ese comprobante figura en otra moneda y el material sale ${gs(c.precio)}. ` +
        'Lo reviso con el equipo y te escribo por acá.'
      );

    case 'comprobante_viejo':
      return (
        `Ese comprobante es del ${c.fechaTexto || 'otro día'}. Para esta compra necesito la captura de la transferencia que hiciste ahora.\n\n` +
        'Si ya transferiste, mandame esa captura.'
      );

    case 'operacion_repetida':
      return (
        'Ese comprobante ya figura usado en otra compra, así que no lo puedo tomar 🙏\n\n' +
        'Si hiciste una transferencia nueva, mandame esa captura.'
      );

    case 'no_es_comprobante':
      return c.tieneDatos
        ? 'Esa imagen no parece un comprobante de transferencia 🙈\n\n' +
          'Cuando transfieras, mandame la captura donde se vean el monto, a quién fue y la fecha.'
        : '¡Gracias! No llego a darme cuenta qué es esa imagen 🙈 ¿Me contás por escrito qué necesitás?';

    case 'ya_estaba_pago':
      return (
        'Ese comprobante ya lo tengo registrado y tu material ya te lo mandé 🙌\n\n' +
        'Si no encontrás el enlace, decime y te lo reenvío.'
      );

    case 'posible_pago_doble':
      return (
        'Recibí este comprobante, pero tu compra ya estaba pagada y el material ya te lo mandé 🙌\n\n' +
        'Si transferiste de nuevo por error, lo revisa una persona del equipo con el banco y te escribimos por acá.'
      );

    case 'ya_pago_otra_imagen':
      return '¡Gracias! Tu compra ya está confirmada y el material ya te lo mandé 🙌 Si necesitás algo, escribime por acá.';

    case 'cobrado_sin_entregar':
      return (
        'Tu pago quedó registrado ✅ Tuve un problema para mandarte el enlace; ' +
        'te lo mandamos por acá apenas se resuelva.'
      );

    case 'monto_alto':
    case 'tope_diario':
    case 'desactivada':
    case 'sin_enlace':
    case 'sin_cuenta_configurada':
    case 'error':
    default:
      return REVISION_HUMANA;
  }
}

/**
 * Qué se le contesta cuando manda una captura que ya había mandado.
 *
 * Antes se le contestaba exactamente lo mismo que la primera vez, palabra por
 * palabra, que es la forma más rápida de que alguien se dé cuenta de que del
 * otro lado nadie está leyendo. Ahora se le dice que ya la teníamos y en qué
 * quedó, con los números de este momento.
 *
 * @param {object} previo La fila del comprobante anterior
 * @param {object} c Contexto actual: total, precio, faltan, yaPago, destino, cuentaFinal, fechaTexto
 */
export function respuestaRepetido(previo, c = {}) {
  const inicio = 'Esa captura ya me la mandaste 🙂';

  switch (previo?.veredicto) {
    case 'recibido':
      if (c.yaPago) {
        return `${inicio} Tu material ya te lo mandé; si no encontrás el enlace, decime y te lo reenvío.`;
      }
      if ((c.faltan || 0) > 0) {
        return (
          `${inicio} Según tus comprobantes van ${gs(c.total)} de ${gs(c.precio)}, así que faltan ${gs(c.faltan)}.\n\n` +
          'Cuando transfieras la diferencia, mandame esa captura.'
        );
      }
      return `${inicio} La está revisando el equipo y te confirmo por acá.`;

    case 'destino_no_reconocido':
      return (
        `${inicio} Como te comenté, figura ${aQuien(c)}, no a nuestra cuenta.\n\n` +
        '¿Querés que te pase de nuevo los datos para transferir?'
      );

    case 'comprobante_viejo':
      return (
        `${inicio} Es del ${c.fechaTexto || 'otro día'}; para esta compra necesito la de la transferencia que hiciste ahora.`
      );

    case 'operacion_repetida':
      return `${inicio} Ese comprobante figura usado en otra compra. Si hiciste una transferencia nueva, mandame esa captura.`;

    case 'moneda_distinta':
    case 'posible_pago_doble':
    default:
      return `${inicio} La está revisando el equipo y te escribimos por acá.`;
  }
}

/**
 * Una línea sobre un comprobante, para que la IA sepa qué pasó con él.
 *
 * Va al prompt del agente, no al cliente. Por eso es seca y dice
 * explícitamente qué NO se puede afirmar.
 */
export function describirParaIA(fila) {
  const monto = fila.monto ? gs(fila.monto) : 'monto ilegible';
  const destino = nombreDestinoParaMostrar(fila.titular) || (fila.cuenta ? `la cuenta ${fila.cuenta}` : 'destino ilegible');

  switch (fila.veredicto) {
    case 'recibido':
      return `${monto} a nuestra cuenta, según la captura` +
        (fila.precio_origen ? ` (se midió contra ${fila.precio_origen}).` : '.');
    case 'destino_no_reconocido':
      return `${monto} a ${destino}, que NO es nuestra cuenta. Esa plata no nos llegó.`;
    case 'pendiente':
      return 'una transferencia pendiente o sin confirmar. Todavía no cuenta.';
    case 'comprobante_viejo':
      return `un comprobante viejo (${fila.fecha || 'fecha anterior'}). No cuenta para esta compra.`;
    case 'operacion_repetida':
      return 'un comprobante que ya se había usado en otra compra. No cuenta.';
    case 'moneda_distinta':
      return 'un comprobante en otra moneda. Lo revisa una persona.';
    case 'posible_pago_doble':
      return `${monto} más, con la compra ya pagada. Lo revisa una persona con el banco.`;
    case 'lectura_fallida':
    case 'monto_ilegible':
    case 'sin_identificador':
    case 'destino_ilegible':
    case 'fecha_futura':
      return 'una captura que no se pudo leer bien. Se le pidió que la mande de nuevo.';
    default:
      return 'lo está revisando una persona del equipo.';
  }
}
