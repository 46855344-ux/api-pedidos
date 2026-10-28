const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// La cadena de conexión de Neon vive SOLO en el servidor
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ESTADOS = ["PENDIENTE", "EN_PREPARACION", "LISTO", "ENTREGADO", "CANCELADO"];
const TRANSICIONES = {
  PENDIENTE: ["EN_PREPARACION", "CANCELADO"],
  EN_PREPARACION: ["LISTO"],
  LISTO: ["ENTREGADO"],
  ENTREGADO: [],
  CANCELADO: []
};

// Envía los errores de las rutas async al manejador final
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });

// Pedidos con su detalle en un solo JSON
const SQL_PEDIDOS = `
  SELECT p.id, p.uuid, p.cliente_nombre AS "clienteNombre",
         p.cliente_telefono AS "clienteTelefono", p.estado,
         p.total::float AS total, p.nota,
         to_char(p.fecha_registro AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') AS hora,
         to_char(p.fecha_actualizacion AT TIME ZONE 'America/Lima', 'DD/MM HH24:MI') AS "horaActualizacion",
         COALESCE(json_agg(json_build_object(
           'productoId', d.producto_id, 'nombre', pr.nombre,
           'cantidad', d.cantidad, 'precioUnitario', d.precio_unitario::float
         ) ORDER BY d.id) FILTER (WHERE d.id IS NOT NULL), '[]') AS items
  FROM pedidos p
  LEFT JOIN pedido_detalle d ON d.pedido_id = p.id
  LEFT JOIN productos pr ON pr.id = d.producto_id
  /*WHERE*/
  GROUP BY p.id
  ORDER BY p.fecha_registro DESC
  LIMIT 100`;

async function listarPedidos(filtros = {}) {
  const cond = [];
  const params = [];
  if (filtros.id) { params.push(filtros.id); cond.push(`p.id = $${params.length}`); }
  if (filtros.telefono) { params.push(filtros.telefono); cond.push(`p.cliente_telefono = $${params.length}`); }
  if (filtros.estado) { params.push(filtros.estado); cond.push(`p.estado = $${params.length}`); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const r = await pool.query(SQL_PEDIDOS.replace("/*WHERE*/", where), params);
  return r.rows;
}

async function pedidoPorId(id) {
  return (await listarPedidos({ id }))[0];
}

app.get("/", (req, res) => res.json({ api: "Pedidos Pastelería Delicia", estado: "ok" }));

// ---------- CLIENTE ----------
app.get("/api/productos", h(async (req, res) => {
  const r = await pool.query(
    `SELECT id, nombre, categoria, precio::float AS precio
     FROM productos WHERE disponible ORDER BY categoria, nombre`);
  res.json(r.rows);
}));

app.post("/api/pedidos", h(async (req, res) => {
  const { uuid, clienteNombre, clienteTelefono, nota, items } = req.body;
  const uuidValido = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid || "");
  if (!uuidValido || !String(clienteNombre || "").trim() || !/^9\d{8}$/.test(clienteTelefono || "")
      || !Array.isArray(items) || items.length === 0) {
    throw error(400, "Datos del pedido incompletos o inválidos");
  }

  // Idempotencia: si el uuid ya existe, se devuelve el mismo pedido
  const previo = await pool.query("SELECT id FROM pedidos WHERE uuid = $1", [uuid]);
  if (previo.rowCount) return res.json(await pedidoPorId(previo.rows[0].id));

  const db = await pool.connect();
  let pedidoId;
  try {
    await db.query("BEGIN");
    const ids = items.map((i) => i.productoId);
    const r = await db.query(
      "SELECT id, precio FROM productos WHERE id = ANY($1::int[]) AND disponible", [ids]);
    const precios = new Map(r.rows.map((p) => [p.id, Number(p.precio)]));

    let total = 0;
    for (const it of items) {
      if (!precios.has(it.productoId) || !Number.isInteger(it.cantidad) || it.cantidad < 1) {
        throw error(400, "Producto o cantidad no válidos");
      }
      total += precios.get(it.productoId) * it.cantidad;
    }

    const p = await db.query(
      `INSERT INTO pedidos (uuid, cliente_nombre, cliente_telefono, nota, total)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [uuid, String(clienteNombre).trim(), clienteTelefono, nota || null, total.toFixed(2)]);
    pedidoId = p.rows[0].id;

    for (const it of items) {
      await db.query(
        `INSERT INTO pedido_detalle (pedido_id, producto_id, cantidad, precio_unitario)
         VALUES ($1, $2, $3, $4)`,
        [pedidoId, it.productoId, it.cantidad, precios.get(it.productoId)]);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    if (e.code === "23505") {   // el mismo uuid llegó dos veces al mismo tiempo
      const dup = await pool.query("SELECT id FROM pedidos WHERE uuid = $1", [uuid]);
      return res.json(await pedidoPorId(dup.rows[0].id));
    }
    throw e;
  } finally {
    db.release();
  }
  res.status(201).json(await pedidoPorId(pedidoId));
}));

// ---------- CLIENTE (?telefono=) Y EMPLEADO (?estado=) ----------
app.get("/api/pedidos", h(async (req, res) => {
  const { telefono, estado } = req.query;
  if (estado && !ESTADOS.includes(estado)) throw error(400, "Estado no válido");
  res.json(await listarPedidos({ telefono, estado }));
}));

// ---------- EMPLEADO ----------
app.patch("/api/pedidos/:id/estado", h(async (req, res) => {
  const id = Number(req.params.id);
  const { estado } = req.body;
  if (!Number.isInteger(id) || !ESTADOS.includes(estado)) throw error(400, "Datos no válidos");

  const actual = await pool.query("SELECT estado FROM pedidos WHERE id = $1", [id]);
  if (!actual.rowCount) throw error(404, "Pedido no encontrado");
  const desde = actual.rows[0].estado;
  if (!TRANSICIONES[desde].includes(estado)) {
    throw error(409, `No se puede pasar de ${desde} a ${estado}`);
  }

  // "AND estado = $3" evita que dos empleados hagan el mismo cambio a la vez
  const r = await pool.query(
    "UPDATE pedidos SET estado = $1, fecha_actualizacion = now() WHERE id = $2 AND estado = $3",
    [estado, id, desde]);
  if (!r.rowCount) throw error(409, "El pedido cambió de estado. Actualiza la lista");

  res.json(await pedidoPorId(id));
}));

// ---------- ADMINISTRADOR ----------
app.get("/api/resumen", h(async (req, res) => {
  const r = await pool.query(`
    SELECT estado, COUNT(*)::int AS cantidad, COALESCE(SUM(total), 0)::float AS monto
    FROM pedidos
    WHERE (fecha_registro AT TIME ZONE 'America/Lima')::date
        = (now() AT TIME ZONE 'America/Lima')::date
    GROUP BY estado`);
  res.json(r.rows);
}));

// Manejador final de errores: siempre responde { mensaje }
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ mensaje: err.status ? err.message : "Error interno del servidor" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API de pedidos en el puerto ${PORT}`));