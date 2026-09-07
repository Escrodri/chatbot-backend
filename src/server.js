import http from 'http';
import { app } from './app.js';
import { config } from './config/index.js';
import { socketManager } from './sockets/index.js';

const server = http.createServer(app);

// Inicializar Socket.io sobre el servidor HTTP
socketManager.init(server);

// Iniciar escucha del servidor HTTP
server.listen(config.port, () => {
  console.log(`🚀 [SERVER] Servidor omnicanal iniciado con éxito en http://localhost:${config.port}`);
  console.log(`📡 [HEALTH] Comprobación de estado disponible en http://localhost:${config.port}/health`);
  console.log(`🔒 [SECURITY] Validación HMAC-SHA256 y cifrado AES-256-GCM activos`);
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
