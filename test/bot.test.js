import assert from 'node:assert/strict';
import test from 'node:test';
import { botService } from '../src/services/index.js';

test('T-14: botService renderiza variables dinámicas {{cliente}} y {{canal}}', () => {
  const template = '¡Hola {{cliente}}! Bienvenido a {{canal}}. ¿En qué te ayudamos hoy?';
  const vars = { cliente: 'Mariana', canal: 'Sucursal Centro' };

  const result = botService.renderWelcomeMessage(template, vars);
  assert.equal(result, '¡Hola Mariana! Bienvenido a Sucursal Centro. ¿En qué te ayudamos hoy?');
});

test('T-14: botService no responde si la conversación está en estado handed_over (Pase a Humano)', async () => {
  const params = {
    channel: { id: 1, name: 'Canal Test' },
    contact: { name: 'Pedro' },
    conversation: { id: 99, bot_status: 'handed_over' },
    inboundText: 'Hola'
  };

  const response = await botService.handleInboundMessage(params);
  assert.equal(response, null, 'El bot debe permanecer en silencio si la conversación está en control de un operador');
});

test('T-14: botService no responde si la conversación está en estado disabled', async () => {
  const params = {
    channel: { id: 1, name: 'Canal Test' },
    contact: { name: 'Pedro' },
    conversation: { id: 100, bot_status: 'disabled' },
    inboundText: 'Hola'
  };

  const response = await botService.handleInboundMessage(params);
  assert.equal(response, null, 'El bot debe permanecer en silencio si está deshabilitado');
});
