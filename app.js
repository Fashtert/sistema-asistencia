const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");

const app = express();


const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "123456",
  database: "asistencia_db",
  port: 3307,
});

db.connect((err) => {
  if (err) console.log(err);
  else console.log("MySQL conectado");
});

app.use(express.json());

app.use(
  session({
    secret: "clave_super_segura",
    resave: false,
    saveUninitialized: false,
  }),
);

function auth(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

function registrarLog(usuario_id, accion, descripcion, ip) {
  db.query(
    "INSERT INTO logs (usuario_id, accion, descripcion, ip) VALUES (?, ?, ?, ?)",
    [usuario_id, accion, descripcion, ip],
  );
}

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.query(
    "SELECT * FROM usuarios WHERE username=?",
    [username],
    async (err, result) => {
      if (err) return res.status(500).json({ success: false });
      if (result.length === 0) return res.json({ success: false });

      const user = result[0];
      let acceso = false;

      if (user.password.startsWith("$2b$")) {
        acceso = await bcrypt.compare(password, user.password);
      } else {
        if (password === user.password) {
          acceso = true;
          const hash = await bcrypt.hash(password, 10);
          db.query("UPDATE usuarios SET password=? WHERE id=?", [
            hash,
            user.id,
          ]);
        }
      }

      if (!acceso) return res.json({ success: false });

      req.session.user = {
        id: user.id,
        username: user.username,
        rol: user.rol,
      };

      registrarLog(user.id, "LOGIN", "Inicio sesión", req.ip);

      res.json({ success: true, rol: user.rol });
    },
  );
});

