/**
 * Limitador de intentos en memoria (A-05).
 *
 * Sin dependencias externas: para un servidor único con un puñado de operadores
 * alcanza y sobra. Si algún día corrés varias instancias, esto habría que
 * moverlo a Redis para que el conteo sea compartido.
 *
 * Cuenta solo los intentos FALLIDOS: un login correcto libera el contador,
 * así que quien usa bien la aplicación nunca se topa con el límite.
 */

const almacen = new Map(); // clave -> { intentos: number, expiraEn: number }

// Limpieza periódica para que el Map no crezca sin control.
const limpieza = setInterval(() => {
  const ahora = Date.now();
  for (const [clave, registro] of almacen) {
    if (registro.expiraEn <= ahora) almacen.delete(clave);
  }
}, 60_000);
limpieza.unref?.(); // no impide que el proceso termine

/**
 * Crea un middleware limitador.
 *
 * @param {{
 *   windowMs: number,       Ventana de tiempo en milisegundos
 *   max: number,            Intentos fallidos permitidos dentro de la ventana
 *   prefijo: string,        Espacio de nombres para no mezclar contadores
 *   clave: (req) => string, De qué se agrupa (IP, email, ...)
 *   mensaje?: string
 * }} opciones
 */
export function createRateLimiter({ windowMs, max, prefijo, clave, mensaje }) {
  return function rateLimiter(req, res, next) {
    const id = `${prefijo}:${clave(req)}`;
    const ahora = Date.now();
    const registro = almacen.get(id);

    if (registro && registro.expiraEn > ahora && registro.intentos >= max) {
      const segundos = Math.ceil((registro.expiraEn - ahora) / 1000);
      res.setHeader('Retry-After', String(segundos));
      console.warn(`🚫 [RATE LIMIT] Bloqueado ${id} por ${segundos}s.`);

      return res.status(429).json({
        error: mensaje || 'Demasiados intentos. Probá de nuevo en un rato.',
        retryAfterSeconds: segundos,
        code: 'ERR_TOO_MANY_ATTEMPTS'
      });
    }

    // Al terminar la respuesta decidimos si el intento cuenta como fallido.
    res.on('finish', () => {
      const fallo = res.statusCode === 401 || res.statusCode === 403;
      const actual = almacen.get(id);

      if (fallo) {
        if (actual && actual.expiraEn > Date.now()) {
          actual.intentos += 1;
        } else {
          almacen.set(id, { intentos: 1, expiraEn: Date.now() + windowMs });
        }
      } else if (res.statusCode < 400 && actual) {
        // Login correcto: se limpia el contador.
        almacen.delete(id);
      }
    });

    return next();
  };
}

/** IP real del cliente (requiere app.set('trust proxy')). */
const ipDe = (req) => req.ip || req.socket?.remoteAddress || 'desconocida';

/** Correo enviado en el cuerpo, normalizado. */
const emailDe = (req) => String(req.body?.email || '').toLowerCase().trim() || 'sin-email';

/**
 * Límite por IP: frena a quien prueba muchas cuentas desde el mismo lugar.
 * 10 fallos cada 15 minutos.
 */
export const loginRateLimitPorIp = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefijo: 'login-ip',
  clave: ipDe,
  mensaje: 'Demasiados intentos fallidos desde esta conexión. Esperá 15 minutos antes de volver a probar.'
});

/**
 * Límite por cuenta: frena a quien ataca un correo concreto desde muchas IPs.
 * 5 fallos cada 15 minutos.
 */
export const loginRateLimitPorCuenta = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  prefijo: 'login-cuenta',
  clave: emailDe,
  mensaje: 'Demasiados intentos fallidos para esta cuenta. Esperá 15 minutos antes de volver a probar.'
});

/** Solo para pruebas: reinicia todos los contadores. */
export function resetRateLimits() {
  almacen.clear();
}

export default { createRateLimiter, loginRateLimitPorIp, loginRateLimitPorCuenta, resetRateLimits };
