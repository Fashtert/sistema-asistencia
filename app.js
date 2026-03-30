const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

// SERVIR ARCHIVOS (HTML, JS, CSS)
app.use(express.static(__dirname));

// Configuración de subida
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage });

// Ruta principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Subida y procesamiento
app.post("/upload", upload.single("archivo"), (req, res) => {
  console.log("Archivo recibido:", req.file);

  if (!req.file) {
    return res.status(400).json({ error: "No se recibió archivo" });
  }

  const ruta = req.file.path;
  const data = fs.readFileSync(ruta, "utf-8");
  const lineas = data.split("\n");

  let registros = [];

  lineas.forEach(linea => {
    if (!linea.trim()) return;

    const partes = linea.trim().split(/\s+/);

    if (partes.length >= 3) {
      registros.push({
        id_empleado: partes[0],
        fecha_hora: partes[1] + " " + partes[2]
      });
    }
  });

  let asistencia = {};

  registros.forEach(r => {
    const [fecha, hora] = r.fecha_hora.split(" ");
    const key = r.id_empleado + "_" + fecha;

    if (!asistencia[key]) {
      asistencia[key] = {
        id_empleado: r.id_empleado,
        fecha: fecha,
        horas: []
      };
    }

    asistencia[key].horas.push(hora);
  });

  let resultado = [];

  for (let key in asistencia) {
    let item = asistencia[key];

    item.horas.sort();

    let entrada = item.horas[0];
    let salida = item.horas[item.horas.length - 1];

    resultado.push({
      id_empleado: item.id_empleado,
      fecha: item.fecha,
      entrada: entrada,
      salida: salida
    });
  }

  console.log("Asistencia procesada:", resultado);

  res.json(resultado);
});

// Iniciar servidor
app.listen(3000, () => {
  console.log("Servidor en http://localhost:3000");
});