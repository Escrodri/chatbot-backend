import { query } from '../database/index.js';

async function update() {
  await query(
    'UPDATE bot_settings SET welcome_message = $1',
    ['¡Hola {{cliente}}! Bienvenido a Lecturas de Tarde. Un asesor te responderá a la brevedad.']
  );
  console.log('✅ bot_settings updated to Lecturas de Tarde');

  // Also update channel names if any contain Tarot
  await query("UPDATE channels SET name = REPLACE(name, 'Tarot', 'Lecturas de Tarde') WHERE name LIKE '%Tarot%'");
  console.log('✅ channels updated');
  process.exit(0);
}

update().catch(err => {
  console.error(err);
  process.exit(1);
});
