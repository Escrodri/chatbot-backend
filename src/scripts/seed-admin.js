import bcrypt from 'bcryptjs';
import { query } from '../database/pool.js';

async function seed() {
  const hash = await bcrypt.hash('admin123', 10);
  await query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, 'admin@empresa.com']);
  console.log('✅ Admin password updated to bcrypt(admin123)');
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