app.get("/me", auth, (req, res) => {
  res.json(req.session.user);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/login.html", (req, res) =>
  res.sendFile(path.join(__dirname, "login.html")),
);

app.get("/index.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dashboard.html", auth, (req, res) => {
  if (req.session.user.rol !== "admin") return res.redirect("/index.html");
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/logout", (req, res) => {
  if (req.session.user) {
    registrarLog(req.session.user.id, "LOGOUT", "Cierre sesión", req.ip);
  }
  req.session.destroy();
  res.redirect("/login.html");
});

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ================= FOTO PERFIL =================
const storagePerfil = multer.diskStorage({
  destination: "uploads/perfiles/",
  filename: (req, file, cb) => {
    const nombre = "perfil_" + Date.now() + path.extname(file.originalname);
    cb(null, nombre);
  },
});

const uploadPerfil = multer({
  storage: storagePerfil,
  fileFilter: (req, file, cb) => {
    const tipos = ["image/png", "image/jpeg", "image/jpg"];
    if (tipos.includes(file.mimetype)) cb(null, true);
    else cb(null, false);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

app.post("/perfil/foto", uploadPerfil.single("foto"), async (req, res) => {
  try {
    const userId = req.session.user.id;

    const ruta = "/uploads/" + req.file.filename;

    // GUARDAR EN BD
    await db.query(
      "UPDATE usuarios SET foto = ? WHERE id = ?",
      [ruta, userId]
    );

    res.json({ success: true, ruta });

  } catch (error) {
    console.error(error);
    res.json({ success: false });
  }
});

// actualizar datos perfil
app.put("/perfil", auth, (req, res) => {
  if (req.session.user.rol !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  const { nombres, apellido, dni, cargo } = req.body;

  db.query(
    "UPDATE empleados SET nombres=?, apellido=?, dni=?, cargo=? WHERE dni=?",
    [nombres, apellido, dni, cargo, dni],
    (err) => {
      if (err) return res.status(500).json({ error: true });
      res.json({ success: true });
    },
  );
});

// obtener perfil completo
app.get("/perfil", auth, (req, res) => {
  const user = req.session.user;

  db.query(
    `SELECT e.*, u.username, u.rol 
     FROM empleados e
     LEFT JOIN usuarios u ON u.dni = e.dni
     WHERE u.id = ? LIMIT 1`,
    [user.id],
    (err, result) => {
      if (err) return res.status(500).json(null);

      if (result.length === 0) {
        return res.json({
          nombres: user.username,
          apellido: "",
          dni: "",
          cargo: "",
          foto: null,
          username: user.username,
          rol: user.rol
        });
      }

      res.json(result[0]);
    }
  );
});

function evaluarAsistencia(horas) {
  if (horas.length === 0) {
    return { entrada: null, salida: null, estado: "Falta" };
  }

  horas.sort();

  const entrada = horas[0];
  const salida = horas.length > 1 ? horas[horas.length - 1] : null;
  const estado = entrada <= "08:05:00" ? "Puntual" : "Tardanza";

  return { entrada, salida, estado };
}

app.post("/upload", auth, upload.single("archivo"), (req, res) => {
  try {
    const data = fs.readFileSync(req.file.path, "utf-8");
    const lineas = data.split("\n");

    let asistencia = {};

    lineas.forEach((linea) => {
      if (!linea.trim()) return;

      const partes = linea.trim().split(/\s+/);

      if (partes.length >= 3) {
        const id = partes[0];
        const fecha = partes[1];
        const hora = partes[2];
        const key = id + "_" + fecha;

        if (!asistencia[key]) {
          asistencia[key] = { id_empleado: id, fecha, horas: [] };
        }

        asistencia[key].horas.push(hora);
      }
    });

    const keys = Object.keys(asistencia);
    if (keys.length === 0) return res.json([]);

    let resultado = [];
    let completados = 0;

    keys.forEach((key) => {
      let item = asistencia[key];
      const { entrada, salida, estado } = evaluarAsistencia(item.horas);

      resultado.push({
        id_empleado: item.id_empleado,
        fecha: item.fecha,
        entrada,
        salida,
        estado,
      });

      db.query(
        "INSERT IGNORE INTO empleados (dni, nombres, cargo) VALUES (?, ?, ?)",
        [item.id_empleado, "Sin nombre", "Sin cargo"],
      );

      db.query(
        `INSERT INTO asistencia (id_empleado, fecha, entrada, salida, estado)
   VALUES (?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE
   entrada=VALUES(entrada),
   salida=VALUES(salida),
   estado=VALUES(estado)`,
        [item.id_empleado, item.fecha, entrada, salida, estado],
        () => {
          completados++;
          if (completados === keys.length) {
            try { fs.unlinkSync(req.file.path); } catch (e) { }

            registrarLog(
              req.session.user.id,
              "UPLOAD",
              "Subió archivo",
              req.ip
            );

            return res.json(resultado);
          }
        }
      );
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: true });
  }
});

app.get("/dashboard-data", auth, (req, res) => {
  const { tipo, fecha } = req.query;

  let condicion = "";
  let params = [];

  if (tipo === "dia" && fecha) {
    condicion = "WHERE fecha = ?";
    params.push(fecha);
  }

  if (tipo === "mes" && fecha) {
    condicion = "WHERE DATE_FORMAT(fecha, '%Y-%m') = ?";
    params.push(fecha);
  }

  if (tipo === "anio" && fecha) {
    condicion = "WHERE YEAR(fecha) = ?";
    params.push(fecha);
  }

  // 🔥 total empleados (SIEMPRE global)
  db.query("SELECT COUNT(*) AS total_empleados FROM empleados", (err, emp) => {
    // 🔥 asistencia filtrada
    db.query(
      `SELECT 
        COUNT(*) total_asistencia,
        SUM(estado='Puntual') puntual,
        SUM(estado='Tardanza') tardanza
      FROM asistencia
      ${condicion}`,
      params,
      (err2, data) => {
        res.json({
          total_empleados: emp[0].total_empleados || 0,
          total_asistencia: data[0].total_asistencia || 0,
          puntual: data[0].puntual || 0,
          tardanza: data[0].tardanza || 0,
        });
      },
    );
  });
});

app.get("/asistencia-filtrada", auth, (req, res) => {
  const { tipo, fecha, desde, hasta } = req.query;

  let condicion = "";
  let params = [];

  if (tipo === "dia" && fecha) {
    condicion = "WHERE a.fecha = ?";
    params.push(fecha);
  }

  if (tipo === "mes" && fecha) {
    condicion = "WHERE DATE_FORMAT(a.fecha,'%Y-%m') = ?";
    params.push(fecha);
  }

  if (tipo === "anio" && fecha) {
    condicion = "WHERE YEAR(a.fecha) = ?";
    params.push(fecha);
  }

  db.query(
    `
    SELECT a.*, e.nombres, e.apellido, e.cargo,
    (e.nombres IS NULL OR e.apellido='' OR e.cargo='' OR e.nombres='Sin nombre') AS incompleto
    FROM asistencia a
    LEFT JOIN empleados e ON e.dni = a.id_empleado
    ${condicion}
    ORDER BY a.fecha DESC
  `,
    params,
    (err, result) => {
      if (err) return res.status(500).json([]);

      const incompletos = result.filter((r) => r.incompleto);
      const completos = result.filter((r) => !r.incompleto);

      res.json({ incompletos, completos });
    },
  );
});

const ExcelJS = require("exceljs");

app.get("/exportar-excel", auth, async (req, res) => {
  const { tipo, fecha, desde, hasta } = req.query;

  let condicion = "";
  let params = [];

  if (tipo === "dia") {
    condicion = "WHERE fecha = ?";
    params.push(fecha);
  }

  if (tipo === "mes") {
    condicion = "WHERE DATE_FORMAT(fecha,'%Y-%m') = ?";
    params.push(fecha);
  }

  if (tipo === "rango") {
    condicion = "WHERE fecha BETWEEN ? AND ?";
    params.push(desde, hasta);
  }

  const [rows] = await db.promise().query(
    `
    SELECT * FROM asistencia
    ${condicion}
  `,
    params,
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Asistencia");

  sheet.columns = [
    { header: "DNI", key: "id_empleado" },
    { header: "Fecha", key: "fecha" },
    { header: "Entrada", key: "entrada" },
    { header: "Salida", key: "salida" },
    { header: "Estado", key: "estado" },
  ];

  rows.forEach((r) => sheet.addRow(r));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );

  res.setHeader("Content-Disposition", "attachment; filename=asistencia.xlsx");

  await workbook.xlsx.write(res);
  res.end();
});

app.get("/logs", auth, (req, res) => {
  const { tipo, fecha } = req.query;

  let condicion = "";
  let params = [];

  if (tipo === "dia" && fecha) {
    condicion = "WHERE DATE(l.fecha) = ?";
    params.push(fecha);
  }

  if (tipo === "mes" && fecha) {
    condicion = "WHERE DATE_FORMAT(l.fecha, '%Y-%m') = ?";
    params.push(fecha);
  }

  if (tipo === "anio" && fecha) {
    condicion = "WHERE YEAR(l.fecha) = ?";
    params.push(fecha);
  }

  db.query(
    `
    SELECT l.*, u.username
    FROM logs l
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    ${condicion}
    ORDER BY l.fecha DESC
  `,
    params,
    (err, result) => {
      if (err) return res.status(500).json([]);
      res.json(result);
    }
  );
});

app.post("/empleados", auth, uploadPerfil.single("foto"), (req, res) => {
  const { dni, nombre, apellido, telefono, nacionalidad, cargo, fecha, turno } =
    req.body;
  const foto = req.file ? "/uploads/perfiles/" + req.file.filename : null;

  // ✅ VALIDACIÓN
  if (
    !dni ||
    !nombre ||
    !apellido ||
    !telefono ||
    !nacionalidad ||
    !cargo ||
    !fecha ||
    !turno
  ) {
    return res.status(400).json({ error: "Completa todos los campos" });
  }

  // ✅ VALIDAR DNI DUPLICADO
  db.query("SELECT id FROM empleados WHERE dni=?", [dni], (err, rows) => {
    if (rows.length > 0) {
      return res.status(400).json({ error: "DNI ya existe" });
    }

    // ✅ VALIDAR TURNO OCUPADO
    db.query(
      "SELECT * FROM turnos WHERE fecha=? AND turno=?",
      [fecha, turno],
      (err2, ocupado) => {
        if (ocupado.length > 0) {
          return res.status(400).json({ error: "Turno ocupado" });
        }

        let hora_inicio, hora_fin;

        if (turno === "mañana") {
          hora_inicio = "07:00:00";
          hora_fin = "15:00:00";
        }
        if (turno === "tarde") {
          hora_inicio = "15:00:00";
          hora_fin = "23:00:00";
        }
        if (turno === "noche") {
          hora_inicio = "23:00:00";
          hora_fin = "07:00:00";
        }

        // ✅ INSERT EMPLEADO
        db.query(
          `INSERT INTO empleados 
          (dni, nombres, apellido, telefono, nacionalidad, cargo, foto) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [dni, nombre, apellido, telefono, nacionalidad, cargo, foto],
          () => {
            // ✅ INSERT TURNO
            db.query(
              `INSERT INTO turnos 
              (fecha, turno, hora_inicio, hora_fin, empleado_dni) 
              VALUES (?, ?, ?, ?, ?)`,
              [fecha, turno, hora_inicio, hora_fin, dni],
              () => {
                registrarLog(
                  req.session.user.id,
                  "CREAR_EMPLEADO",
                  "Nuevo empleado registrado",
                  req.ip,
                );

                res.json({ success: true });
              },
            );
          },
        );
      },
    );
  });
});

app.get("/empleados", (req, res) => {
  db.query("SELECT * FROM empleados", (err, result) => {
    if (err) return res.status(500).json([]);
    res.json(result);
  });
});

app.put("/empleados/:id", auth, (req, res) => {
  const { id } = req.params;
  const { dni, nombre, apellido, telefono, nacionalidad, cargo } = req.body;
  const nombres = nombre;

  db.query(
    `UPDATE empleados SET 
      dni=?, nombres=?, apellido=?, telefono=?, nacionalidad=?, cargo=? 
     WHERE id=?`,
    [dni, nombre, apellido, telefono, nacionalidad, cargo, id],
    (err) => {
      if (err) return res.status(500).json({ error: true });
      res.json({ success: true });
    },
  );
});

app.delete("/empleados/:id", auth, (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM empleados WHERE id=?", [id], (err) => {
    if (err) return res.status(500).json({ error: true });
    res.json({ success: true });
  });
});

app.get("/verificar-turno", (req, res) => {
  const { fecha, turno } = req.query;

  db.query(
    "SELECT * FROM turnos WHERE fecha=? AND turno=?",
    [fecha, turno],
    (err, result) => {
      if (result.length > 0) {
        return res.json({ ocupado: true });
      }

      res.json({ ocupado: false });
    },
  );
});

app.use(express.static(__dirname));

// ================= USUARIOS =================

// obtener usuarios
app.get("/usuarios", auth, (req, res) => {
  db.query("SELECT id, nombres, apellidos, dni, username, rol FROM usuarios", (err, result) => {
    if (err) return res.status(500).json([]);
    res.json(result);
  });
});

// crear usuario
app.post("/usuarios", auth, async (req, res) => {

  if (req.session.user.rol !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  const { nombres, apellidos, dni, username, password, rol } = req.body;

  if (!nombres || !apellidos || !dni || !username || !password || !rol) {
    return res.status(400).json({ error: "Campos incompletos" });
  }

  const hash = await bcrypt.hash(password, 10);

  db.query(
    "INSERT INTO usuarios (nombres, apellidos, dni, username, password, rol) VALUES (?, ?, ?, ?, ?, ?)",
    [nombres, apellidos, dni, username, hash, rol],
    (err) => {
      if (err) return res.status(500).json({ error: err });

      registrarLog(
        req.session.user.id,
        "CREAR_USUARIO",
        "Nuevo usuario creado",
        req.ip
      );

      res.json({ success: true });
    }
  );
});

// actualizar usuario
app.put("/usuarios/:id", auth, async (req, res) => {
  if (req.session.user.rol !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  const { id } = req.params;
  const { username, password, rol, adminPassword } = req.body;

  // 🔐 validar contraseña admin
  db.query(
    "SELECT password FROM usuarios WHERE id=?",
    [req.session.user.id],
    async (err, result) => {
      if (err || result.length === 0)
        return res.status(500).json({ error: true });

      const hash = result[0].password;
      const valido = await bcrypt.compare(adminPassword, hash);

      if (!valido) {
        return res.status(401).json({ error: "Contraseña incorrecta" });
      }

      let query = "UPDATE usuarios SET username=?, rol=?";
      let params = [username, rol];

      if (password) {
        const newHash = await bcrypt.hash(password, 10);
        query = "UPDATE usuarios SET username=?, password=?, rol=?";
        params = [username, newHash, rol];
      }

      params.push(id);

      db.query(query + " WHERE id=?", params, (err2) => {
        if (err2) return res.status(500).json({ error: true });

        registrarLog(
          req.session.user.id,
          "EDITAR_USUARIO",
          "Usuario actualizado",
          req.ip
        );

        res.json({ success: true });
      });
    }
  );
});

// eliminar usuario
app.delete("/usuarios/:id", auth, (req, res) => {

  if (req.session.user.rol !== "admin") {
    return res.status(403).json({ error: "No autorizado" });
  }

  const { id } = req.params;

  db.query("DELETE FROM usuarios WHERE id=?", [id], (err) => {
    if (err) return res.status(500).json({ error: true });

    registrarLog(
      req.session.user.id,
      "ELIMINAR_USUARIO",
      "Usuario eliminado",
      req.ip
    );

    res.json({ success: true });
  });
});

app.listen(3000, () => console.log("Servidor activo"));
