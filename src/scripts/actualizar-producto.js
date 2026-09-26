import { pool } from '../database/pool.js';

const nuevoResumen = `📦 Mirá todo lo que incluye el material:

1️⃣ 10 Grandes Historias Bíblicas completas: Desde La Creación del Mundo y El Arca de Noé hasta El Nacimiento de Jesús y La Resurrección, narradas paso a paso en 50 partes.
2️⃣ 50 Láminas para Colorear: Dibujos hermosos con trazos claros ideales para lápices, crayolas o témperas (de 3 a 10 años).
3️⃣ 50 Lecciones Bíblicas para el Corazón: Cada página trae una reflexión diaria para conversar en familia sobre el perdón, la obediencia, la valentía y el amor de Dios.
4️⃣ 🏆 Diploma de "Pequeño Conocedor de la Biblia": Certificado al final del libro listo para imprimir y premiar su dedicación cuando complete las historias.

✨ Ventaja única: Al ser en formato digital PDF, lo guardás en tu celular y lo imprimís en casa o en una librería las veces que quieras (ideal si tenés más de un niño o para volver a pintar).

🔥 Precio promocional hoy: Gs. 19.000 (pago único, acceso para siempre directo a tu WhatsApp)

¿Cómo te gustaría continuar? Elegí una opción 👇
1️⃣ Ver páginas por dentro 🖼️
2️⃣ Lo quiero ya 📲`;

const deliveryNote = `Recomendación: Impriman una historia por semana para hacer juntos el devocional familiar. ¡Que sea de gran bendición para tu hogar! ✨`;

async function main() {
  const client = await pool.connect();
  try {
    const { rows: existingProducts } = await client.query(
      `SELECT id, name, price, resumen FROM products 
       WHERE slug = 'grandes-historias-de-la-biblia' 
          OR name ILIKE '%Grandes Historias%' 
          OR resumen ILIKE '%Grandes Historias%'
          OR description ILIKE '%Grandes Historias%'
       LIMIT 1`
    );

    let targetProductId = existingProducts[0]?.id;
    if (!targetProductId) {
      const { rows: allProds } = await client.query('SELECT id, name FROM products LIMIT 2');
      if (allProds.length === 1) {
        targetProductId = allProds[0].id;
      }
    }

    if (targetProductId) {
      await client.query(
        `UPDATE products
         SET resumen = $1,
             price = 19000,
             currency = 'PYG',
             precio_recuperacion = 15000,
             delivery_note = COALESCE(delivery_note, $2),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [nuevoResumen, deliveryNote, targetProductId]
      );
      console.log(`✅ Producto #${targetProductId} actualizado correctamente a Gs. 19.000 con el nuevo resumen y nota de entrega.`);
    } else {
      const { rows: teams } = await client.query('SELECT id FROM teams ORDER BY id ASC LIMIT 1');
      const teamId = teams[0]?.id || null;

      const { rows: nuevo } = await client.query(
        `INSERT INTO products (team_id, slug, name, description, resumen, price, currency, precio_recuperacion, delivery_note, is_active, sort_order)
         VALUES ($1, 'grandes-historias-de-la-biblia', 'Grandes Historias de la Biblia — Libro para Colorear (PDF)', $2, $3, 19000, 'PYG', 15000, $4, TRUE, 1)
         RETURNING id`,
        [
          teamId,
          'Material educativo y devocional cristiano para niños de 3 a 10 años en formato digital PDF listo para imprimir en casa o librería.',
          nuevoResumen,
          deliveryNote
        ]
      );
      console.log(`🌱 Producto creado con éxito (#${nuevo[0].id}).`);
    }
  } catch (err) {
    console.error('❌ Error al actualizar producto:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
