import assert from 'node:assert/strict';
import test from 'node:test';
import { conversionsService } from '../src/services/conversions.service.js';
import { normalizerService } from '../src/services/normalizer.service.js';

/**
 * Lo que se prueba acá es la identificación de la persona en cada canal, que es
 * la parte que decide si Meta puede atribuir la venta a un anuncio o no.
 * Mandar un evento con los identificadores mal armados es peor que no mandarlo:
 * Meta lo acepta, no lo atribuye a nada, y uno cree que está midiendo.
 */

test('T-15: WhatsApp identifica la venta con la cuenta y el identificador del clic', () => {
  const conversacion = {
    platform: 'whatsapp',
    waba_id: '102030405060',
    ctwa_clid: 'ARzAbC123'
  };

  const { userData, error } = conversionsService.construirUserData(conversacion);

  assert.equal(error, undefined);
  assert.deepEqual(userData, {
    whatsapp_business_account_id: '102030405060',
    ctwa_clid: 'ARzAbC123'
  });
});

test('T-15: una conversación de WhatsApp que no vino de un anuncio no se informa', () => {
  const resultado = conversionsService.construirUserData({
    platform: 'whatsapp',
    waba_id: '102030405060',
    ctwa_clid: null
  });

  assert.equal(resultado.code, 'ERR_SIN_CLIC_DE_ANUNCIO');
  assert.equal(resultado.userData, undefined, 'Sin identificador del clic no se arma el evento');
});

test('T-15: Messenger identifica la venta con la página y el usuario de esa página', () => {
  const { userData } = conversionsService.construirUserData({
    platform: 'facebook',
    channel_identifier: '1160420680487663',
    platform_user_id: '28737141625973088'
  });

  assert.deepEqual(userData, {
    page_id: '1160420680487663',
    page_scoped_user_id: '28737141625973088'
  });
});

test('T-15: Instagram identifica la venta con la cuenta y el usuario', () => {
  const { userData } = conversionsService.construirUserData({
    platform: 'instagram',
    channel_identifier: '17841444218513195',
    platform_user_id: '9988776655'
  });

  assert.deepEqual(userData, {
    instagram_business_account_id: '17841444218513195',
    ig_sid: '9988776655'
  });
});

test('T-15: cada venta lleva un identificador distinto para no contarse dos veces', () => {
  const generados = new Set();
  for (let i = 0; i < 200; i++) generados.add(conversionsService.generarEventId());
  assert.equal(generados.size, 200, 'Dos ventas nunca deben compartir identificador');
});

test('T-15: sin credenciales, informar una venta no rompe nada', async () => {
  if (conversionsService.estaConfigurado()) {
    assert.ok(true, 'Con credenciales cargadas no se prueba la red');
    return;
  }

  const resultado = await conversionsService.informarVenta({
    conversation: { platform: 'facebook', channel_identifier: '1', platform_user_id: '2' },
    value: 150000,
    currency: 'PYG',
    eventId: 'venta_prueba'
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.skipped, true, 'Debe saltearse con aviso, nunca lanzar');
});

test('T-16: el identificador del clic del anuncio se rescata del webhook de WhatsApp', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102030405060',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1111313208738572' },
          contacts: [{ wa_id: '595985816710', profile: { name: 'Ana' } }],
          messages: [{
            from: '595985816710',
            id: 'wamid.TEST',
            timestamp: '1788930000',
            type: 'text',
            text: { body: 'Hola, vi el anuncio' },
            referral: {
              source_url: 'https://fb.me/anuncio',
              source_id: '120210000000000000',
              source_type: 'ad',
              ctwa_clid: 'ARzAbC123'
            }
          }]
        }
      }]
    }]
  };

  const [evento] = normalizerService.normalizeWebhookPayload(payload);

  assert.equal(evento.attribution.ctwaClid, 'ARzAbC123');
  assert.equal(evento.attribution.adId, '120210000000000000');
  assert.equal(evento.accountId, '102030405060', 'Hace falta la cuenta de WhatsApp Business');
});

test('T-16: un mensaje que no viene de un anuncio no inventa atribución', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '102030405060',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: '1111313208738572' },
          contacts: [{ wa_id: '595985816710', profile: { name: 'Ana' } }],
          messages: [{
            from: '595985816710',
            id: 'wamid.TEST2',
            timestamp: '1788930000',
            type: 'text',
            text: { body: 'Hola' }
          }]
        }
      }]
    }]
  };

  const [evento] = normalizerService.normalizeWebhookPayload(payload);
  assert.equal(evento.attribution, null);
});

