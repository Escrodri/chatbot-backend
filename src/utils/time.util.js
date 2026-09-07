const MS_PER_HOUR = 3600 * 1000;
const WINDOW_24H_MS = 24 * MS_PER_HOUR;
const WINDOW_7D_MS = 168 * MS_PER_HOUR;

/**
 * Módulo de Cálculo de Ventana de Mensajería de Meta (Reglas Oficiales v21.0):
 * - WhatsApp: Ventana de 24 horas para texto libre. Fuera de 24h solo plantillas HSM.
 * - Facebook e Instagram: Ventana estándar de 24 horas, extensible hasta 7 días (168h) con etiqueta HUMAN_AGENT.
 */
export const timeUtil = {
  /**
   * Evalúa la ventana de mensajería para una conversación respecto a la última interacción del cliente.
   * 
   * @param {Date|string|number} lastCustomerInteraction Fecha del último mensaje entrante del cliente
   * @param {'whatsapp'|'facebook'|'instagram'} platform Red social del canal
   * @returns {{
   *   isOpen: boolean,
   *   canSendFreeText: boolean,
   *   requiresHumanAgentTag: boolean,
   *   requiresTemplate: boolean,
   *   diffHours: number,
   *   remainingHours: number,
   *   windowType: 'standard_24h'|'human_agent_7d'|'expired'
   * }}
   */
  checkMessagingWindow(lastCustomerInteraction, platform) {
    if (!lastCustomerInteraction) {
      return {
        isOpen: false,
        canSendFreeText: false,
        requiresHumanAgentTag: false,
        requiresTemplate: platform === 'whatsapp',
        diffHours: Infinity,
        remainingHours: 0,
        windowType: 'expired'
      };
    }

    const lastTime = new Date(lastCustomerInteraction).getTime();
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastTime);
    const diffHours = elapsedMs / MS_PER_HOUR;

    // 1. Dentro de las primeras 24 horas (Aplica a todas las plataformas)
    if (elapsedMs <= WINDOW_24H_MS) {
      return {
        isOpen: true,
        canSendFreeText: true,
        requiresHumanAgentTag: false,
        requiresTemplate: false,
        diffHours: Math.round(diffHours * 10) / 10,
        remainingHours: Math.max(0, Math.round((24 - diffHours) * 10) / 10),
        windowType: 'standard_24h'
      };
    }

    // 2. Entre 24 horas y 7 días (168 horas)
    if (elapsedMs <= WINDOW_7D_MS) {
      if (platform === 'facebook' || platform === 'instagram') {
        // Permitido en Messenger e Instagram utilizando la etiqueta HUMAN_AGENT
        return {
          isOpen: true,
          canSendFreeText: true,
          requiresHumanAgentTag: true,
          requiresTemplate: false,
          diffHours: Math.round(diffHours * 10) / 10,
          remainingHours: Math.max(0, Math.round((168 - diffHours) * 10) / 10),
          windowType: 'human_agent_7d'
        };
      } else {
        // En WhatsApp, pasadas las 24h solo se permite plantilla HSM
        return {
          isOpen: false,
          canSendFreeText: false,
          requiresHumanAgentTag: false,
          requiresTemplate: true,
          diffHours: Math.round(diffHours * 10) / 10,
          remainingHours: 0,
          windowType: 'expired'
        };
      }
    }

    // 3. Superados los 7 días (Ventana completamente expirada en todas las redes)
    return {
      isOpen: false,
      canSendFreeText: false,
      requiresHumanAgentTag: false,
      requiresTemplate: platform === 'whatsapp',
      diffHours: Math.round(diffHours * 10) / 10,
      remainingHours: 0,
      windowType: 'expired'
    };
  }
};

export default timeUtil;
