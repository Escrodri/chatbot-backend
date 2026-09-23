import { settingRepository } from '../repositories/setting.repository.js';
import {
  envConfig,
  esHorarioNocturno,
  horaEnParaguay,
  esTelefonoDePrueba
} from '../config/env.config.js';

/**
 * Cuándo puede el sistema aprobar un comprobante sin que lo mire una persona.
 *
 * La regla original era una sola: de noche sí, de día no. Es la regla correcta
 * mientras haya alguien de día, y deja de serlo en cuanto esa persona sale a
 * hacer un trámite. Entonces el comprobante de las once de la mañana queda
 * esperando igual que el de las tres de la madrugada, pero sin la excusa de la
 * hora: el cliente ve que es horario de atención, que nadie le contesta, y
 * saca la única conclusión disponible.
 *
 * Así que el horario deja de ser la regla y pasa a ser uno de los modos:
 *
 *   noche    — como hasta ahora: aprueba sola de 21 a 8 (lo que diga la
 *              configuración) y de día espera a una persona. Es el valor por
 *              defecto y al que se vuelve solo.
 *   siempre  — aprueba a cualquier hora. Es el "salgo un rato".
 *   apagado  — nunca aprueba sola, ni de madrugada. Para cuando algo huele
 *              mal y se quiere mirar todo a mano.
 *
 * El modo puede tener vencimiento, y esa es la parte que importa. Un
 * interruptor sin vencimiento se queda encendido: se activa "siempre" un
 * martes para salir dos horas y tres semanas después sigue aprobando sola a
 * las cuatro de la tarde sin que nadie lo haya decidido. Con `hasta`, el
 * sistema vuelve a "noche" solo, sin depender de que alguien se acuerde.
 */

export const CLAVE = 'revision_automatica';

export const MODOS = Object.freeze(['noche', 'siempre', 'apagado']);

/** Lo que se aplica cuando nadie tocó nada, o cuando el ajuste vence. */
const POR_DEFECTO = Object.freeze({ modo: 'noche', hasta: null, nota: null });

function normalizar(valor) {
  if (!valor || typeof valor !== 'object') return { ...POR_DEFECTO };

  const modo = MODOS.includes(valor.modo) ? valor.modo : POR_DEFECTO.modo;
  const hasta = valor.hasta ? new Date(valor.hasta) : null;
  const vigente = hasta && !isNaN(hasta.getTime()) ? hasta : null;

  return {
    modo,
    hasta: vigente ? vigente.toISOString() : null,
    nota: typeof valor.nota === 'string' ? valor.nota.slice(0, 200) : null
  };
}

