import { automationService } from '../services/automation.service.js';

/**
 * Diagnóstico de la automatización.
 *
 * Existe para responder desde la bandeja una pregunta que hasta ahora solo se
 * podía contestar entrando al panel del hosting a leer la salida del
 * contenedor: ¿el mensaje que entró llegó a n8n, y si no llegó, por qué?
 */
export const automationController = {
  /**
   * GET /api/automation/health
   *
   * Sin parámetros devuelve lo que el backend ya sabe, sin tocar la red: es lo
   * que consulta la bandeja cada pocos segundos y tiene que ser barato.
   *
   * Con ?ping=1 además golpea la URL del webhook para ver si n8n contesta.
   * Eso lo pide una persona apretando "Probar", no el sondeo automático.
   */
  async health(req, res) {
    const estado = automationService.diagnostico();

    if (String(req.query.ping || '') === '1') {
      estado.prueba = await automationService.probarConexion();
    }

    return res.json(estado);
  },

  /**
   * POST /api/automation/ack
   *
   * Apaga el aviso una vez que alguien del equipo lo vio. No arregla nada: solo
   * evita que el cartel quede encendido para siempre después de un corte que ya
   * pasó. Si vuelve a fallar, se vuelve a encender solo.
   */
  async ack(req, res) {
    automationService.reconocerFallo();
    return res.json({ ok: true });
  },

  /**
   * GET /api/automation/settings
   *
   * Devuelve los parámetros configurados para la automatización (como tiempo de debounce).
   */
  async getSettings(req, res) {
    try {
      const debounceSeconds = await automationService.obtenerDebounceSegundos();
      return res.json({ ok: true, debounceSeconds });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  },

  /**
   * PUT /api/automation/settings
   *
   * Actualiza el tiempo de espera (debounce) en segundos.
   */
  async updateSettings(req, res) {
    try {
      const { debounceSeconds } = req.body;
      const actualizado = await automationService.actualizarDebounceSegundos(debounceSeconds, req.user?.id);
      return res.json({ ok: true, debounceSeconds: actualizado });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
};

export default automationController;
