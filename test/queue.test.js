import assert from 'node:assert/strict';
import test from 'node:test';
import { queueService } from '../src/services/index.js';

test('T-09: queueService encola y ejecuta tareas de forma asíncrona', async () => {
  let executedCount = 0;

  for (let i = 0; i < 5; i++) {
    queueService.enqueue(async () => {
      await new Promise(r => setTimeout(r, 20));
      executedCount++;
    });
  }

  // Comprobar que encolar no es bloqueante (en este punto executedCount debe ser 0)
  assert.equal(executedCount, 0, 'La llamada a enqueue debe ser no bloqueante e inmediata');

  // Esperar a que la cola procese todas las tareas
  await queueService.onIdle();

  assert.equal(executedCount, 5, 'Todas las 5 tareas encoladas deben haberse ejecutado con éxito');
});
