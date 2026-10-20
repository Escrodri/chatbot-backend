/**
 * Página del dash de visitas (HTML autocontenido). Se sirve en
 * GET /api/visitas/dash?clave=... y lee /api/visitas/resumen.
 * Todo lo que viene de la gente (URLs, referrers) se pinta con textContent:
 * nada se inserta como HTML sin escapar.
 */
export const DASH_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Visitas y Anuncios · Plan 21</title>
<style>
  :root {
    --fondo: #f8fafc; --tarjeta: #ffffff; --tinta: #0f172a; --suave: #64748b; --linea: #e2e8f0;
    --acento: #0d9488; --acento-fondo: #ccfbf1; --acento-osc: #115e59;
    --ok: #16a34a; --ok-fondo: #dcfce7; --ok-borde: #bbf7d0;
    --aviso: #d97706; --aviso-fondo: #fef3c7; --aviso-borde: #fde68a;
    --mal: #dc2626; --mal-fondo: #fee2e2; --mal-borde: #fecaca;
    --barra: #0d9488; --barra2: #f97316;
    --clic-fondo: #fff7ed; --clic-borde: #ffedd5; --clic-texto: #c2410c;
    --chip-bg: #f1f5f9; --chip-borde: #cbd5e1;
    --sombra: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-tema="claro"]) {
      --fondo: #0b1120; --tarjeta: #131c2e; --tinta: #f8fafc; --suave: #94a3b8; --linea: #1e293b;
      --acento: #14b8a6; --acento-fondo: #042f2e; --acento-osc: #5eead4;
      --ok: #4ade80; --ok-fondo: #052e16; --ok-borde: #14532d;
      --aviso: #fbbf24; --aviso-fondo: #451a03; --aviso-borde: #78350f;
      --mal: #f87171; --mal-fondo: #450a0a; --mal-borde: #7f1d1d;
      --barra: #14b8a6; --barra2: #fb923c;
      --clic-fondo: #2c1608; --clic-borde: #7c2d12; --clic-texto: #fdba74;
      --chip-bg: #1e293b; --chip-borde: #334155;
      --sombra: 0 1px 3px rgba(0,0,0,0.3);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fondo); color: var(--tinta); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .pagina { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; }

  /* Encabezado */
  header { display: flex; flex-wrap: wrap; gap: 14px 24px; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 1.55rem; font-weight: 800; letter-spacing: -.02em; display: flex; align-items: center; gap: 10px; }
  .sub { color: var(--suave); font-size: .84rem; margin-top: 3px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dot-online { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); display: inline-block; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(.85); } }

  /* Barra de control superior */
  .controles-top { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .grupo-botones { display: inline-flex; background: var(--chip-bg); border: 1px solid var(--linea); border-radius: 10px; padding: 3px; gap: 2px; }
  .grupo-botones button {
    font: inherit; font-size: .84rem; font-weight: 600; padding: 6px 14px; border: 0; background: transparent;
    color: var(--suave); border-radius: 8px; cursor: pointer; transition: all .15s ease;
  }
  .grupo-botones button:hover { color: var(--tinta); }
  .grupo-botones button[aria-pressed="true"] { background: var(--tarjeta); color: var(--acento-osc); box-shadow: var(--sombra); }
  @media (prefers-color-scheme: dark) {
    .grupo-botones button[aria-pressed="true"] { color: var(--acento); }
  }

  .btn-accion {
    font: inherit; font-size: .82rem; font-weight: 600; padding: 7px 12px; border: 1px solid var(--linea);
    background: var(--tarjeta); color: var(--tinta); border-radius: 8px; cursor: pointer; display: inline-flex;
    align-items: center; gap: 6px; box-shadow: var(--sombra);
  }
  .btn-accion:hover { border-color: var(--acento); color: var(--acento); }
  .btn-peligro { border-color: var(--mal-borde); color: var(--mal); background: var(--mal-fondo); }
  .btn-peligro:hover { background: var(--mal); color: #fff; }

  .aviso { padding: 12px 16px; border-radius: 10px; background: var(--aviso-fondo); border: 1px solid var(--aviso-borde); color: var(--aviso); font-size: .9rem; margin-bottom: 16px; font-weight: 500; }

  /* KPIs */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .kpi { background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 12px; padding: 14px 16px; box-shadow: var(--sombra); position: relative; overflow: hidden; }
  .kpi b { display: block; font-size: 1.95rem; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .kpi span { color: var(--suave); font-size: .82rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; margin-top: 4px; display: block; }
  .kpi-icono { position: absolute; right: 14px; top: 14px; font-size: 1.3rem; opacity: .7; }

  /* Paneles */
  .panel { background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; box-shadow: var(--sombra); }
  .panel-header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .panel h2 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
  .panel .nota { color: var(--suave); font-size: .82rem; margin: 0; }

  /* Chequeos de Salud Meta */
  .chequeos { display: grid; gap: 6px; }
  .chequeo { display: grid; grid-template-columns: 80px 1fr auto; gap: 4px 12px; align-items: baseline; padding: 8px 0; border-top: 1px solid var(--linea); }
  .chequeo:first-child { border-top: 0; padding-top: 0; }
  .chequeo .que { font-weight: 600; font-size: .9rem; }
  .chequeo .ayuda { grid-column: 2 / 4; color: var(--suave); font-size: .8rem; }
  .pill { text-align: center; font-size: .72rem; font-weight: 800; padding: 3px 8px; border-radius: 99px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .pill.ok { background: var(--ok-fondo); color: var(--ok); }
  .pill.aviso { background: var(--aviso-fondo); color: var(--aviso); }
  .pill.mal { background: var(--mal-fondo); color: var(--mal); }
  .pill.nada { background: var(--chip-bg); color: var(--suave); }
  .cifra { font-variant-numeric: tabular-nums; color: var(--suave); font-size: .85rem; font-weight: 600; }

  /* Rejilla de tablas */
  .rejilla { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .rejilla .panel { margin-bottom: 0; }
  .tabla-caja { overflow-x: auto; max-height: 380px; }
  table { width: 100%; border-collapse: collapse; font-size: .86rem; }
  th { text-align: left; color: var(--suave); font-weight: 700; font-size: .73rem; text-transform: uppercase; letter-spacing: .04em; padding: 0 8px 8px 0; position: sticky; top: 0; background: var(--tarjeta); z-index: 1; }
  td { padding: 8px 8px 8px 0; border-top: 1px solid var(--linea); vertical-align: middle; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; padding-left: 8px; }
  td.nombre { overflow-wrap: break-word; font-weight: 500; }
  td.id { white-space: nowrap; font-variant-numeric: tabular-nums; font-family: monospace; font-size: .8rem; }
  .vacio { color: var(--suave); font-size: .9rem; padding: 20px 0; text-align: center; font-style: italic; }

  /* Gráfica diaria */
  .dias { display: flex; align-items: flex-end; gap: 8px; height: 130px; padding-top: 10px; }
  .dia { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; gap: 4px; }
  .dia .col { width: 100%; max-width: 44px; display: flex; flex-direction: column; justify-content: flex-end; flex: 1; }
  .dia .v { background: var(--barra); border-radius: 4px 4px 0 0; min-height: 0; transition: height .3s; }
  .dia .c { background: var(--barra2); min-height: 0; transition: height .3s; }
  .dia small { color: var(--suave); font-size: .72rem; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
  .dia em { font-style: normal; font-size: .75rem; font-variant-numeric: tabular-nums; font-weight: 700; }
  .leyenda { display: flex; gap: 16px; font-size: .82rem; color: var(--suave); margin-top: 10px; font-weight: 500; }
  .leyenda i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }

  /* ═══════════════════════════════════════════════════════════════════
     SECCIÓN ÚLTIMAS LLEGADAS: FILTROS Y TARJETAS LEGIBLES
     ═══════════════════════════════════════════════════════════════════ */
  .barra-filtros {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
    background: var(--chip-bg); padding: 10px 12px; border-radius: 10px; margin-bottom: 14px;
  }
  .filtro-busqueda { position: relative; flex: 1; min-width: 240px; }
  .filtro-busqueda input {
    width: 100%; font: inherit; font-size: .86rem; padding: 7px 12px 7px 32px;
    border: 1px solid var(--linea); border-radius: 8px; background: var(--tarjeta); color: var(--tinta);
  }
  .filtro-busqueda input:focus { outline: 2px solid var(--acento); border-color: var(--acento); }
  .filtro-busqueda-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: .88rem; color: var(--suave); pointer-events: none; }

  .filtros-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .filtro-chip {
    font: inherit; font-size: .78rem; font-weight: 600; padding: 5px 11px; border-radius: 99px;
    border: 1px solid var(--linea); background: var(--tarjeta); color: var(--suave); cursor: pointer;
    transition: all .15s ease;
  }
  .filtro-chip:hover { border-color: var(--acento); color: var(--tinta); }
  .filtro-chip[aria-pressed="true"] { background: var(--acento); border-color: var(--acento); color: #fff; }

  /* Separador por día en la lista */
  .separador-dia {
    margin: 18px 0 10px; padding: 8px 14px; border-radius: 8px; font-size: .85rem; font-weight: 700;
    display: flex; align-items: center; justify-content: space-between;
    background: var(--chip-bg); border-left: 4px solid var(--acento);
  }
  .separador-dia.hoy { background: var(--ok-fondo); border-left-color: var(--ok); color: var(--ok); }
  .separador-dia.ayer { background: var(--aviso-fondo); border-left-color: var(--aviso); color: var(--aviso); }
  .separador-dia-contador { font-weight: 500; font-size: .78rem; color: var(--suave); }

  /* Tarjeta de cada evento */
  .evento-card {
    background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 10px; padding: 12px 14px;
    margin-bottom: 8px; transition: border-color .15s ease; position: relative;
  }
  .evento-card:hover { border-color: var(--acento); }
  .evento-card.es-clic { background: var(--clic-fondo); border-color: var(--clic-borde); }

  .evento-top { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .evento-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

  /* Insignias de fecha */
  .badge-dia { font-size: .72rem; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: .04em; }
  .badge-dia.hoy { background: var(--ok); color: #fff; }
  .badge-dia.ayer { background: var(--aviso); color: #fff; }
  .badge-dia.fecha { background: var(--chip-bg); color: var(--suave); border: 1px solid var(--linea); }
  .evento-hora { font-weight: 700; font-size: .88rem; font-variant-numeric: tabular-nums; }
  .evento-rel { color: var(--suave); font-size: .78rem; }

  /* Insignia de tipo de evento */
  .badge-tipo { font-size: .72rem; font-weight: 800; padding: 3px 9px; border-radius: 99px; text-transform: uppercase; letter-spacing: .04em; }
  .badge-tipo.visita { background: var(--acento-fondo); color: var(--acento-osc); }
  .badge-tipo.clic { background: var(--barra2); color: #fff; }

  /* Etiquetas de anuncio y parámetros */
  .evento-cuerpo { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .tags-anuncio { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag {
    font-size: .8rem; padding: 4px 9px; border-radius: 6px; font-weight: 600;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .tag-anuncio { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; font-weight: 700; font-size: .84rem; }
  @media (prefers-color-scheme: dark) {
    .tag-anuncio { background: #082f49; color: #7dd3fc; border-color: #0c4a6e; }
  }
  .tag-id { background: var(--chip-bg); color: var(--suave); font-family: monospace; font-size: .78rem; border: 1px solid var(--linea); }
  .tag-campana { background: var(--chip-bg); color: var(--tinta); border: 1px solid var(--linea); }
  .tag-ubicacion { background: #f3e8ff; color: #6b21a8; border: 1px solid #e9d5ff; }
  @media (prefers-color-scheme: dark) {
    .tag-ubicacion { background: #3b0764; color: #d8b4fe; border-color: #581c87; }
  }
  .tag-directo { background: var(--chip-bg); color: var(--suave); border: 1px solid var(--linea); font-style: italic; }

  .evento-secundario { color: var(--suave); font-size: .78rem; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }

  /* Destino Hotmart en clics */
  .caja-destino {
    margin-top: 6px; padding: 8px 12px; border-radius: 8px; background: rgba(255,255,255,0.7);
    border: 1px solid var(--clic-borde); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between;
  }
  @media (prefers-color-scheme: dark) {
    .caja-destino { background: rgba(0,0,0,0.3); }
  }
  .sck-badge { font-size: .8rem; font-weight: 700; padding: 3px 8px; border-radius: 6px; font-family: monospace; }
  .sck-badge.ok { background: var(--ok-fondo); color: var(--ok); border: 1px solid var(--ok-borde); }
  .sck-badge.falta { background: var(--mal-fondo); color: var(--mal); border: 1px solid var(--mal-borde); }
  .off-badge { font-size: .76rem; font-weight: 600; padding: 3px 7px; border-radius: 6px; background: var(--chip-bg); color: var(--suave); }

  /* Desplegable técnico */
  .detalles-url { margin-top: 6px; font-size: .75rem; color: var(--suave); }
  .detalles-url summary { cursor: pointer; user-select: none; }
  .detalles-url code {
    display: block; margin-top: 4px; padding: 6px 8px; background: var(--fondo);
    border-radius: 6px; word-break: break-all; font-family: monospace; font-size: .72rem; color: var(--suave);
  }

  .btn-borrar-evento {
    background: transparent; border: 0; color: var(--suave); font-size: .9rem; cursor: pointer; padding: 4px; border-radius: 4px;
    opacity: .6; transition: opacity .15s;
  }
  .btn-borrar-evento:hover { opacity: 1; color: var(--mal); }
</style>
</head>
<body>
<div class="pagina">
  <header>
    <div>
      <h1><span>📊</span> Origen de visitas · Plan 21</h1>
      <div class="sub" id="sub">
        <span class="dot-online"></span>
        <span id="subTexto">Cargando datos...</span>
      </div>
    </div>
    <div class="controles-top">
      <!-- Selector de Período -->
      <div class="grupo-botones" id="periodos" role="group" aria-label="Período">
        <button type="button" data-periodo="hoy" aria-pressed="true">Hoy</button>
        <button type="button" data-periodo="ayer" aria-pressed="false">Ayer</button>
        <button type="button" data-periodo="7dias" aria-pressed="false">7 días</button>
        <button type="button" data-periodo="30dias" aria-pressed="false">30 días</button>
      </div>

      <!-- Selector de Zona Horaria -->
      <div class="grupo-botones" id="zonas" role="group" aria-label="Zona Horaria">
        <button type="button" data-zona="America/Asuncion" aria-pressed="true" title="Hora de Paraguay (UTC-3)">🇵🇾 Asunción</button>
        <button type="button" data-zona="Europe/Madrid" aria-pressed="false" title="Hora de España (UTC+2)">🇪🇸 España</button>
      </div>

      <!-- Actualizar manual y Limpiar pruebas -->
      <button type="button" class="btn-accion" id="btnActualizar" title="Actualizar datos">
        <span>🔄</span> <span id="txtActualizar">Refrescar</span>
      </button>
      <button type="button" class="btn-accion btn-peligro" id="btnLimpiarPruebas" title="Limpiar visitas de prueba">
        <span>🧹</span> Limpiar pruebas
      </button>
    </div>
  </header>

  <div id="aviso"></div>

  <!-- KPIs -->
  <div class="kpis" id="kpis"></div>

  <!-- Diagnóstico de Anuncios y Hotmart -->
  <section class="panel">
    <div class="panel-header">
      <h2><span>🎯</span> Diagnóstico de seguimiento Meta y Hotmart</h2>
      <span class="nota">Verifica si tus anuncios están enviando los parámetros necesarios para medir y vender</span>
    </div>
    <div class="chequeos" id="chequeos"></div>
  </section>

  <!-- Gráfico de tendencia -->
  <section class="panel" id="panelGrafico">
    <div class="panel-header">
      <h2><span>📈</span> Visitas y Clics por día</h2>
      <div class="leyenda">
        <span><i style="background:var(--barra)"></i>Visitas a la página</span>
        <span><i style="background:var(--barra2)"></i>Clics en comprar</span>
      </div>
    </div>
    <div class="dias" id="dias"></div>
  </section>

  <!-- Rejilla de Tablas -->
  <div class="rejilla" id="tablas"></div>

  <!-- Parámetros de URL recomendados -->
  <section class="panel">
    <div class="panel-header">
      <h2><span>⚙️</span> Parámetros de URL para tus anuncios en Meta</h2>
      <span class="nota">Pega esta línea en tu anuncio, en Seguimiento → Parámetros de URL. Meta reemplaza los {{...}} en cada clic.</span>
    </div>
    <code id="paramsAnuncio" style="display:block;padding:12px 14px;background:var(--fondo);border:1px solid var(--linea);border-radius:8px;font-size:.82rem;font-family:monospace;word-break:break-all;user-select:all">utm_source=facebook&amp;utm_medium=paid&amp;utm_campaign={{campaign.name}}&amp;utm_content={{ad.name}}&amp;utm_term={{adset.name}}&amp;campaign_id={{campaign.id}}&amp;adset_id={{adset.id}}&amp;ad_id={{ad.id}}&amp;placement={{placement}}&amp;site={{site_source_name}}</code>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════════
       ÚLTIMAS LLEGADAS (INTERACTIVO, FILTRABLE Y AGRUPADO POR FECHA)
       ═══════════════════════════════════════════════════════════════════ -->
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2><span>👥</span> Últimas visitas recibidas</h2>
        <p class="nota">Muestra cada persona que entró a la landing, qué anuncio vio y si tocó comprar.</p>
      </div>
      <div id="contadorFiltrados" style="font-size:.84rem;font-weight:700;color:var(--suave)"></div>
    </div>

    <!-- Barra de Filtros Interactivos -->
    <div class="barra-filtros">
      <div class="filtro-busqueda">
        <span class="filtro-busqueda-ico">🔍</span>
        <input type="search" id="filtroTexto" placeholder="Filtrar por anuncio, campaña, placement, ID o referrer..." autocomplete="off">
      </div>

      <div class="filtros-chips">
        <!-- Filtro Tipo -->
        <button type="button" class="filtro-chip" data-f-tipo="todos" aria-pressed="true">Todos (<span id="contTodos">0</span>)</button>
        <button type="button" class="filtro-chip" data-f-tipo="visita" aria-pressed="false">🟢 Visitas (<span id="contVisitas">0</span>)</button>
        <button type="button" class="filtro-chip" data-f-tipo="clic_comprar" aria-pressed="false">🟠 Clics Comprar (<span id="contClics">0</span>)</button>

        <!-- Filtro Origen -->
        <button type="button" class="filtro-chip" data-f-origen="todos" aria-pressed="true">Todo origen</button>
        <button type="button" class="filtro-chip" data-f-origen="anuncio" aria-pressed="false">🎯 Con Anuncio</button>
        <button type="button" class="filtro-chip" data-f-origen="directo" aria-pressed="false">🌐 Directo / Sin UTM</button>

        <!-- Filtro Dispositivo -->
        <button type="button" class="filtro-chip" data-f-disp="todos" aria-pressed="true">Todos disp.</button>
        <button type="button" class="filtro-chip" data-f-disp="m" aria-pressed="false">📱 Móvil</button>
        <button type="button" class="filtro-chip" data-f-disp="d" aria-pressed="false">💻 PC</button>
      </div>
    </div>

    <!-- Contenedor de Llegadas -->
    <div id="recientes"></div>
  </section>
</div>

<script>
(function () {
  var q = new URLSearchParams(location.search);
  var clave = q.get("clave") || "";
  var periodo = q.get("periodo") || "hoy"; // 'hoy', 'ayer', '7dias', '30dias'
  if (["hoy", "ayer", "7dias", "30dias"].indexOf(periodo) < 0) {
    var diasQ = parseInt(q.get("dias") || "0", 10);
    if (diasQ === 1) periodo = "hoy";
    else if (diasQ === 30) periodo = "30dias";
    else if (diasQ === 7) periodo = "7dias";
    else periodo = "hoy";
  }

  var zona = q.get("zona") || "America/Asuncion";
  if (["America/Asuncion", "Europe/Madrid"].indexOf(zona) < 0) zona = "America/Asuncion";

  // Filtros interactivos del cliente para recientes
  var filtroTexto = "";
  var filtroTipo = "todos";
  var filtroOrigen = "todos";
  var filtroDisp = "todos";

  var datosActuales = null;
  var segsRestantes = 30;
  var timerInterval = null;

  function el(tag, clase, texto) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined && texto !== null) n.textContent = texto;
    return n;
  }
  function limpiar(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function pctTxt(p) { return p === null || p === undefined ? "—" : p.toLocaleString("es-PY") + " %"; }

  function formatoHora(ts, conFecha) {
    try {
      var opt = { timeZone: zona, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" };
      if (conFecha) { opt.day = "2-digit"; opt.month = "2-digit"; }
      return new Date(ts).toLocaleString("es-PY", opt);
    } catch (e) { return ts; }
  }

  function formatoTiempoRelativo(ts) {
    try {
      var diffMs = Date.now() - new Date(ts).getTime();
      if (diffMs < 0) diffMs = 0;
      var segs = Math.floor(diffMs / 1000);
      if (segs < 60) return "hace " + segs + "s";
      var mins = Math.floor(segs / 60);
      if (mins < 60) return "hace " + mins + "m";
      var horas = Math.floor(mins / 60);
      if (horas < 24) return "hace " + horas + "h";
      var dias = Math.floor(horas / 24);
      return "hace " + dias + "d";
    } catch (e) { return ""; }
  }

  function leg(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch (e) { return String(s); }
  }

  function kpi(valor, etiqueta, icono) {
    var k = el("div", "kpi");
    if (icono) k.appendChild(el("span", "kpi-icono", icono));
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

  function tabla(titulo, filas, colNombre, icono) {
    var p = el("section", "panel");
    var ph = el("div", "panel-header");
    ph.appendChild(el("h2", "", (icono ? icono + " " : "") + titulo));
    p.appendChild(ph);
    if (!filas.length) { p.appendChild(el("div", "vacio", "Todavía no hay datos registrados en este período.")); return p; }
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

  // Eliminar un evento puntual
  function borrarEvento(e, cardEl) {
    if (!confirm("¿Eliminar este evento puntual del registro?")) return;
    var url = e.id ? e.id : "?ts=" + encodeURIComponent(e.ts);
    if (clave) url += (url.indexOf("?") >= 0 ? "&" : "?") + "clave=" + encodeURIComponent(clave);
    fetch(url, { method: "DELETE", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("Error " + r.status); return r.json(); })
      .then(function () {
        if (cardEl && cardEl.parentNode) cardEl.parentNode.removeChild(cardEl);
        cargar();
      })
      .catch(function (err) { alert("No se pudo eliminar: " + err.message); });
  }

  // Renderizar la lista de eventos recientes con filtros aplicados
  function pintarRecientes() {
    var r = document.getElementById("recientes");
    limpiar(r);
    if (!datosActuales || !datosActuales.recientes || !datosActuales.recientes.length) {
      r.appendChild(el("div", "vacio", "Todavía no ha llegado ninguna visita en este período."));
      document.getElementById("contadorFiltrados").textContent = "0 visitas";
      return;
    }

    var lista = datosActuales.recientes;

    // Actualizar contadores en los botones de filtro
    var totV = 0, totC = 0;
    lista.forEach(function (item) { if (item.tipo === "visita") totV++; else totC++; });
    document.getElementById("contTodos").textContent = String(lista.length);
    document.getElementById("contVisitas").textContent = String(totV);
    document.getElementById("contClics").textContent = String(totC);

    // Aplicar filtros
    var qTxt = filtroTexto.toLowerCase().trim();
    var filtrados = lista.filter(function (e) {
      // Filtro Tipo
      if (filtroTipo !== "todos" && e.tipo !== filtroTipo) return false;
      // Filtro Dispositivo
      if (filtroDisp !== "todos" && e.disp !== filtroDisp) return false;
      // Filtro Origen
      var tieneAnuncio = Boolean(e.utm_source || e.utm_content || e.ad_id || e.utm_campaign);
      if (filtroOrigen === "anuncio" && !tieneAnuncio) return false;
      if (filtroOrigen === "directo" && tieneAnuncio) return false;
      // Filtro Buscador Texto
      if (qTxt) {
        var contenido = [
          e.utm_content, e.ad_id, e.utm_campaign, e.utm_term, e.placement,
          e.site, e.ref, e.url, e.destino, e.destino_sck
        ].filter(Boolean).join(" ").toLowerCase();
        if (contenido.indexOf(qTxt) < 0) return false;
      }
      return true;
    });

    document.getElementById("contadorFiltrados").textContent = filtrados.length + " de " + lista.length + " mostrados";

    if (!filtrados.length) {
      r.appendChild(el("div", "vacio", "No hay eventos que coincidan con los filtros aplicados."));
      return;
    }

    // Agrupar por día
    var gruposPorDia = [];
    var mapaDias = new Map();
    filtrados.forEach(function (ev) {
      var d = ev.dia_str || "fecha";
      if (!mapaDias.has(d)) {
        var obj = { dia: d, es_hoy: ev.es_hoy, es_ayer: ev.es_ayer, items: [] };
        mapaDias.set(d, obj);
        gruposPorDia.push(obj);
      }
      mapaDias.get(d).items.push(ev);
    });

    gruposPorDia.forEach(function (grupo) {
      // Título de la fecha
      var sep = el("div", "separador-dia");
      var tituloDia = "";
      if (grupo.es_hoy) {
        sep.className += " hoy";
        tituloDia = "🟢 HOY · " + grupo.dia;
      } else if (grupo.es_ayer) {
        sep.className += " ayer";
        tituloDia = "🟡 AYER · " + grupo.dia;
      } else {
        tituloDia = "📅 " + grupo.dia;
      }
      sep.appendChild(el("span", "", tituloDia));
      sep.appendChild(el("span", "separador-dia-contador", grupo.items.length + " evento" + (grupo.items.length === 1 ? "" : "s")));
      r.appendChild(sep);

      grupo.items.forEach(function (e) {
        var card = el("div", "evento-card" + (e.tipo === "clic_comprar" ? " es-clic" : ""));

        // Fila Superior: Fecha / Hora / Tipo / Borrar
        var top = el("div", "evento-top");
        var meta = el("div", "evento-meta");

        // Insignia de fecha
        if (e.es_hoy) {
          meta.appendChild(el("span", "badge-dia hoy", "HOY"));
        } else if (e.es_ayer) {
          meta.appendChild(el("span", "badge-dia ayer", "AYER"));
        } else {
          meta.appendChild(el("span", "badge-dia fecha", e.dia_str || ""));
        }

        meta.appendChild(el("span", "evento-hora", formatoHora(e.ts, false)));
        meta.appendChild(el("span", "evento-rel", "(" + formatoTiempoRelativo(e.ts) + ")"));

        // Insignia de tipo
        if (e.tipo === "visita") {
          meta.appendChild(el("span", "badge-tipo visita", "Visita"));
        } else {
          meta.appendChild(el("span", "badge-tipo clic", "🛒 Clic en Comprar"));
        }

        top.appendChild(meta);

        // Botón borrar prueba puntual
        var btnBorrar = el("button", "btn-borrar-evento", "🗑️");
        btnBorrar.title = "Eliminar visita de prueba";
        btnBorrar.addEventListener("click", function () { borrarEvento(e, card); });
        top.appendChild(btnBorrar);
        card.appendChild(top);

        // Cuerpo: Anuncio y Etiquetas Legibles
        var cuerpo = el("div", "evento-cuerpo");
        var tags = el("div", "tags-anuncio");

        var tieneAnuncio = Boolean(e.utm_content || e.ad_id || e.utm_campaign);
        if (tieneAnuncio) {
          if (e.utm_content) {
            tags.appendChild(el("span", "tag tag-anuncio", "🏷️ " + leg(e.utm_content)));
          }
          if (e.ad_id) {
            tags.appendChild(el("span", "tag tag-id", "ID: " + e.ad_id));
          }
          if (e.utm_campaign) {
            tags.appendChild(el("span", "tag tag-campana", "📢 " + leg(e.utm_campaign)));
          }
          if (e.placement) {
            tags.appendChild(el("span", "tag tag-ubicacion", "📍 " + leg(e.placement)));
          }
        } else {
          tags.appendChild(el("span", "tag tag-directo", "🌐 Visita directa / Sin anuncio"));
        }
        cuerpo.appendChild(tags);

        // Datos secundarios (dispositivo, de dónde viene)
        var sec = el("div", "evento-secundario");
        var dispTexto = e.disp === "m" ? "📱 Celular" : (e.disp === "d" ? "💻 Computadora" : "");
        if (dispTexto) sec.appendChild(el("span", "", dispTexto));
        if (e.ref) sec.appendChild(el("span", "", "viene de " + e.ref));
        if (e.site) sec.appendChild(el("span", "", "sitio: " + e.site));
        if (sec.children.length) cuerpo.appendChild(sec);

        // Si fue Clic en Comprar: Destino y SCK
        if (e.tipo === "clic_comprar") {
          var destBox = el("div", "caja-destino");
          var sckPart = el("div", "");
          if (e.destino_sck) {
            var sckBadge = el("span", "sck-badge ok", "✓ sck: " + e.destino_sck);
            sckBadge.title = "Hotmart asociará esta compra a este anuncio";
            sckPart.appendChild(sckBadge);
          } else {
            var sckFalta = el("span", "sck-badge falta", "⚠️ Sin sck de anuncio");
            sckPart.appendChild(sckFalta);
          }
          destBox.appendChild(sckPart);

          if (e.destino_off) {
            destBox.appendChild(el("span", "off-badge", "Oferta: " + e.destino_off));
          }
          cuerpo.appendChild(destBox);
        }

        // Desplegable con URL técnica completa
        var det = el("details", "detalles-url");
        det.appendChild(el("summary", "", "Ver URL técnica completa"));
        det.appendChild(el("code", "", leg(e.url) || "(vacía)"));
        if (e.destino) {
          det.appendChild(el("code", "", "Destino: " + leg(e.destino)));
        }
        cuerpo.appendChild(det);

        card.appendChild(cuerpo);
        r.appendChild(card);
      });
    });
  }

  function pintar(d) {
    datosActuales = d;

    var zonaLabel = zona === "Europe/Madrid" ? "España (UTC+2)" : "Paraguay (UTC-3)";
    document.getElementById("subTexto").textContent =
      "Actualizado " + formatoHora(new Date().toISOString(), false) + " (" + zonaLabel + ") · Base de datos: " +
      (d.almacenamiento === "postgres" ? "PostgreSQL" : "Memoria temporal");

    var av = document.getElementById("aviso"); limpiar(av);
    if (d.almacenamiento !== "postgres") {
      av.appendChild(el("div", "aviso", "⚠️ La base de datos no responde: las visitas se están guardando en memoria y se perderán si el servidor se reinicia."));
    }

    // KPIs
    var perLabel = periodo === "hoy" ? " (Hoy)" : (periodo === "ayer" ? " (Ayer)" : "");
    var k = document.getElementById("kpis"); limpiar(k);
    k.appendChild(kpi(String(d.totales.visitas), "Visitas" + perLabel, "👀"));
    k.appendChild(kpi(String(d.totales.clics), "Clics comprar" + perLabel, "🛒"));
    k.appendChild(kpi(pctTxt(d.totales.tasaClic), "Clic / Visita", "🎯"));
    k.appendChild(kpi(pctTxt(d.diagnostico.conFbclid.pct), "Llegan de Meta", "📱"));
    k.appendChild(kpi(pctTxt(d.diagnostico.conUtm.pct), "Con Anuncio (UTM)", "🏷️"));

    // Chequeos de Salud Meta
    var c = document.getElementById("chequeos"); limpiar(c);
    c.appendChild(chequeo("Llega utm_source", d.diagnostico.conUtm, "Indica si los clics provienen de un anuncio con parámetros.", 90));
    c.appendChild(chequeo("Llega utm_content (anuncio)", d.diagnostico.conAnuncio, "Permite saber con qué anuncio exacto entró cada persona.", 90));
    c.appendChild(chequeo("Llega ad_id (ID de Meta)", d.diagnostico.conAdId, "ID numérico único del anuncio que viaja a Hotmart dentro del sck.", 90));
    c.appendChild(chequeo("Llega adset_id (conjunto)", d.diagnostico.conAdset, "Se activa con adset_id={{adset.id}} en Parámetros de URL.", 90));
    c.appendChild(chequeo("Llega campaign_id (campaña)", d.diagnostico.conCampaignId, "Se activa con campaign_id={{campaign.id}} en Parámetros de URL.", 90));
    c.appendChild(chequeo("Llega placement (ubicación)", d.diagnostico.conPlacement, "Indica si se vio en Feed, Reels, Stories, etc.", 90));
    c.appendChild(chequeo("El enlace a Hotmart lleva sck", d.diagnostico.clicsConSck, "Mide los clics en comprar: sck es lo que Hotmart registra para adjudicarte la venta al anuncio.", 90));

    // Gráfico de Barras Diarias
    var panelGraf = document.getElementById("panelGrafico");
    if (periodo === "hoy" || periodo === "ayer") {
      panelGraf.style.display = "none";
    } else {
      panelGraf.style.display = "block";
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
    }

    // Tablas de desglose
    var tb = document.getElementById("tablas"); limpiar(tb);
    tb.appendChild(tabla("Por anuncio (utm_content)", d.porAnuncio, "Anuncio", "🏷️"));
    if (d.porAdId && d.porAdId.length) tb.appendChild(tabla("Por ID de anuncio (ad_id)", d.porAdId, "ID Anuncio", "🔢"));
    tb.appendChild(tabla("Por campaña", d.porCampana, "Campaña", "📢"));
    tb.appendChild(tabla("Por conjunto de anuncios (adset)", d.porAdset, "Conjunto", "🎯"));
    tb.appendChild(tabla("Por ubicación (placement)", d.porUbicacion, "Ubicación", "📍"));
    tb.appendChild(tabla("Por fuente / medio", d.porFuente, "Fuente", "🌐"));
    tb.appendChild(tabla("De dónde viene el clic (referrer)", d.porReferrer, "Referrer", "🔗"));
    tb.appendChild(tabla("Dispositivo", d.porDispositivo, "Dispositivo", "📱"));

    // Renderizar llegadas
    pintarRecientes();
  }

  function cargar() {
    segsRestantes = 30;
    var txtAct = document.getElementById("txtActualizar");
    if (txtAct) txtAct.textContent = "Actualizando...";

    var url = "resumen?periodo=" + encodeURIComponent(periodo) + "&zona=" + encodeURIComponent(zona) + (clave ? "&clave=" + encodeURIComponent(clave) : "");
    fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Falta la clave del dash en la dirección (?clave=...)." : "Error " + r.status);
        return r.json();
      })
      .then(function (d) {
        pintar(d);
        if (txtAct) txtAct.textContent = "Refrescar (30s)";
      })
      .catch(function (e) {
        document.getElementById("subTexto").textContent = e.message;
        if (txtAct) txtAct.textContent = "Reintentar";
      });
  }

  // Manejo de botones de período (Hoy, Ayer, 7 días, 30 días)
  var btnPeriodos = document.querySelectorAll("#periodos button");
  [].forEach.call(btnPeriodos, function (b) {
    b.setAttribute("aria-pressed", String(b.getAttribute("data-periodo") === periodo));
    b.addEventListener("click", function () {
      periodo = b.getAttribute("data-periodo");
      [].forEach.call(btnPeriodos, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      // Actualizar URL sin recargar
      q.set("periodo", periodo);
      history.replaceState(null, "", "?" + q.toString());
      cargar();
    });
  });

  // Manejo de botones de zona horaria (Asunción vs Madrid)
  var btnZonas = document.querySelectorAll("#zonas button");
  [].forEach.call(btnZonas, function (b) {
    b.setAttribute("aria-pressed", String(b.getAttribute("data-zona") === zona));
    b.addEventListener("click", function () {
      zona = b.getAttribute("data-zona");
      [].forEach.call(btnZonas, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      q.set("zona", zona);
      history.replaceState(null, "", "?" + q.toString());
      cargar();
    });
  });

  // Botón Actualizar
  document.getElementById("btnActualizar").addEventListener("click", cargar);

  // Botón Limpiar pruebas
  document.getElementById("btnLimpiarPruebas").addEventListener("click", function () {
    var opcion = prompt("Escribe 'sin_utm' para borrar solo visitas sin anuncio, o 'todas' para borrar todo el historial:");
    if (!opcion || (opcion !== "sin_utm" && opcion !== "todas")) return;
    var url = "limpiar?tipo=" + encodeURIComponent(opcion) + (clave ? "&clave=" + encodeURIComponent(clave) : "");
    fetch(url, { method: "DELETE", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("Error " + r.status); return r.json(); })
      .then(function () {
        alert("Pruebas limpiadas correctamente.");
        cargar();
      })
      .catch(function (err) { alert("Error al limpiar: " + err.message); });
  });

  // Filtros de Llegadas: Buscador en tiempo real
  var inputBuscador = document.getElementById("filtroTexto");
  inputBuscador.addEventListener("input", function () {
    filtroTexto = inputBuscador.value;
    pintarRecientes();
  });

  // Filtros de Llegadas: Tipo (Todos, Visitas, Clics)
  var chipsTipo = document.querySelectorAll("[data-f-tipo]");
  [].forEach.call(chipsTipo, function (b) {
    b.addEventListener("click", function () {
      filtroTipo = b.getAttribute("data-f-tipo");
      [].forEach.call(chipsTipo, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      pintarRecientes();
    });
  });

  // Filtros de Llegadas: Origen (Todos, Con Anuncio, Directo)
  var chipsOrigen = document.querySelectorAll("[data-f-origen]");
  [].forEach.call(chipsOrigen, function (b) {
    b.addEventListener("click", function () {
      filtroOrigen = b.getAttribute("data-f-origen");
      [].forEach.call(chipsOrigen, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      pintarRecientes();
    });
  });

  // Filtros de Llegadas: Dispositivo (Todos, Celular, PC)
  var chipsDisp = document.querySelectorAll("[data-f-disp]");
  [].forEach.call(chipsDisp, function (b) {
    b.addEventListener("click", function () {
      filtroDisp = b.getAttribute("data-f-disp");
      [].forEach.call(chipsDisp, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      pintarRecientes();
    });
  });

  // Temporizador de actualización cada 30 segundos
  timerInterval = setInterval(function () {
    segsRestantes--;
    var txtAct = document.getElementById("txtActualizar");
    if (txtAct && segsRestantes > 0) txtAct.textContent = "Refrescar (" + segsRestantes + "s)";
    if (segsRestantes <= 0) {
      cargar();
    }
  }, 1000);

  cargar();
})();
</script>
</body>
</html>`;

export default DASH_HTML;
