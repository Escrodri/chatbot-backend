import PQueue from 'p-queue';

/**
 * Servicio de Cola de Ingesta en Memoria (P-Queue)
 * Permite responder inmediatamente HTTP 200 OK a Meta (< 50ms)
 * mientras el procesamiento en base de datos, deduplicación y Socket.io se ejecutan en segundo plano.
 */
class QueueService {
  constructor() {
    this.queue = new PQueue({
      concurrency: 10, // PostgreSQL soporta múltiples transacciones concurrentes nativamente
      autoStart: true,
      timeout: 30000   // 30 segundos por tarea antes de abortar
    });

    this.queue.on('error', (error) => {
      console.error('❌ [QUEUE WORKER ERROR] Error no controlado en worker de ingesta:', error);
    });

    this.queue.on('idle', () => {
      // Cola vacía y lista
    });
  }

  /**
   * Encola una tarea asíncrona de procesamiento de webhook.
   * La llamada a este método retorna inmediatamente sin esperar a que la tarea termine,
   * permitiendo que el controlador de Express responda a Meta en menos de 50ms.
   * 
   * @param {() => Promise<void>} taskFn Función asíncrona a ejecutar
   * @returns {void}
   */
  enqueue(taskFn) {
    this.queue.add(async () => {
      try {
        await taskFn();
      } catch (err) {
        console.error('❌ [QUEUE ERROR] Fallo al procesar evento de webhook en segundo plano:', err.message);
      }
    });
  }

  /**
   * Devuelve el tamaño actual de la cola en espera.
   * @returns {number}
   */
  get size() {
    return this.queue.size;
  }

  /**
   * Devuelve la cantidad de tareas en ejecución simultánea.
   * @returns {number}
   */
  get pending() {
    return this.queue.pending;
  }

  /**
   * Espera a que todas las tareas encoladas se completen (útil para tests o shutdown).
   * @returns {Promise<void>}
   */
  async onIdle() {
    return this.queue.onIdle();
  }
}

export const queueService = new QueueService();
export default queueService;
