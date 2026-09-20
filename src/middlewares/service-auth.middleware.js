import crypto from 'crypto';
import { verifyToken } from '../utils/jwt.util.js';
import { config } from '../config/index.js';

/**
 * Comparación de tokens en tiempo constante.
 *
 * Un `===` normal corta en el primer carácter distinto, y esa diferencia de
 * microsegundos es medible: permite adivinar el token carácter por carácter.
 */
function tokensCoinciden(recibido, esperado) {
  if (!recibido || !esperado) return false;

  const a = Buffer.from(String(recibido));
  const b = Buffer.from(String(esperado));

  // timingSafeEqual exige longitudes iguales, y comparar las longitudes
  // directamente volvería a filtrar información. Se normaliza con un hash.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();

  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Permite el acceso a un humano con sesión O a un servicio interno (n8n).
 *
 * El bot de n8n no tiene usuario ni contraseña: se identifica con una clave
 * compartida en la cabecera `x-service-token`. Cuando entra por esa vía queda
 * marcado como `role: 'service'`, y los controladores lo tratan distinto de un
 * asesor: sus mensajes se guardan como 'bot' y no disparan el handover.
 *
 * Se intenta primero la sesión humana, para que un asesor que además conozca
 * el token siga actuando como él mismo.
 */
export function requireAuthOrService(req, res, next) {
  // 1. Sesión humana (cookie, Bearer o ?token=)
  let token = null;

  if (req.cookies && req.cookies.session_token) {
    token = req.cookies.session_token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    const payload = verifyToken(token, config.security.sessionSecret);
    if (payload) {
      req.user = payload;
      req.esServicio = false;
      return next();
    }
  }

  // 2. Servicio interno
  const serviceToken = req.headers['x-service-token'];
  const esperado = config.automation?.serviceToken;

  if (serviceToken && esperado && tokensCoinciden(serviceToken, esperado)) {
    req.user = {
      id: null,
      name: 'Asistente',
      role: 'service',
      team_id: null
    };
    req.esServicio = true;
    return next();
  }

  return res.status(401).json({
    error: 'No autorizado: se requiere sesión o token de servicio válido'
  });
}

/**
 * Exige exclusivamente token de servicio. Para endpoints que solo consume n8n.
 */
export function requireService(req, res, next) {
  const serviceToken = req.headers['x-service-token'];
  const esperado = config.automation?.serviceToken;

  if (!esperado) {
    return res.status(503).json({
      error: 'La automatización no está configurada en este servidor (falta N8N_SERVICE_TOKEN)'
    });
  }

  if (!serviceToken || !tokensCoinciden(serviceToken, esperado)) {
    return res.status(401).json({ error: 'Token de servicio inválido' });
  }

  req.user = { id: null, name: 'Asistente', role: 'service', team_id: null };
  req.esServicio = true;
  next();
}

export default { requireAuthOrService, requireService };
