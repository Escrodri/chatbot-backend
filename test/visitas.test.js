import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/app.js';
import {
  normalizar,
  registrar,
  leerEventos,
  resumir,
  eliminarEvento,
  limpiarEventos,
  claveDelDash,
  claveValida,
  _reiniciar,
  obtenerInicioDia,
  diaEn
} from '../src/services/visitas.service.js';

const URL_ANUNCIO =
  '/?utm_source=facebook&utm_medium=paid&utm_campaign=es_plan21&utm_content=cenafinde&ad_id=23860218569400799&fbclid=IwAR123abc';

test('VISITAS: normaliza la dirección de entrada sin guardar el valor de fbclid', () => {
  const ev = normalizar({ t: 'visita', u: URL_ANUNCIO, r: 'l.facebook.com', d: 'm' });
  assert.equal(ev.tipo, 'visita');
  assert.equal(ev.utm_source, 'facebook');
  assert.equal(ev.utm_content, 'cenafinde');
  assert.equal(ev.ad_id, '23860218569400799');
  assert.equal(ev.fbclid, true);
  assert.ok(!ev.url.includes('IwAR123abc'), 'el fbclid no debe guardarse');
  assert.ok(ev.url.includes('fbclid=x'));
  assert.equal(ev.ref, 'l.facebook.com');
  assert.equal(ev.disp, 'm');
});

test('VISITAS: ad_id solo vale si son números (Meta a veces deja {{ad.id}} sin reemplazar)', () => {
  const ev = normalizar({ t: 'visita', u: '/?ad_id=%7B%7Bad.id%7D%7D&utm_source=facebook' });
  assert.equal(ev.ad_id, '');
  assert.equal(ev.utm_source, 'facebook');
});

test('VISITAS: el clic en comprar guarda el sck y la oferta del link de Hotmart', () => {
  const ev = normalizar({
    t: 'clic_comprar',
    u: URL_ANUNCIO,
    dest: 'https://pay.hotmart.com/Y107906074U?off=gkors10r&checkoutMode=10&sck=23860218569400799%7Ccenafinde'
  });
  assert.equal(ev.tipo, 'clic_comprar');
  assert.equal(ev.destino_off, 'gkors10r');
  assert.equal(ev.destino_sck, '23860218569400799|cenafinde');
});

test('VISITAS: rechaza eventos vacíos o de un tipo desconocido', () => {
  assert.equal(normalizar(null), null);
  assert.equal(normalizar({ t: 'otro', u: '/' }), null);
  assert.equal(normalizar({ t: 'visita' }), null);
});

test('VISITAS: el resumen separa por anuncio y marca qué llega y qué no', () => {
  const ahora = new Date('2026-10-19T15:00:00Z');
  const mk = (t, u, dest) => normalizar({ t, u, dest }, ahora);
  const eventos = [
    mk('visita', URL_ANUNCIO),
    mk('visita', URL_ANUNCIO),
    mk('visita', '/?utm_source=facebook&utm_content=control'),
    mk('visita', '/'),
    mk('clic_comprar', URL_ANUNCIO, 'https://pay.hotmart.com/x?sck=abc'),
    mk('clic_comprar', '/', 'https://pay.hotmart.com/x')
  ];
  const r = resumir(eventos, { ahora, dias: 7 });

  assert.equal(r.totales.visitas, 4);
  assert.equal(r.totales.clics, 2);
  assert.equal(r.diagnostico.conUtm.n, 3);
  assert.equal(r.diagnostico.conAdId.n, 2);
  assert.equal(r.diagnostico.clicsConSck.n, 1);
  assert.equal(r.diagnostico.clicsConSck.de, 2);

  const cena = r.porAnuncio.find((f) => f.nombre === 'cenafinde');
  assert.equal(cena.visitas, 2);
  assert.equal(cena.clics, 1);
  assert.ok(r.porAnuncio.find((f) => f.nombre === '(sin dato)'));
  assert.equal(r.porDia.length, 7);
  assert.equal(r.porDia.at(-1).visitas, 4);
});

