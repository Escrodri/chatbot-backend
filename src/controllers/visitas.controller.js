import { verifyToken } from '../utils/jwt.util.js';
import { config } from '../config/index.js';
import {
  normalizar,
  registrar,
  leerEventos,
  resumir,
  eliminarEvento,
  limpiarEventos,
  claveValida
} from '../services/visitas.service.js';
import { DASH_HTML } from './visitas.dash.js';

// Programas que cargan la página sin ser personas (vistas previas, revisores de Meta, pruebas de velocidad).
const NO_PERSONAS = /bot|crawl|spider|facebookexternalhit|facebot|headless|lighthouse|pagespeed|preview|monitor/i;

// Freno por conexión: 120 eventos cada 10 minutos. No se guarda la IP, solo se cuenta en memoria.
const VENTANA_MS = 10 * 60 * 1000;
const MAX_EVENTOS = 120;
const conteo = new Map();
const limpieza = setInterval(() => {
  const ahora = Date.now();
  for (const [ip, r] of conteo) if (r.expira <= ahora) conteo.delete(ip);
}, 60_000);
limpieza.unref?.();

function dentroDelLimite(ip) {
  const ahora = Date.now();
  const r = conteo.get(ip);
  if (!r || r.expira <= ahora) {
    conteo.set(ip, { n: 1, expira: ahora + VENTANA_MS });
    return true;
  }
  r.n += 1;
  return r.n <= MAX_EVENTOS;
}

/** Acceso al informe: la clave del dash, o una sesión de administrador del panel. */
function tieneAcceso(req) {
  const clave = req.query?.clave || req.headers['x-visitas-clave'];
  if (clave && claveValida(clave)) return true;

  const token = req.cookies?.session_token
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);
  if (!token) return false;

  const payload = verifyToken(token, config.security.sessionSecret);
  return !!payload && (payload.role === 'admin' || payload.role === 'superadmin');
}

export const visitasController = {
  /**
   * POST /api/visitas   (público)
   * La landing manda { t, u, r, d, dest } como texto plano (sin preflight de CORS).
   * Siempre contesta 204 si el evento es válido: quien llama no necesita nada más.
   */
  async registrar(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (NO_PERSONAS.test(req.headers['user-agent'] || '')) return res.status(204).end();
    if (!dentroDelLimite(req.ip || 'sin-ip')) return res.status(204).end();

    let cuerpo = req.body;
    if (typeof cuerpo === 'string') {
      try { cuerpo = JSON.parse(cuerpo); } catch { cuerpo = null; }
    }

    const ev = normalizar(cuerpo);
    if (!ev) return res.status(400).json({ error: 'Evento no válido' });

    // Se responde ya; el guardado sigue por su lado y nunca rompe la respuesta.
    res.status(204).end();
    registrar(ev).catch((err) => console.warn('⚠️ [VISITAS] No se pudo registrar:', err.message));
    return undefined;
  },

  /** GET /api/visitas/resumen?dias=7 */
  async resumen(req, res) {
    if (!tieneAcceso(req)) return res.status(401).json({ error: 'Falta la clave del dash' });
    res.setHeader('Cache-Control', 'no-store');

    const dias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 7));
    const ahora = new Date();
    // Hoy = desde las 00:00 de Asunción; el resto, días corridos hacia atrás.
    const desde = new Date(ahora.getTime() - dias * 86400000);

    try {
      const { eventos, almacenamiento } = await leerEventos(desde);
      return res.json({ ...resumir(eventos, { ahora, dias }), almacenamiento, dias });
    } catch (err) {
      console.error('❌ [VISITAS] Error al armar el resumen:', err.message);
      return res.status(500).json({ error: 'No se pudo armar el resumen' });
    }
  },

  /** GET /api/visitas/dash */
  dash(req, res) {
    if (!tieneAcceso(req)) {
      return res.status(401).type('text/plain; charset=utf-8').send('Falta la clave del dash: agrega ?clave=… a la dirección.');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    return res.type('html').send(DASH_HTML);
  },

  /** DELETE /api/visitas/:id?ts=... */
  async eliminar(req, res) {
    if (!tieneAcceso(req)) return res.status(401).json({ error: 'Falta autorización de administrador' });
    const { id } = req.params;
    const { ts } = req.query;
    await eliminarEvento(id, ts);
    return res.json({ success: true });
  },

  /** DELETE /api/visitas/limpiar?tipo=todas|sin_utm */
  async limpiar(req, res) {
    if (!tieneAcceso(req)) return res.status(401).json({ error: 'Falta autorización de administrador' });
    const { tipo = 'todas' } = req.query;
    await limpiarEventos({ tipo });
    return res.json({ success: true });
  }
};

export default visitasController;
