import http from 'http';
import { app } from './app.js';
import { config } from './config/index.js';
import { socketManager } from './sockets/index.js';
import { initDatabase } from './database/index.js';
import { logRepository } from './repositories/log.repository.js';
import { recoveryService } from './services/recovery.service.js';

const server = http.createServer(app);

/**
 * Limpieza de los registros de webhook, al arrancar y una vez por día.
 *
 * Es la única tabla que crece sola y sin techo: guarda el JSON crudo de cada
 * evento de Meta, incluidos los tres acuses de cada mensaje que sale. Nadie la
 * borraba. Se conservan los días que diga WEBHOOK_LOGS_DIAS, siete por
 * defecto, que es de sobra para investigar una falla —eso se mira en las horas
 * siguientes, no meses después—.
 *
 * Si falla no pasa nada: se vuelve a intentar mañana y el servidor no se entera.
 */
async function limpiarRegistros() {
  try {
    const dias = parseInt(process.env.WEBHOOK_LOGS_DIAS || '7', 10);
    const borrados = await logRepository.purgarViejos(dias);
    if (borrados > 0) {
      console.log(`🧹 [LIMPIEZA] ${borrados} registro(s) de webhook de más de ${dias} días eliminados.`);
    }
  } catch (err) {
    console.warn('⚠️ [LIMPIEZA] No se pudieron purgar los registros de webhook:', err.message);
  }
}

// Inicializar Socket.io sobre el servidor HTTP
socketManager.init(server);

// Inicializar esquema de base de datos y administrador
try {
  await initDatabase();
} catch (err) {
  console.error('❌ Error crítico al inicializar la base de datos:', err.message);
}

// Iniciar escucha del servidor HTTP
server.listen(config.port, () => {
  console.log(`🚀 [SERVER] Servidor omnicanal iniciado con éxito en http://localhost:${config.port}`);
  console.log(`📡 [HEALTH] Comprobación de estado disponible en http://localhost:${config.port}/health`);
  console.log(`🔒 [SECURITY] Validación HMAC-SHA256 y cifrado AES-256-GCM activos`);

  limpiarRegistros();
  const limpieza = setInterval(limpiarRegistros, 24 * 60 * 60 * 1000);
  // Que el temporizador no sea razón para que el proceso no pueda terminar.
  if (typeof limpieza.unref === 'function') limpieza.unref();

  // Recuperación de abandonos. Si falla al arrancar, el servidor sigue
  // atendiendo: dejar de insistirle a los que se fueron es perder ventas, no
  // dejar de vender.
  try {
    recoveryService.iniciar();
  } catch (err) {
    console.warn('⚠️ [RECUPERACION] No se pudo iniciar el ciclo:', err.message);
  }
});

// Manejo de apagado elegante (Graceful Shutdown)
function handleShutdown(signal) {
  console.log(`\n🛑 [SERVER] Señal ${signal} recibida. Cerrando conexiones HTTP...`);
  server.close(() => {
    console.log('👋 [SERVER] Servidor cerrado ordenadamente.');
    process.exit(0);
  });

  // Forzar cierre si no responde en 5 segundos
  setTimeout(() => {
    console.error('⚠️ [SERVER] Cierre forzado por tiempo límite.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export default server;