test('VISITAS: la clave del dash es estable y solo abre con la correcta', () => {
  assert.equal(claveDelDash(), claveDelDash());
  assert.equal(claveValida(claveDelDash()), true);
  assert.equal(claveValida('otra-cosa'), false);
  assert.equal(claveValida(''), false);
});

test('VISITAS: POST público guarda la visita y el dash la devuelve solo con clave', async () => {
  _reiniciar();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/visitas`;

  try {
    // Como lo manda la landing: texto plano, sin cabeceras raras.
    const post = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://plan21.pediloaqui.online', 'User-Agent': 'Mozilla/5.0 (iPhone)' },
      body: JSON.stringify({ t: 'visita', u: URL_ANUNCIO, r: 'm.facebook.com', d: 'm' })
    });
    assert.equal(post.status, 204);
    assert.equal(post.headers.get('access-control-allow-origin'), 'https://plan21.pediloaqui.online');

    // Un evento inválido no se acepta.
    const malo = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0' }, body: '{"t":"x"}' });
    assert.equal(malo.status, 400);

    // Los programas (bots, vistas previas) se ignoran sin error.
    const bot = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'facebookexternalhit/1.1' },
      body: JSON.stringify({ t: 'visita', u: '/' })
    });
    assert.equal(bot.status, 204);

    // Sin clave: cerrado.
    assert.equal((await fetch(`${base}/resumen`)).status, 401);
    assert.equal((await fetch(`${base}/dash`)).status, 401);

    // Con clave: se ve la visita (la base puede no estar: queda en memoria).
    const clave = encodeURIComponent(claveDelDash());
    const res = await fetch(`${base}/resumen?dias=7&clave=${clave}`);
    assert.equal(res.status, 200);
    const datos = await res.json();
    assert.equal(datos.totales.visitas, 1);
    assert.equal(datos.porAnuncio[0].nombre, 'cenafinde');
    assert.equal(datos.porAdId[0].nombre, '23860218569400799');

    const dash = await fetch(`${base}/dash?clave=${clave}`);
    assert.equal(dash.status, 200);
    assert.match(await dash.text(), /Origen de visitas/);
  } finally {
    server.close();
  }
});

test('VISITAS: guarda campaña, conjunto, anuncio y ubicación que Meta rellena en la dirección', () => {
  const ev = normalizar({
    t: 'visita',
    u: '/?utm_source=facebook&utm_medium=paid&utm_campaign=Espa%C3%B1a%20-%20Plan%2021&utm_content=cenafinde%20ad&utm_term=Espa%C3%B1a%20-%2018-65%20-%20web' +
       '&campaign_id=23860218569390799&adset_id=23860218569410799&ad_id=23860218569400799&placement=Facebook_Mobile_Feed&site=fb'
  });
  assert.equal(ev.campaign_id, '23860218569390799');
  assert.equal(ev.adset_id, '23860218569410799');
  assert.equal(ev.ad_id, '23860218569400799');
  assert.equal(ev.placement, 'Facebook_Mobile_Feed');
  assert.equal(ev.site, 'fb');
  assert.equal(ev.utm_term, 'España - 18-65 - web');

  const r = resumir([ev], { ahora: new Date(), dias: 1 });
  assert.equal(r.diagnostico.conAdset.n, 1);
  assert.equal(r.diagnostico.conCampaignId.n, 1);
  assert.equal(r.porAdset[0].nombre, 'España - 18-65 - web');
  assert.equal(r.porCampana[0].nombre, 'España - Plan 21');
  assert.equal(r.porUbicacion[0].nombre, 'Facebook_Mobile_Feed · fb');

  // Si Meta no reemplaza la llave, no se guarda como ID.
  const sin = normalizar({ t: 'visita', u: '/?adset_id=%7B%7Badset.id%7D%7D&campaign_id=%7B%7Bcampaign.id%7D%7D' });
  assert.equal(sin.adset_id, '');
  assert.equal(sin.campaign_id, '');
});

test('VISITAS: el panel (otro dominio) puede leer el informe con su sesión: CORS con credenciales', async () => {
  _reiniciar();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/visitas`;

  try {
    // Pregunta previa del navegador (preflight) con la cabecera Authorization.
    const pre = await fetch(`${base}/resumen`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://plan21.pediloaqui.online',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization'
      }
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://plan21.pediloaqui.online');
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);

    // Un origen que no está en la lista no recibe permiso.
    const ajeno = await fetch(`${base}/resumen`, { method: 'OPTIONS', headers: { Origin: 'https://otro.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(ajeno.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
  }
});

test('VISITAS: eliminar evento puntual y limpiar pruebas de la memoria', async () => {
  _reiniciar();
  const ev1 = await registrar(normalizar({ t: 'visita', u: '/?utm_source=facebook&utm_content=anuncio1' }));
  const ev2 = await registrar(normalizar({ t: 'visita', u: '/?directo=prueba' }));

  const antes = await leerEventos(new Date(Date.now() - 60000));
  assert.equal(antes.eventos.length, 2);

  // Eliminar evento individual
  await eliminarEvento(ev1.id, ev1.ts);
  const despuesUno = await leerEventos(new Date(Date.now() - 60000));
  assert.equal(despuesUno.eventos.length, 1);
  assert.equal(despuesUno.eventos[0].id, ev2.id);

  // Limpiar todas las pruebas
  await limpiarEventos({ tipo: 'todas' });
  const vacio = await leerEventos(new Date(Date.now() - 60000));
  assert.equal(vacio.eventos.length, 0);
});

test('VISITAS: filtra por periodo hoy y ayer y marca es_hoy / es_ayer en recientes', () => {
  const ahora = new Date('2026-10-20T15:00:00Z');
  const zona = 'America/Asuncion';
  const inicioHoy = obtenerInicioDia(ahora, zona);
  const ayerHora = new Date(inicioHoy.getTime() - 2 * 3600000); // 2 horas antes de las 00:00 de hoy -> ayer 22:00

  const evHoy = normalizar({ t: 'visita', u: '/?utm_source=facebook&utm_content=anuncio_hoy' }, ahora);
  const evAyer = normalizar({ t: 'visita', u: '/?utm_source=facebook&utm_content=anuncio_ayer' }, ayerHora);

  // Resumen general de 7 dias
  const res7 = resumir([evHoy, evAyer], { ahora, dias: 7, zona });
  assert.equal(res7.totales.visitas, 2);
  const recHoy = res7.recientes.find((r) => r.utm_content === 'anuncio_hoy');
  const recAyer = res7.recientes.find((r) => r.utm_content === 'anuncio_ayer');
  assert.equal(recHoy.es_hoy, true);
  assert.equal(recHoy.es_ayer, false);
  assert.equal(recAyer.es_hoy, false);
  assert.equal(recAyer.es_ayer, true);

  // Resumen solo hoy
  const resHoy = resumir([evHoy], { ahora, periodo: 'hoy', zona });
  assert.equal(resHoy.totales.visitas, 1);
  assert.equal(resHoy.porDia.length, 1);
  assert.equal(resHoy.porDia[0].dia, diaEn(ahora, zona));

  // Resumen solo ayer
  const resAyer = resumir([evAyer], { ahora, periodo: 'ayer', zona });
  assert.equal(resAyer.totales.visitas, 1);
  assert.equal(resAyer.porDia.length, 1);
  assert.equal(resAyer.porDia[0].dia, diaEn(ayerHora, zona));
});

test('VISITAS: endpoint /api/visitas/resumen soporta ?periodo=hoy y ?periodo=ayer', async () => {
  _reiniciar();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/visitas`;

  try {
    const clave = encodeURIComponent(claveDelDash());
    const rHoy = await fetch(`${base}/resumen?periodo=hoy&clave=${clave}`);
    assert.equal(rHoy.status, 200);
    const dHoy = await rHoy.json();
    assert.equal(dHoy.periodo, 'hoy');
    assert.equal(dHoy.dias, 1);

    const rAyer = await fetch(`${base}/resumen?periodo=ayer&clave=${clave}`);
    assert.equal(rAyer.status, 200);
    const dAyer = await rAyer.json();
    assert.equal(dAyer.periodo, 'ayer');
    assert.equal(dAyer.dias, 1);
  } finally {
    server.close();
  }
});
