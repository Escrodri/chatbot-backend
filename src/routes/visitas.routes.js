import { Router } from 'express';
import express from 'express';
import cookieParser from 'cookie-parser';
import { visitasController } from '../controllers/visitas.controller.js';

export const visitasRouter = Router();

// La landing manda el evento como text/plain (petición "simple", sin preflight);
// también se acepta JSON. Límite chico: son unas pocas líneas.
visitasRouter.post('/', express.text({ limit: '8kb' }), express.json({ limit: '8kb' }), visitasController.registrar);

// Lectura: solo con la clave del dash o con sesión de administrador.
visitasRouter.get('/resumen', cookieParser(), visitasController.resumen);
visitasRouter.get('/dash', cookieParser(), visitasController.dash);

export default visitasRouter;