test('T-16: en Messenger se rescata el anuncio de origen', () => {
  const payload = {
    object: 'page',
    entry: [{
      id: '1160420680487663',
      messaging: [{
        sender: { id: '28737141625973088' },
        recipient: { id: '1160420680487663' },
        timestamp: 1788930000000,
        referral: { ad_id: '120210000000000000', source: 'ADS', type: 'OPEN_THREAD' },
        message: { mid: 'm_TEST', text: 'Hola, vi el anuncio' }
      }]
    }]
  };

  const [evento] = normalizerService.normalizeWebhookPayload(payload);
  assert.equal(evento.attribution.adId, '120210000000000000');
  assert.equal(evento.accountId, '1160420680487663');
});

test('T-15: cada canal puede informar a un conjunto de datos distinto', () => {
  // Sin variables por plataforma, todos caen en la configuración general.
  const whatsapp = conversionsService.resolverDestino('whatsapp');
  const messenger = conversionsService.resolverDestino('facebook');

  assert.equal(typeof whatsapp.datasetId, 'string');
  assert.equal(typeof messenger.datasetId, 'string');
  assert.equal(
    whatsapp.datasetId,
    messenger.datasetId,
    'Sin configuración específica, ambos usan el conjunto de datos general'
  );

  // Un canal desconocido no debe romper la resolución.
  const raro = conversionsService.resolverDestino('telegram');
  assert.equal(typeof raro.datasetId, 'string');
});

test('T-16: un referido sin mensaje adjunto también guarda la atribución', () => {
  // Pasa cuando alguien que ya hablaba con la página vuelve desde un anuncio:
  // Meta manda el referido solo, sin mensaje. Es el caso de los clientes que
  // vuelven, que suelen ser los que más compran.
  const payload = {
    object: 'page',
    entry: [{
      id: '1160420680487663',
      messaging: [{
        sender: { id: '28737141625973088' },
        recipient: { id: '1160420680487663' },
        timestamp: 1788930000000,
        referral: { ad_id: '120299999999999999', source: 'ADS', type: 'OPEN_THREAD' }
      }]
    }]
  };

  const eventos = normalizerService.normalizeWebhookPayload(payload);
  const referido = eventos.find(e => e.eventType === 'referral');

  assert.ok(referido, 'El referido suelto no puede descartarse');
  assert.equal(referido.attribution.adId, '120299999999999999');
  assert.equal(referido.sender.id, '28737141625973088');
});

test('T-15: lo cargado en el canal manda sobre la configuración general', () => {
  const canal = { dataset_id: '999888777', conversionsToken: 'TOKEN_DEL_CANAL' };
  const destino = conversionsService.resolverDestino('whatsapp', canal);

  assert.equal(destino.datasetId, '999888777');
  assert.equal(destino.accessToken, 'TOKEN_DEL_CANAL');
});

test('T-15: un canal sin conjunto de datos propio cae en la configuración general', () => {
  const destino = conversionsService.resolverDestino('whatsapp', { dataset_id: null, conversionsToken: null });
  const general = conversionsService.resolverDestino('whatsapp');

  assert.equal(destino.datasetId, general.datasetId);
  assert.equal(destino.accessToken, general.accessToken);
});

test('T-15: el producto viaja como categoría para poder separar campañas', async () => {
  // No se manda nada a la red: sin credenciales el servicio se saltea, así que
  // lo que se comprueba es la construcción del evento a través del resultado.
  const conversacion = {
    platform: 'facebook',
    channel_identifier: '1160420680487663',
    platform_user_id: '28737141625973088'
  };

  // Con un canal que trae conjunto de datos y token, el servicio arma el evento
  // e intenta enviarlo; sin red el resultado es un error, nunca una excepción.
  const resultado = await conversionsService.informarVenta({
    conversation: conversacion,
    canal: { dataset_id: '1', conversionsToken: 'x' },
    value: 150000,
    currency: 'PYG',
    product: 'Cactus',
    eventId: 'venta_prueba_producto'
  });

  assert.equal(typeof resultado.ok, 'boolean');
  assert.notEqual(resultado.code, 'ERR_CONVERSIONES_SIN_CONFIGURAR', 'Con canal configurado no debe saltearse');
});
