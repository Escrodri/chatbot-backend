import { Router } from 'express';
import { dataDeletionController } from '../controllers/data-deletion.controller.js';

export const dataDeletionRouter = Router();

// Endpoint de consulta de estado
dataDeletionRouter.get('/compliance/data-deletion-status', (req, res) => {
  return dataDeletionController.getStatus(req, res);
});

// Callback oficial de Meta para signed_request
dataDeletionRouter.post('/compliance/data-deletion', (req, res) => {
  return dataDeletionController.handleCallback(req, res);
});

// Alias directo para compatibilidad con URL directa /eliminacion-de-datos
dataDeletionRouter.post('/eliminacion-de-datos', (req, res) => {
  return dataDeletionController.handleCallback(req, res);
});

export default dataDeletionRouter;
