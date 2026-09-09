import bcrypt from 'bcryptjs';
import { userRepository } from '../repositories/user.repository.js';
import { signToken } from '../utils/jwt.util.js';
import { config } from '../config/index.js';

export const authController = {
  /**
   * Autentica a un usuario y genera la sesión HttpOnly y JWT.
   * POST /api/auth/login
   */
  async login(req, res, next) {
    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({
          error: 'Correo electrónico y contraseña son requeridos.'
        });
      }

      const user = await userRepository.findByEmail(email);

      // Si no existe o está desactivado, responder con error genérico para no dar pistas
      if (!user || !user.is_active) {
        return res.status(401).json({
          error: 'Credenciales inválidas'
        });
      }

      // Comparar contraseña con el hash bcrypt almacenado
      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({
          error: 'Credenciales inválidas'
        });
      }

      // Payload seguro sin password_hash
      const userPayload = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      };

      // Emitir token JWT (vigencia: 24 horas)
      const token = signToken(userPayload, config.security.sessionSecret, 86400);

      // Establecer Cookie HTTP-Only protegida
      // El sitio y la API viven en dominios distintos (Cloudflare y Render), así
      // que la cookie tiene que ser de tipo "none" para que el navegador la mande.
      // Sin esto las imágenes del chat, que se piden con una etiqueta <img> y no
      // pueden llevar cabecera de autorización, responderían 401.
      res.cookie('session_token', token, {
        httpOnly: true,
        secure: config.isProd,
        sameSite: config.isProd ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24h
      });

      return res.status(200).json({
        success: true,
        user: userPayload,
        token
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * Cierra la sesión activa limpiando la cookie HTTP-Only.
   * POST /api/auth/logout
   */
  async logout(req, res) {
    // Los atributos deben coincidir con los del alta, o el navegador no la borra.
    res.clearCookie('session_token', {
      httpOnly: true,
      secure: config.isProd,
      sameSite: config.isProd ? 'none' : 'lax'
    });

    return res.status(200).json({
      success: true,
      message: 'Sesión cerrada correctamente'
    });
  },

  /**
   * Obtiene la información del usuario autenticado en la sesión actual.
   * GET /api/auth/me
   */
  async me(req, res) {
    if (!req.user) {
      return res.status(401).json({
        error: 'No autorizado: sesión requerida'
      });
    }

    return res.status(200).json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role
      }
    });
  }
};

export default authController;