export const autoReviewService = {
  MODOS,
  CLAVE,

  /**
   * El ajuste tal como está guardado, con el vencimiento ya resuelto.
   *
   * Devuelve siempre `modo_efectivo`, que es el que manda: si el ajuste venció
   * dice 'noche' aunque en la base siga escrito 'siempre'. Quien decide no
   * tiene que acordarse de comparar fechas.
   */
  async estado() {
    let guardado;
    let ilegible = false;

    try {
      guardado = normalizar(await settingRepository.leer(CLAVE, null));
    } catch (err) {
      // No poder leer el ajuste no es lo mismo que no tenerlo configurado.
      // Si la tabla no se creó o la base no contesta, no sabemos si alguien lo
      // había apagado, y la única salida segura es comportarse como si sí:
      // dejar de entregar sola. Perder inmediatez es un costo; regalar
      // material porque una consulta falló, no.
      console.error('❌ [REVISION AUTO] No se pudo leer el ajuste, se asume apagada:', err.message);
      guardado = { modo: 'apagado', hasta: null, nota: null };
      ilegible = true;
    }

    const vencido = Boolean(
      guardado.hasta && new Date(guardado.hasta).getTime() <= Date.now()
    );

    return {
      ...guardado,
      vencido,
      ilegible,
      modo_efectivo: vencido ? POR_DEFECTO.modo : guardado.modo,
      es_horario_nocturno: esHorarioNocturno(),
      hora_paraguay: horaEnParaguay(),
      // Para que la pantalla pueda decir "ahora mismo aprueba sola" sin
      // rehacer esta cuenta con otros criterios y terminar mintiendo.
      aprobando_ahora: await this.aprobandoAhora(vencido ? POR_DEFECTO.modo : guardado.modo)
    };
  },

  /** ¿Con este modo, en este momento, aprobaría sola? */
  async aprobandoAhora(modo) {
    if (!envConfig.entregaAutomatica.habilitada) return false;
    if (modo === 'apagado') return false;
    if (modo === 'siempre') return true;
    return esHorarioNocturno();
  },

  /**
   * Guarda el modo.
   *
   * @param {{ modo: string, horas?: number|null, hasta?: string|null, nota?: string|null }} pedido
   * @param {number|null} userId
   */
  async cambiar({ modo, horas = null, hasta = null, nota = null }, userId = null) {
    if (!MODOS.includes(modo)) {
      const err = new Error(`Modo inválido. Tiene que ser uno de: ${MODOS.join(', ')}.`);
      err.code = 'ERR_MODO_INVALIDO';
      throw err;
    }

    // El vencimiento se puede pedir de dos formas: una cantidad de horas
    // —que es como lo piensa quien está por salir— o una fecha concreta.
    let vence = null;
    if (Number(horas) > 0) {
      vence = new Date(Date.now() + Math.min(Number(horas), 72) * 3600000);
    } else if (hasta) {
      const f = new Date(hasta);

      // Una fecha mal escrita se rechaza en vez de ignorarse.
      //
      // Antes se descartaba en silencio y el modo quedaba SIN vencimiento, o
      // sea permanente. Pedir "aprobá sola hasta las 18:00" y que el sistema
      // entienda "aprobá sola para siempre" es la peor lectura posible de un
      // error de tipeo, y no avisaba nada.
      if (isNaN(f.getTime()) || f.getTime() <= Date.now()) {
        const err = new Error('La fecha de vencimiento no es válida o ya pasó.');
        err.code = 'ERR_VENCIMIENTO_INVALIDO';
        throw err;
      }
      vence = f;
    }

    // 'noche' y 'apagado' son estados de reposo: al vencer volverían al modo
    // por defecto, que es 'noche'. En 'noche' eso no cambia nada; en 'apagado'
    // sería grave, porque el modo que existe para decir "algo huele mal,
    // reviso todo a mano" se reactivaría solo unas horas después y volvería a
    // entregar sin revisión de madrugada. Apagar es apagar hasta que alguien
    // lo encienda.
    if (modo === 'noche' || modo === 'apagado') vence = null;

    await settingRepository.guardar(
      CLAVE,
      { modo, hasta: vence ? vence.toISOString() : null, nota: nota || null },
      userId
    );

    return this.estado();
  },

  /**
   * La pregunta que hace el controlador antes de entregar sin revisión
   * humana: ¿corresponde, ahora, para este teléfono?
   *
   * Solo decide el "cuándo". El monto, la cuenta y el número de operación se
   * siguen comprobando después, y ninguno de esos controles se saltea por
   * ningún modo ni por ningún número: el modo abre la puerta del horario, no
   * la de la seguridad.
   *
   * @param {string|null} telefono
   * @returns {Promise<{puede: boolean, motivo: string|null, detalle: string|null, modo: string, por_prueba: boolean}>}
   */
  async corresponde(telefono = null) {
    const estado = await this.estado();
    const modo = estado.modo_efectivo;

    if (!envConfig.entregaAutomatica.habilitada) {
      return {
        puede: false,
        motivo: 'desactivada',
        detalle: 'La entrega automática está apagada en la configuración del servidor.',
        modo,
        por_prueba: false
      };
    }

    if (modo === 'apagado') {
      return {
        puede: false,
        motivo: 'modo_apagado',
        detalle: 'La aprobación automática está apagada: todos los comprobantes los revisa una persona.',
        modo,
        por_prueba: false
      };
    }

    // Los números de prueba entran siempre, a cualquier hora y en cualquier
    // modo salvo 'apagado'. Es la única forma de probar el circuito completo
    // —comprobante, lectura, cobro y entrega— sin esperar a la madrugada ni
    // dejar el sistema aprobando de día para todo el mundo mientras se prueba.
    //
    // Son los números que el dueño cargó a mano en la configuración del
    // servidor, así que la lista no se puede ampliar desde afuera.
    if (esTelefonoDePrueba(telefono)) {
      return { puede: true, motivo: null, detalle: null, modo, por_prueba: true };
    }

    if (modo === 'siempre') {
      return { puede: true, motivo: null, detalle: null, modo, por_prueba: false };
    }

    if (!esHorarioNocturno()) {
      return {
        puede: false,
        motivo: 'horario_humano',
        detalle: 'Es horario de atención: lo revisa una persona.',
        modo,
        por_prueba: false
      };
    }

    return { puede: true, motivo: null, detalle: null, modo, por_prueba: false };
  }
};

export default autoReviewService;
