import { test } from 'node:test';
import assert from 'node:assert';
import { intencionExtra, montosDelTexto, palabrasDelExtra, pareceEleccion } from '../src/services/intencion-extra.js';

// Los datos reales del Plan 21: 25 mil solo, 35 mil con el PLUS.
const base = {
  precio: 25000,
  lista: 25000,
  precioExtra: 10000,
  moneda: 'PYG',
  nombreProducto: 'Plan 21 Días — Menús Listos y Sin Harinas',
  nombreExtra: 'Plan 21 Días Plus — 3 Packs Extras (Dulce, SOS y Modo Asado)',
  botonSi: 'SÍ, QUIERO EL PLUS'
};
const antes = { ...base, bumpEstado: null, ofrecidoReciente: false };
const recien = { ...base, bumpEstado: 'ofrecido', ofrecidoReciente: true };
const viejo = { ...base, bumpEstado: 'ofrecido', ofrecidoReciente: false };

const elige = (texto, ctx) => intencionExtra(texto, ctx).intencion;

test('montosDelTexto: lee precios como los escribe la gente en Paraguay', () => {
  const m = (t, o) => montosDelTexto(t, o).map(x => x.monto);
  assert.deepStrictEqual(m('el de 35'), [35000]);
  assert.deepStrictEqual(m('35 mil'), [35000]);
  assert.deepStrictEqual(m('35mil'), [35000]);
  assert.deepStrictEqual(m('35k'), [35000]);
  assert.deepStrictEqual(m('Gs. 35.000'), [35000]);
  assert.deepStrictEqual(m('35000'), [35000]);
  assert.deepStrictEqual(m('treinta y cinco mil'), [35000]);
  assert.deepStrictEqual(m('veinticinco mil'), [25000]);
  // No son plata
  assert.deepStrictEqual(m('21 días y 3 packs'), []);
  assert.deepStrictEqual(m('el plan 21', { ignorar: [21] }), []);
  assert.deepStrictEqual(m('los dos'), []);
  assert.deepStrictEqual(m('mi número es 0985816710'), []);
});

test('palabrasDelExtra: solo las que distinguen el extra del producto', () => {
  assert.deepStrictEqual(palabrasDelExtra(base), ['plus', 'dulce', 'asado']);
});

test('intencionExtra: "el de 35" es la versión con el extra, con o sin oferta reciente', () => {
  assert.strictEqual(elige('el de 35', recien), 'extra_si');
  assert.strictEqual(elige('te dije el de 35', viejo), 'extra_si');
  assert.strictEqual(elige('No, te dije el de 35', viejo), 'extra_si');
  assert.strictEqual(elige('El de 35.000 por favor', antes), 'extra_si');
  assert.strictEqual(elige('buenas, el de 35', antes), 'extra_si');
  assert.strictEqual(elige('te transfiero el de 35', viejo), 'extra_si');
  assert.strictEqual(elige('quiero el plus', antes), 'extra_si');
  assert.strictEqual(elige('solo el plus', recien), 'extra_si');
  assert.strictEqual(elige('con todo', recien), 'extra_si');
});

test('intencionExtra: la versión sin el extra', () => {
  assert.strictEqual(elige('el de 25', recien), 'extra_no');
  assert.strictEqual(elige('solo el plan', recien), 'extra_no');
  assert.strictEqual(elige('no, solo el plan', recien), 'extra_no');
  assert.strictEqual(elige('no quiero el plus', recien), 'extra_no');
  assert.strictEqual(elige('sin el extra', antes), 'extra_no');
  assert.strictEqual(elige('el basico', recien), 'extra_no');
  // Antes de ver la oferta, nombrar el precio del producto es querer comprarlo.
  assert.strictEqual(elige('quiero el de 25', antes), 'comprar');
});

test('intencionExtra: "sí" y "no" a secas solo con la oferta fresca', () => {
  assert.strictEqual(elige('si', recien), 'extra_si');
  assert.strictEqual(elige('no gracias', recien), 'extra_no');
  assert.strictEqual(elige('si', viejo), null);
  assert.strictEqual(elige('no', viejo), null);
  // "dale" o "ok" después de "¿sumás el plus o te paso los datos?" no se adivina.
  assert.strictEqual(elige('dale', recien), null);
});

test('intencionExtra: lo que no elige nada queda para la IA', () => {
  for (const t of [
    '¿qué trae el plus?',
    'que trae el plus',
    'hola, que trae el plus',
    'cual es la diferencia entre el de 25 y el de 35',
    'el de 35 o el de 25',
    'no el de 35',
    'no me alcanza para el de 35',
    'no tengo 25',
    'mañana te paso el de 35',
    'lo voy a pensar',
    'el de 40',
    'te transferí 35 mil',
    'no como dulce',
    'quiero saber solo eso',
    'bajo 5 kilos en 21 dias?'
  ]) {
    assert.strictEqual(elige(t, recien), null, t);
  }
  // Antes de la oferta, las respuestas comunes no cuentan.
  assert.strictEqual(elige('los dos', antes), null);
  assert.strictEqual(elige('solo eso', antes), null);
  assert.strictEqual(elige('quiero el plan de 21 dias', antes), null);
});

test('intencionExtra: con precio promocional reconoce los dos totales', () => {
  const promo = { ...recien, precio: 20000, lista: 25000 };
  assert.strictEqual(elige('el de 30', promo), 'extra_si');
  assert.strictEqual(elige('el de 35', promo), 'extra_si');
  assert.strictEqual(elige('el de 20', promo), 'extra_no');
});

test('pareceEleccion: corto y afirmativo', () => {
  assert.strictEqual(pareceEleccion('el de 19'), true);
  assert.strictEqual(pareceEleccion('tengo 19 mil nomas, me alcanza?'), false);
  assert.strictEqual(pareceEleccion('ya te pagué'), false);
});
