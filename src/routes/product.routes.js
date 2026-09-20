import { Router } from 'express';
import { productController } from '../controllers/product.controller.js';
import { requireAdmin } from '../middlewares/auth.middleware.js';
import { requireAuthOrService } from '../middlewares/service-auth.middleware.js';

export const productRouter = Router();

// Lectura: la consumen el panel, la web y el bot de n8n.
// Por eso acepta tanto sesión de asesor como token de servicio.
productRouter.get('/', requireAuthOrService, productController.list);

// Datos de entrega (el link del PDF). Se pide recién después de confirmar el pago.
productRouter.get('/:id/delivery', requireAuthOrService, productController.getDelivery);

// Alta, edición y baja: solo administradores con sesión.
productRouter.post('/upload-image', requireAuthOrService, requireAdmin, productController.uploadImage);
productRouter.post('/', requireAuthOrService, requireAdmin, productController.create);
productRouter.put('/:id', requireAuthOrService, requireAdmin, productController.update);
productRouter.delete('/:id', requireAuthOrService, requireAdmin, productController.remove);

export default productRouter;
