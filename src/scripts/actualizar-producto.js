import { pool } from '../database/pool.js';

const nuevoResumen = `📦 Mirá todo lo que incluye el recetario Mesa Llena:

✅ 65 recetas completas (desayuno, almuerzo, cena y merienda) — sin harina ni azúcar.
✅ Tu lista de compras semanal lista para usar.
✅ Tabla de sustitutos prácticos para el día a día.
✅ 5 infusiones naturales para la hinchazón de la tarde.

📲 Formato digital PDF para guardar en tu celular para siempre.
💰 Precio: Gs. 25.000 (pago por Ueno o Tigo Money).`;

const deliveryNote = `Recomendación: Descargá los PDFs en tu celular y empezá probando la Receta #7 para la cena de hoy.`;

const mensajesMesaLlena = {
  presentacion: [
    '¡Holaa! 💛\n\nEs *Mesa Llena*, un recetario digital. No es una dieta, no tiene días ni horarios estrictos.',
    '📦 *Vas a recibir:*\n✅ 65 recetas (desayuno, almuerzo, cena y merienda) — sin harina ni azúcar\n✅ Tu lista de compras semanal\n✅ Tabla de sustitutos prácticos\n✅ 5 infusiones para la hinchazón\n\nTodo en PDFs listos para guardar en tu celular 📲',
    'Gs. 25.000 (pago único por Ueno o Tigo Money).\n\nElegí una opción para continuar 👇'
  ],
  boton_comprar: 'Lo quiero',
  boton_muestras: 'Ver receta gratis',
  muestras_intro: 'Te paso 1 receta gratis para que veas lo fácil y rico que es cocinar así: 👇',
  muestras_cierre: 'Hacela cuando quieras. Si te gusta y querés las 65 recetas completas, tocalo abajo 👇',
  entrega: '¡Pago confirmado! ✅\n\nAcá tenés todo tu material completo:\n{{links}}\n\nGuardalo en tu celular, lo tenés para siempre 💛\n\n💡 *Tip:* Empezá por la cena de hoy: Receta #7 (pollo con zapallito al horno, 20 min). Mañana me contás cómo te fue 🙌'
};

async function main() {
  const client = await pool.connect();
  try {
    const { rows: existingProducts } = await client.query(
      `SELECT id, name, price, resumen FROM products 
       WHERE slug = 'mesa-llena-recetario-digital' 
          OR name ILIKE '%Mesa Llena%' 
       LIMIT 1`
    );

    let targetProductId = existingProducts[0]?.id;

    if (targetProductId) {
      await client.query(
        `UPDATE products
         SET resumen = $1,
             price = 25000,
             currency = 'PYG',
             precio_recuperacion = 25000,
             delivery_note = COALESCE(delivery_note, $2),
             mensajes = $3::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [nuevoResumen, deliveryNote, JSON.stringify(mensajesMesaLlena), targetProductId]
      );
      console.log(`✅ Producto #${targetProductId} (Mesa Llena) actualizado correctamente con sus mensajes y precio.`);
    } else {
      const { rows: teams } = await client.query('SELECT id FROM teams ORDER BY id ASC LIMIT 1');
      const teamId = teams[0]?.id || null;

      const { rows: nuevo } = await client.query(
        `INSERT INTO products (team_id, slug, name, description, resumen, price, currency, precio_recuperacion, delivery_note, mensajes, is_active, sort_order)
         VALUES ($1, 'mesa-llena-recetario-digital', 'Mesa Llena — Recetario Digital', $2, $3, 25000, 'PYG', 25000, $4, $5::jsonb, TRUE, 1)
         RETURNING id`,
        [
          teamId,
          'Recetario digital con 65 recetas sin harina ni azúcar, lista de compras semanal, tabla de sustitutos prácticos y 5 infusiones para la hinchazón.',
          nuevoResumen,
          deliveryNote,
          JSON.stringify(mensajesMesaLlena)
        ]
      );
      console.log(`🌱 Producto Mesa Llena creado con éxito (#${nuevo[0].id}).`);
    }
  } catch (err) {
    console.error('❌ Error al actualizar producto:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
