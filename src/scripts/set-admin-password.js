import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import readline from 'readline';
import { Writable } from 'stream';
import { query, pool } from '../database/pool.js';

/**
 * Cambia la contraseña de un usuario administrador de forma segura.
 *
 *   npm run set-admin-password                           -> pide la contraseña sin mostrarla
 *   npm run set-admin-password -- --generar              -> genera una aleatoria y la muestra
 *   npm run set-admin-password -- --email otro@mail.com  -> elige a qué usuario
 *
 * La contraseña nunca se pasa como argumento de la línea de comandos:
 * quedaría guardada en el historial de la terminal.
 */

const MIN_LENGTH = 12;

const args = process.argv.slice(2);
const emailFlag = args.indexOf('--email');
const email = (emailFlag !== -1 ? (args[emailFlag + 1] || '') : (process.env.ADMIN_EMAIL || 'admin@empresa.com'))
  .toLowerCase()
  .trim();
const generar = args.includes('--generar');

/** Lee una línea de la consola sin mostrar lo que se escribe. */
function preguntarOculto(pregunta) {
  return new Promise((resolve) => {
    let silenciar = false;

    const salidaMuda = new Writable({
      write(chunk, encoding, callback) {
        if (!silenciar) process.stdout.write(chunk, encoding);
        callback();
      }
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: salidaMuda,
      terminal: true
    });

    rl.question(pregunta, (respuesta) => {
      silenciar = false;
      rl.close();
      process.stdout.write('\n');
      resolve(respuesta);
    });

    silenciar = true;
  });
}

async function main() {
  const { rows } = await query('SELECT id, email, name, role FROM users WHERE email = $1', [email]);
  const usuario = rows[0];

  if (!usuario) {
    console.error(`\n❌ No existe ningún usuario con el correo ${email}.`);
    console.error('   Indicá otro con:  npm run set-admin-password -- --email tu@correo.com\n');
    process.exit(1);
  }

  let nuevaPassword;

  if (generar) {
    nuevaPassword = crypto.randomBytes(12).toString('base64url');
  } else {
    nuevaPassword = (await preguntarOculto(`Nueva contraseña para ${usuario.email}: `)).trim();
    const repetida = (await preguntarOculto('Repetila para confirmar:            ')).trim();

    if (nuevaPassword !== repetida) {
      console.error('\n❌ Las contraseñas no coinciden. No se cambió nada.\n');
      process.exit(1);
    }
    if (nuevaPassword.length < MIN_LENGTH) {
      console.error(`\n❌ La contraseña debe tener al menos ${MIN_LENGTH} caracteres. No se cambió nada.\n`);
      process.exit(1);
    }
  }

  const hash = await bcrypt.hash(nuevaPassword, 12);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, usuario.id]);

  console.log(`\n✅ Contraseña actualizada para ${usuario.email} (${usuario.role}).`);
  if (generar) {
    console.log(`   Contraseña generada: ${nuevaPassword}`);
    console.log('   Anotala ahora: no se vuelve a mostrar.');
  }
  console.log('   Las sesiones ya abiertas siguen siendo válidas hasta que venzan.\n');
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ Error al cambiar la contraseña:', err.message);
    if (err.code === 'ECONNREFUSED') {
      console.error('   ¿Está levantada la base de datos?  docker compose up -d\n');
    }
    await pool.end().catch(() => {});
    process.exit(1);
  });
