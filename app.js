const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const session = require("express-session");

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
  secret: "clave",
  resave: false,
  saveUninitialized: true
}));

function auth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  next();
}

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  db.query(
    "SELECT * FROM usuarios WHERE username=? AND password=?",
    [username, password],
    (err, result) => {
      if (result.length === 0) {
        return res.json({ success: false });
      }

      req.session.user = result[0];

      res.json({
        success: true,
        rol: result[0].rol
      });
    }
  );
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/index.html", auth, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/dashboard.html", auth, (req, res) => {
  if (req.session.user.rol !== "admin") {
    return res.redirect("/index.html");
  }
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login.html");
});

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage });

app.post("/upload", auth, upload.single("archivo"), (req, res) => {
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
        asistencia[key] = {
          id_empleado: id,
          fecha,
          horas: []
        };
      }

      asistencia[key].horas.push(hora);
    }
  });

  let resultado = [];

  for (let key in asistencia) {
    let item = asistencia[key];

    item.horas.sort();

    let entrada = item.horas[0];
    let salida = item.horas[item.horas.length - 1];
    let estado = entrada > "08:00:00" ? "Tardanza" : "Puntual";

    resultado.push({
      id_empleado: item.id_empleado,
      fecha: item.fecha,
      entrada,
      salida,
      estado
    });

    db.query(
      `INSERT INTO asistencia 
      (id_empleado, fecha, entrada, salida, estado)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      entrada=VALUES(entrada),
      salida=VALUES(salida),
      estado=VALUES(estado)`,
      [item.id_empleado, item.fecha, entrada, salida, estado]
    );
  }

  res.json(resultado);
});

app.get("/dashboard-data", auth, (req, res) => {
  db.query(
    `SELECT COUNT(*) total,
     SUM(estado='Puntual') puntual,
     SUM(estado='Tardanza') tardanza
     FROM asistencia`,
    (err, result) => {
      res.json(result[0]);
    }
  );
});

app.use(express.static(__dirname));

app.listen(3000, () => console.log("Servidor activo"));