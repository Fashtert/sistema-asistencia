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
  port: 3307
});

db.connect(err => {
  if (err) console.log(err);
  else console.log("MySQL conectado");
});

app.use(express.json());

app.use(session({
  secret: "clave_super_segura",
  resave: false,
  saveUninitialized: false
}));

function auth(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

function registrarLog(usuario_id, accion, descripcion, ip) {
  db.query(
    "INSERT INTO logs (usuario_id, accion, descripcion, ip) VALUES (?, ?, ?, ?)",
    [usuario_id, accion, descripcion, ip]
  );
}

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.query(
    "SELECT * FROM usuarios WHERE username=?",
    [username],
    async (err, result) => {
      if (result.length === 0) return res.json({ success: false });

      const user = result[0];
      let acceso = false;

      if (user.password.startsWith("$2b$")) {
        acceso = await bcrypt.compare(password, user.password);
      } else {
        if (password === user.password) {
          acceso = true;
          const hash = await bcrypt.hash(password, 10);
          db.query("UPDATE usuarios SET password=? WHERE id=?", [hash, user.id]);
        }
      }

      if (!acceso) return res.json({ success: false });

      req.session.user = user;
      registrarLog(user.id, "LOGIN", "Inicio sesión", req.ip);

      res.json({ success: true, rol: user.rol });
    }
  );
});

app.get("/me", auth, (req, res) => {
  res.json(req.session.user);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "login.html")));

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
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// ================= FOTO PERFIL =================
const storagePerfil = multer.diskStorage({
  destination: "uploads/perfiles/",
  filename: (req, file, cb) => {
    const nombre = "perfil_" + Date.now() + path.extname(file.originalname);
    cb(null, nombre);
  }
});

const uploadPerfil = multer({
  storage: storagePerfil,
  fileFilter: (req, file, cb) => {
    const tipos = ["image/png", "image/jpeg", "image/jpg"];
    if (tipos.includes(file.mimetype)) cb(null, true);
    else cb(null, false);
  },
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

// subir foto perfil (MEJORADO)
app.post("/perfil/foto", auth, uploadPerfil.single("foto"), (req, res) => {

  const user = req.session.user;

  if (!req.file) return res.status(400).json({ error: true });

  const ruta = "/uploads/perfiles/" + req.file.filename;

  // 🔥 asegurar que exista empleado
  db.query(
    "INSERT IGNORE INTO empleados (dni, nombres, cargo) VALUES (?, ?, ?)",
    [user.username, user.username, "Sin cargo"],
    () => {

      // 🔥 obtener foto anterior
      db.query(
        "SELECT foto FROM empleados WHERE dni=?",
        [user.username],
        (err, result) => {

          const fotoAnterior = result[0]?.foto;

          // 🔥 actualizar nueva foto
          db.query(
            "UPDATE empleados SET foto=? WHERE dni=?",
            [ruta, user.username],
            (err2) => {

              if (err2) return res.status(500).json({ error: true });

              // 🔥 eliminar foto anterior (si existe)
              if (fotoAnterior) {
                const rutaFisica = path.join(__dirname, fotoAnterior);
                if (fs.existsSync(rutaFisica)) {
                  try { fs.unlinkSync(rutaFisica); } catch(e){}
                }
              }

              registrarLog(user.id, "FOTO_PERFIL", "Actualizó foto", req.ip);

              res.json({ success: true, ruta });
            }
          );
        }
      );

    }
  );
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
    }
  );
});

// obtener perfil completo
app.get("/perfil", auth, (req, res) => {
  const user = req.session.user;

  db.query(
    "SELECT * FROM empleados WHERE dni = ? LIMIT 1",
    [user.username],
    (err, result) => {
      if (err) return res.status(500).json(null);

      if (result.length === 0) {
        return res.json({
          nombres: user.username,
          apellido: "",
          dni: user.username,
          cargo: "",
          foto: null
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

    lineas.forEach(linea => {
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

    keys.forEach(key => {
      let item = asistencia[key];
      const { entrada, salida, estado } = evaluarAsistencia(item.horas);

      resultado.push({
        id_empleado: item.id_empleado,
        fecha: item.fecha,
        entrada,
        salida,
        estado
      });

      db.query(
        "INSERT IGNORE INTO empleados (dni, nombres, cargo) VALUES (?, ?, ?)",
        [item.id_empleado, "Sin nombre", "Sin cargo"]
      );

      db.query(
        `INSERT INTO asistencia 
        (id_empleado, fecha, entrada, salida, estado)
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
  db.query(
    `SELECT COUNT(*) total,
     SUM(estado='Puntual') puntual,
     SUM(estado='Tardanza') tardanza
     FROM asistencia`,
    (err, result) => res.json(result[0])
  );
});

app.get("/asistencia", auth, (req, res) => {
  db.query(`
    SELECT a.*, e.nombres
    FROM asistencia a
    LEFT JOIN empleados e ON e.dni = a.id_empleado
    ORDER BY fecha DESC, entrada DESC
    LIMIT 200
  `, (err, result) => {
    if (err) return res.status(500).json([]);
    res.json(result);
  });
});

app.get("/logs", auth, (req, res) => {
  db.query(`
    SELECT l.*, u.username
    FROM logs l
    LEFT JOIN usuarios u ON u.id = l.usuario_id
    ORDER BY l.fecha DESC
  `, (err, result) => {
    if (err) return res.status(500).json([]);
    res.json(result);
  });
});

app.get("/empleados", auth, (req, res) => {
  db.query("SELECT * FROM empleados", (err, result) => {
    res.json(result);
  });
});

app.get("/empleado-detalle", auth, (req, res) => {
  let { buscar } = req.query;
  if (!buscar) return res.json(null);

  buscar = buscar.trim();

  db.query(`
    SELECT e.*, 
    SUM(a.estado='Puntual') puntual,
    SUM(a.estado='Tardanza') tardanza
    FROM empleados e
    LEFT JOIN asistencia a ON e.dni = a.id_empleado
    WHERE e.dni=? OR e.nombres LIKE ?
    GROUP BY e.id
    LIMIT 1
  `, [buscar, "%" + buscar + "%"], (err, result) => {
    if (result.length === 0) return res.json(null);
    res.json(result[0]);
  });
});

app.use(express.static(__dirname));

app.listen(3000, () => console.log("Servidor activo"));