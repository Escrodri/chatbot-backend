import { test } from 'node:test';
import assert from 'node:assert';
import { productoDelTexto, nombreCorto } from '../src/services/producto-foco.service.js';
import { normalizarMensajes } from '../src/services/producto-textos.js';

test('productoDelTexto: reconoce producto por saludo de anuncio configurado', () => {
  const productos = [
    {
      id: 1,
      name: 'Grandes Historias de la Biblia — Libro para Colorear (PDF)',
      slug: 'grandes-historias-de-la-biblia',
      mensajes: {
        saludo_anuncio: 'Hola, quiero información sobre las Historias de la Biblia',
        frases_anuncio: 'historias de la biblia, biblia para colorear'
      }
    },
    {
      id: 2,
      name: 'Plan 21 Días — Menús Listos y Sin Harinas',
      slug: 'plan-21-dias',
      mensajes: {
        saludo_anuncio: 'Hola 👋 Quiero el plan de 21 días',
        frases_anuncio: 'plan 21, 21 días, recetario'
      }
    }
  ];

  // Coincidencia exacta o con emojis del anuncio de 21 días
  const r1 = productoDelTexto('Hola 👋 Quiero el plan de 21 días', productos);
  assert.strictEqual(r1?.id, 2, 'Debe reconocer Plan 21 Días');

  // Coincidencia sin emojis o con variaciones
  const r2 = productoDelTexto('Hola quiero el plan de 21 dias', productos);
  assert.strictEqual(r2?.id, 2, 'Debe reconocer Plan 21 Días');

  // Coincidencia con anuncio de la Biblia
  const r3 = productoDelTexto('Hola, quiero información sobre las Historias de la Biblia', productos);
  assert.strictEqual(r3?.id, 1, 'Debe reconocer Historias de la Biblia');

  // Coincidencia con frase alternativa de anuncio
  const rFrase = productoDelTexto('Hola, quiero saber del recetario', productos);
  assert.strictEqual(rFrase?.id, 2, 'Debe reconocer por frases_anuncio');

  // Coincidencia por palabra clave exclusiva ('biblia')
  const rBiblia = productoDelTexto('Hola, quiero pintar la biblia', productos);
  assert.strictEqual(rBiblia?.id, 1, 'Debe reconocer por palabra clave exclusiva');

  // Coincidencia por número clave exclusivo ('21')
  const r21 = productoDelTexto('Quiero el de 21 dias', productos);
  assert.strictEqual(r21?.id, 2, 'Debe reconocer por número clave exclusivo');

  // Saludo genérico sin producto: NO debe asumir ninguno
  const r4 = productoDelTexto('Hola', productos);
  assert.strictEqual(r4, null, 'Un simple "Hola" no debe asociarse a ningún producto');

  const r5 = productoDelTexto('Buenos días, cómo están?', productos);
  assert.strictEqual(r5, null, 'Mensaje sin mención de producto no debe asociarse');

  const r6 = productoDelTexto('Hola, qué tal? Tienen algo disponible?', productos);
  assert.strictEqual(r6, null, 'Pregunta genérica no debe asociarse a ningún producto');
});

test('nombreCorto: recorta o respeta límite de 20 caracteres para botones', () => {
  assert.strictEqual(nombreCorto('Plan 21 Días', 20), 'Plan 21 Días');
  assert.strictEqual(nombreCorto('Grandes Historias de la Biblia — Libro para Colorear', 20), 'Grandes Historias…');
});

test('normalizarMensajes: guarda saludo_anuncio, frases_anuncio y nombre_corto', () => {
  const input = {
    saludo_anuncio: 'Hola 👋 Quiero el plan de 21 días',
    frases_anuncio: 'plan 21, 21 días',
    nombre_corto: 'Plan 21 Días',
    presentacion: ['Hola'],
    boton_comprar: 'Comprar',
    boton_muestras: 'Muestras'
  };

  const { mensajes, errores } = normalizarMensajes(input);
  assert.strictEqual(errores.length, 0);
  assert.strictEqual(mensajes.saludo_anuncio, 'Hola 👋 Quiero el plan de 21 días');
  assert.strictEqual(mensajes.frases_anuncio, 'plan 21, 21 días');
  assert.strictEqual(mensajes.nombre_corto, 'Plan 21 Días');
});

test('normalizarMensajes: valida límite de 20 caracteres en nombre_corto', () => {
  const input = {
    nombre_corto: 'Este nombre de botón tiene más de veinte letras',
    presentacion: ['Hola']
  };

  const { errores } = normalizarMensajes(input);
  assert.ok(errores.some(e => e.includes('nombre corto para botones')));
});

test('normalizarMensajes: acepta nivel_2_extra con variables válidas en seguimiento', () => {
  const input = {
    seguimiento: {
      textos: {
        nivel_2_extra: 'Hola {{nombre}}, te dejo {{producto}} en {{precio}} hasta {{vence}}'
      }
    }
  };

  const { mensajes, errores } = normalizarMensajes(input);
  assert.strictEqual(errores.length, 0);
  assert.strictEqual(mensajes.seguimiento.textos.nivel_2_extra, 'Hola {{nombre}}, te dejo {{producto}} en {{precio}} hasta {{vence}}');
});

test('normalizarMensajes y separarRedacciones: valida opciones alternativas de seguimiento separadas por ---', () => {
  const opcion1 = 'Hola {{nombre}}, ¿cómo estás? Te dejo {{producto}} en {{precio}} hasta {{vence}}.'.repeat(35); // ~2600 chars
  const opcion2 = '¡Buenas {{nombre}}! Seguís interesado en {{producto}} por {{precio}} hasta {{vence}}?'.repeat(30); // ~2500 chars
  // En total superan 5000 chars, pero cada una mide menos de 4096 (límite de WhatsApp)
  const textoCombinado = `${opcion1}\n\n---\n\n${opcion2}`;

  const input = {
    seguimiento: {
      textos: {
        nivel_1_decidido: textoCombinado
      }
    }
  };

  const { errores } = normalizarMensajes(input);
  assert.strictEqual(errores.length, 0, 'No debe fallar si cada variante individual no supera 4096');
});

