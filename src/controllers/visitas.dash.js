/**
 * Página del dash de visitas (HTML autocontenido). Se sirve en
 * GET /api/visitas/dash?clave=...  y lee /api/visitas/resumen.
 * Todo lo que viene de la gente (URLs, referrers) se pinta con textContent:
 * nada se inserta como HTML.
 */
export const DASH_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Origen de visitas</title>
<style>
  :root {
    --fondo: #f1f4f7; --tarjeta: #ffffff; --tinta: #13202b; --suave: #566676; --linea: #d8e0e7;
    --acento: #0b6b5e; --acento-fondo: #dff3ee;
    --ok: #17703f; --ok-fondo: #dcf2e4; --aviso: #8a5a00; --aviso-fondo: #fbefd2; --mal: #a8261d; --mal-fondo: #fbe0dd;
    --barra: #0b6b5e; --barra2: #e29a2c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-tema="claro"]) {
      --fondo: #0e161c; --tarjeta: #15212a; --tinta: #e5ecf1; --suave: #92a3b1; --linea: #263744;
      --acento: #5ccbb4; --acento-fondo: #14352f;
      --ok: #6fdca1; --ok-fondo: #14321f; --aviso: #f0c066; --aviso-fondo: #3a2d0e; --mal: #ff9b92; --mal-fondo: #3d1713;
      --barra: #5ccbb4; --barra2: #e8ab4a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--tinta); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .pagina { max-width: 1120px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; }
  h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.01em; text-wrap: balance; }
  .sub { color: var(--suave); font-size: .85rem; margin-top: 2px; }
  .periodos { display: flex; gap: 6px; flex-wrap: wrap; }
  .periodos button { font: inherit; font-size: .85rem; padding: 7px 14px; border: 1px solid var(--linea); background: var(--tarjeta); color: var(--tinta); border-radius: 8px; cursor: pointer; }
  .periodos button[aria-pressed="true"] { background: var(--acento); border-color: var(--acento); color: #fff; }
  @media (prefers-color-scheme: dark) { .periodos button[aria-pressed="true"] { color: #08201b; } }
  button:focus-visible { outline: 2px solid var(--acento); outline-offset: 2px; }
  .aviso { padding: 10px 14px; border-radius: 8px; background: var(--aviso-fondo); color: var(--aviso); font-size: .88rem; margin-bottom: 14px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .kpi { background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 10px; padding: 12px 14px; }
  .kpi b { display: block; font-size: 1.75rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .kpi span { color: var(--suave); font-size: .8rem; }
  .panel { background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .panel h2 { margin: 0 0 10px; font-size: .95rem; }
  .panel .nota { color: var(--suave); font-size: .8rem; margin: -4px 0 10px; }
  .chequeos { display: grid; gap: 8px; }
  .chequeo { display: grid; grid-template-columns: 74px 1fr auto; gap: 4px 12px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--linea); }
  .chequeo:first-child { border-top: 0; padding-top: 0; }
  .chequeo .que { font-weight: 600; }
  .chequeo .ayuda { grid-column: 2 / 4; color: var(--suave); font-size: .8rem; }
  .pill { text-align: center; font-size: .72rem; font-weight: 700; padding: 3px 9px; border-radius: 99px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .pill.ok { background: var(--ok-fondo); color: var(--ok); }
  .pill.aviso { background: var(--aviso-fondo); color: var(--aviso); }
  .pill.mal { background: var(--mal-fondo); color: var(--mal); }
  .pill.nada { background: var(--linea); color: var(--suave); }
  .cifra { font-variant-numeric: tabular-nums; color: var(--suave); font-size: .85rem; }
  .rejilla { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-bottom: 14px; }
  .rejilla .panel { margin-bottom: 0; }
  .tabla-caja { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th { text-align: left; color: var(--suave); font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; padding: 0 8px 6px 0; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid var(--linea); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; padding-left: 8px; }
  td.nombre { overflow-wrap: break-word; }
  td.id { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .vacio { color: var(--suave); font-size: .85rem; padding: 6px 0; }
  .dias { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding-top: 6px; }
  .dia { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 3px; }
  .dia .col { width: 100%; max-width: 38px; display: flex; flex-direction: column; justify-content: flex-end; flex: 1; }
  .dia .v { background: var(--barra); border-radius: 3px 3px 0 0; min-height: 0; }
  .dia .c { background: var(--barra2); min-height: 0; }
  .dia small { color: var(--suave); font-size: .68rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dia em { font-style: normal; font-size: .72rem; font-variant-numeric: tabular-nums; }
  .leyenda { display: flex; gap: 14px; font-size: .78rem; color: var(--suave); margin-top: 8px; }
  .leyenda i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  code, .url { font: .78rem/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; word-break: break-all; }
  .tipo { font-weight: 700; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .tipo.clic { color: var(--barra2); }
  .tipo.visita { color: var(--acento); }
  .destino { color: var(--suave); margin-top: 3px; }
</style>
</head>
<body>
<div class="pagina">
  <header>
    <div>
      <h1>Origen de visitas · Plan 21</h1>
      <div class="sub" id="sub">Cargando…</div>
    </div>
    <div class="periodos" id="periodos" role="group" aria-label="Período">
      <button type="button" data-dias="1" aria-pressed="false">Hoy</button>
      <button type="button" data-dias="7" aria-pressed="true">7 días</button>
      <button type="button" data-dias="30" aria-pressed="false">30 días</button>
    </div>
  </header>
  <div id="aviso"></div>
  <div class="kpis" id="kpis"></div>
  <section class="panel">
    <h2>¿Están llegando bien los enlaces?</h2>
    <p class="nota">Revisa en las visitas reales si el anuncio manda sus parámetros y si el botón de comprar los pasa a Hotmart.</p>
    <div class="chequeos" id="chequeos"></div>
  </section>
  <section class="panel">
    <h2>Por día</h2>
    <div class="dias" id="dias"></div>
    <div class="leyenda"><span><i style="background:var(--barra)"></i>Visitas</span><span><i style="background:var(--barra2)"></i>Clics en comprar</span></div>
  </section>
  <div class="rejilla" id="tablas"></div>
  <section class="panel">
    <h2>Parámetros de URL para los anuncios</h2>
    <p class="nota">Se pegan en el anuncio, en Seguimiento → Parámetros de URL. Meta reemplaza cada {{…}} con los datos reales en cada clic; la página los registra y manda el ID del anuncio a Hotmart.</p>
    <code id="paramsAnuncio" style="display:block;padding:10px 12px;background:var(--fondo);border-radius:8px">utm_source=facebook&amp;utm_medium=paid&amp;utm_campaign={{campaign.name}}&amp;utm_content={{ad.name}}&amp;utm_term={{adset.name}}&amp;campaign_id={{campaign.id}}&amp;adset_id={{adset.id}}&amp;ad_id={{ad.id}}&amp;placement={{placement}}&amp;site={{site_source_name}}</code>
  </section>
  <section class="panel">
    <h2>Últimas llegadas (tal cual llegan)</h2>
    <p class="nota">Hora de Asunción. En los clics se ve el enlace de pago al que se mandó a la persona.</p>
    <div id="recientes"></div>
  </section>
</div>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var clave = q.get("clave") || "";
  var dias = parseInt(q.get("dias") || "7", 10);
  if ([1, 7, 30].indexOf(dias) < 0) dias = 7;

  function el(tag, clase, texto) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined && texto !== null) n.textContent = texto;
    return n;
  }
  function limpiar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function pctTxt(p) { return p === null || p === undefined ? "—" : p.toLocaleString("es-PY") + " %"; }
  function hora(ts) {
    try {
      return new Date(ts).toLocaleString("es-PY", { timeZone: "America/Asuncion", hour12: false, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) { return ts; }
  }

  // Las direcciones llegan codificadas (%20, +): se muestran legibles. Siempre como texto, nunca como HTML.
  function leg(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch (e) { return String(s); }
  }

  function kpi(valor, etiqueta) {
    var k = el("div", "kpi");
    k.appendChild(el("b", "", valor));
    k.appendChild(el("span", "", etiqueta));
    return k;
  }

  function estado(d, minBueno) {
    if (!d.de) return ["nada", "Sin datos"];
    if (d.pct >= minBueno) return ["ok", "Bien"];
    if (d.pct > 0) return ["aviso", "Parcial"];
    return ["mal", "No llega"];
  }
  function chequeo(que, d, ayuda, minBueno) {
    var est = estado(d, minBueno);
    var c = el("div", "chequeo");
    c.appendChild(el("span", "pill " + est[0], est[1]));
    c.appendChild(el("span", "que", que));
    c.appendChild(el("span", "cifra", d.n + " de " + d.de + " · " + pctTxt(d.pct)));
    c.appendChild(el("span", "ayuda", ayuda));
    return c;
  }

  function tabla(titulo, filas, colNombre) {
    var p = el("section", "panel");
    p.appendChild(el("h2", "", titulo));
    if (!filas.length) { p.appendChild(el("div", "vacio", "Todavía no hay datos.")); return p; }
    var caja = el("div", "tabla-caja");
    var t = el("table");
    var cab = el("tr");
    [colNombre, "Visitas", "Clics", "Clic/visita"].forEach(function (h, i) { cab.appendChild(el("th", i ? "num" : "", h)); });
    var th = el("thead"); th.appendChild(cab); t.appendChild(th);
    var tb = el("tbody");
    filas.forEach(function (f) {
      var tr = el("tr");
      tr.appendChild(el("td", "nombre" + (/^\d+$/.test(f.nombre) ? " id" : ""), f.nombre));
      tr.appendChild(el("td", "num", String(f.visitas)));
      tr.appendChild(el("td", "num", String(f.clics)));
      tr.appendChild(el("td", "num", f.visitas ? f.tasa.toLocaleString("es-PY") + " %" : "—"));
      tb.appendChild(tr);
    });
    t.appendChild(tb); caja.appendChild(t); p.appendChild(caja);
    return p;
  }

  function pintar(d) {
    var sub = document.getElementById("sub");
    sub.textContent = "Actualizado " + hora(new Date().toISOString()) + " · guardado en " + (d.almacenamiento === "postgres" ? "la base de datos" : "memoria");

    var av = document.getElementById("aviso"); limpiar(av);
    if (d.almacenamiento !== "postgres") {
      av.appendChild(el("div", "aviso", "La base de datos no responde: por ahora las visitas se guardan en memoria y se pierden si el servicio se reinicia o se duerme."));
    }

    var k = document.getElementById("kpis"); limpiar(k);
    k.appendChild(kpi(String(d.totales.visitas), "Visitas"));
    k.appendChild(kpi(String(d.totales.clics), "Clics en comprar"));
    k.appendChild(kpi(pctTxt(d.totales.tasaClic), "Clic / visita"));
    k.appendChild(kpi(pctTxt(d.diagnostico.conFbclid.pct), "Llegan de Meta (fbclid)"));
    k.appendChild(kpi(pctTxt(d.diagnostico.conUtm.pct), "Con UTM"));

    var c = document.getElementById("chequeos"); limpiar(c);
    c.appendChild(chequeo("Llega utm_source", d.diagnostico.conUtm, "Si no llega, el anuncio no está mandando los parámetros a la página.", 90));
    c.appendChild(chequeo("Llega utm_content (qué anuncio)", d.diagnostico.conAnuncio, "Es lo que separa un anuncio de otro en los reportes.", 90));
    c.appendChild(chequeo("Llega adset_id (conjunto de anuncios)", d.diagnostico.conAdset, "Se activa con adset_id={{adset.id}} en Parámetros de URL del anuncio.", 90));
    c.appendChild(chequeo("Llega campaign_id (campaña)", d.diagnostico.conCampaignId, "Se activa con campaign_id={{campaign.id}} en Parámetros de URL del anuncio.", 90));
    c.appendChild(chequeo("Llega ad_id (ID del anuncio de Meta)", d.diagnostico.conAdId, "Se activa con ad_id={{ad.id}}. Es el que viaja a Hotmart dentro de sck.", 90));
    c.appendChild(chequeo("Llega placement (dónde se vio)", d.diagnostico.conPlacement, "Se activa con placement={{placement}}: Feed, Reels, Stories…", 90));
    c.appendChild(chequeo("El enlace a Hotmart lleva sck", d.diagnostico.clicsConSck, "Mide los clics en comprar: sck es lo que Hotmart guarda para saber de qué anuncio salió la venta.", 90));

    var mx = 1;
    d.porDia.forEach(function (x) { mx = Math.max(mx, x.visitas + x.clics); });
    var dd = document.getElementById("dias"); limpiar(dd);
    d.porDia.forEach(function (x) {
      var col = el("div", "dia");
      col.appendChild(el("em", "", String(x.visitas)));
      var barra = el("div", "col");
      var cl = el("div", "c"); cl.style.height = (x.clics / mx * 100) + "%";
      var vi = el("div", "v"); vi.style.height = (x.visitas / mx * 100) + "%";
      barra.appendChild(cl); barra.appendChild(vi);
      col.appendChild(barra);
      col.appendChild(el("small", "", x.dia.slice(5).replace("-", "/")));
      dd.appendChild(col);
    });

    var tb = document.getElementById("tablas"); limpiar(tb);
    tb.appendChild(tabla("Por anuncio (utm_content)", d.porAnuncio, "Anuncio"));
    if (d.porAdId.length) tb.appendChild(tabla("Por ID de anuncio (ad_id)", d.porAdId, "ID"));
    tb.appendChild(tabla("Por campaña", d.porCampana, "Campaña"));
    tb.appendChild(tabla("Por conjunto de anuncios (adset)", d.porAdset, "Conjunto"));
    tb.appendChild(tabla("Por fuente / medio", d.porFuente, "Fuente"));
    tb.appendChild(tabla("De dónde viene el clic (referrer)", d.porReferrer, "Sitio"));
    tb.appendChild(tabla("Dónde se vio (placement)", d.porUbicacion, "Ubicación"));
    tb.appendChild(tabla("Dispositivo", d.porDispositivo, "Dispositivo"));

    var r = document.getElementById("recientes"); limpiar(r);
    if (!d.recientes.length) { r.appendChild(el("div", "vacio", "Todavía no llegó ninguna visita.")); return; }
    var caja = el("div", "tabla-caja");
    var t = el("table");
    var cab = el("tr");
    ["Hora", "Qué", "Dirección con la que entró"].forEach(function (h) { cab.appendChild(el("th", "", h)); });
    var th = el("thead"); th.appendChild(cab); t.appendChild(th);
    var body = el("tbody");
    d.recientes.forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(el("td", "", hora(e.ts)));
      tr.appendChild(el("td", "", ""));
      tr.lastChild.appendChild(el("span", "tipo " + (e.tipo === "visita" ? "visita" : "clic"), e.tipo === "visita" ? "Visita" : "Clic comprar"));
      var celda = el("td", "");
      celda.appendChild(el("div", "url", leg(e.url) || "(vacía)"));
      var extra = [];
      if (e.ref) extra.push("viene de " + e.ref);
      if (e.disp) extra.push(e.disp === "m" ? "celular" : "computadora");
      if (extra.length) celda.appendChild(el("div", "destino", extra.join(" · ")));
      if (e.destino) celda.appendChild(el("div", "url destino", "→ " + leg(e.destino)));
      tr.appendChild(celda);
      body.appendChild(tr);
    });
    t.appendChild(body); caja.appendChild(t); r.appendChild(caja);
  }

  function cargar() {
    var url = "resumen?dias=" + dias + (clave ? "&clave=" + encodeURIComponent(clave) : "");
    fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Falta la clave del dash en la dirección (?clave=…)." : "Error " + r.status); return r.json(); })
      .then(pintar)
      .catch(function (e) { document.getElementById("sub").textContent = e.message; });
  }

  var botones = document.querySelectorAll("#periodos button");
  [].forEach.call(botones, function (b) {
    b.setAttribute("aria-pressed", String(parseInt(b.getAttribute("data-dias"), 10) === dias));
    b.addEventListener("click", function () {
      dias = parseInt(b.getAttribute("data-dias"), 10);
      [].forEach.call(botones, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      cargar();
    });
  });

  cargar();
  setInterval(cargar, 30000);
})();
</script>
</body>
</html>`;

export default DASH_HTML;
