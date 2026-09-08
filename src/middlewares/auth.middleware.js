import { verifyToken } from '../utils/jwt.util.js';
import { config } from '../config/index.js';

/**
 * Middleware para exigir sesión autenticada (JWT en Cookie o Bearer Header).
 * Asigna el usuario decodificado a `req.user`.
 */
export function requireAuth(req, res, next) {
  let token = null;

  // 1. Intentar leer de cookie HttpOnly
  if (req.cookies && req.cookies.session_token) {
    token = req.cookies.session_token;
  } 
  // 2. Intentar leer de Authorization Header (Bearer <token>)
  else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }

  if (!token) {
    return res.status(401).json({
      error: 'No autorizado: sesión requerida'
    });
  }

  const payload = verifyToken(token, config.security.sessionSecret);

  if (!payload) {
    return res.status(401).json({
      error: 'Sesión inválida o expirada'
    });
  }

  req.user = payload;
  next();
}

/**
 * Middleware para restringir acceso exclusivo a usuarios con rol 'admin'.
 * Debe ejecutarse después de `requireAuth`.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'No autorizado: sesión requerida'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Acceso restringido a administradores'
    });
  }

  next();
}
