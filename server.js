const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

// Mapa de confirmaciones OCR pendientes: { [from]: { datos, usuarioNombre, timestamp } }
const pendingOCR = new Map();
const PENDING_OCR_TTL = 5 * 60 * 1000; // 5 minutos de validez
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET no está configurado. Configurá la variable de entorno en Railway.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// ── OCR con Claude Vision ──────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;


// Formatea el mensaje de confirmación según el tipo de planilla
function formatearConfirmacionOCR(datos) {
  if (datos.tipo === 'TURNO') {
    const vars = (datos.variedades || []).map(v => `  • ${v.nombre}: ${v.cantidad} ${v.envase||'caja'}${v.cantidad!=1?'s':''} × ${v.kg}kg`).join('\n');
    return `📋 *Leí esto de la planilla — ¿es correcto?*\n\n` +
      `Tipo: Turno de producción\n` +
      `Lote: ${datos.loteId||'—'}\n` +
      `Fecha: ${datos.fecha||'—'}\n` +
      `Turno: ${datos.turno||'—'}\n` +
      `Hora inicio: ${datos.horaInicio||'—'}\n` +
      `Hora fin: ${datos.horaFin||'—'}\n` +
      `Kg cáscara: ${datos.kgCascara||0}\n` +
      `Variedades:\n${vars||'  (ninguna)'}\n` +
      (datos.observaciones ? `Observaciones: ${datos.observaciones}\n` : '') +
      `\n🔍 *Revisá los números antes de confirmar* — especialmente kg y cantidades.\n` +
      `Respondé *SI* para guardar o *NO* para cancelar.`;
    return `📋 *Leí esto de la planilla — ¿es correcto?*\n\n` +
      `Tipo: Control Calidad Fruta\n` +
      `Lote: ${datos.loteId||'—'}\n` +
      `Fecha: ${datos.fecha||'—'}\n` +
      `Hora: ${datos.hora||'—'}\n` +
      `BB muestreados: ${datos.bbMuestreados||0}\n` +
      `Peso muestra: ${datos.pesoMuestraTotal||0} gr\n\n` +
      `COLOR:\n` +
      `  • Extra Light: ${datos.extraLight||0} gr\n` +
      `  • Light: ${datos.light||0} gr\n` +
      `  • Light Ámbar: ${datos.lightAmbar||0} gr\n` +
      `  • Ámbar: ${datos.ambar||0} gr\n` +
      `  • Surtido Industrial: ${datos.surtidoIndustrial||0} gr\n` +
      (datos.observaciones ? `Observaciones: ${datos.observaciones}\n` : '') +
      `\nRespondé *SI* para guardar o *NO* para cancelar.`;

  } else if (datos.tipo === 'CALIDAD_PULPA') {
    return `📋 *Leí esto de la planilla — ¿es correcto?*\n\n` +
      `Tipo: Control Calidad Pulpa\n` +
      `Lote: ${datos.loteId||'—'}\n` +
      `Fecha: ${datos.fecha||'—'}\n` +
      `Hora: ${datos.hora||'—'}\n` +
      `Turno: ${datos.turno||'—'}\n` +
      `Variedad: ${datos.variedad||'—'}\n` +
      `Color objetivo: ${datos.colorObjetivo||'—'}\n` +
      `Peso muestra: ${datos.pesoMuestra||0} gr\n\n` +
      `FORMA:\n` +
      `  • Mariposa: ${datos.mariposaG||0} gr\n` +
      `  • Cuartos: ${datos.cuartosG||0} gr\n` +
      `  • Octavos: ${datos.octavosG||0} gr\n` +
      `  • Trozos: ${datos.trozosG||0} gr\n` +
      `  • Polvo: ${datos.polvoG||0} gr\n\n` +
      `COLOR:\n` +
      `  • Extra Light: ${datos.elG||0} gr\n` +
      `  • Light: ${datos.lightG||0} gr\n` +
      `  • Amarillo: ${datos.amarilloG||0} gr\n` +
      `  • Ámbar Light: ${datos.ambarLightG||0} gr\n` +
      `  • Ámbar: ${datos.ambarG||0} gr\n\n` +
      `DEFECTOS:\n` +
      `  • Reseca leve: ${datos.resecaLeveG||0} gr\n` +
      `  • Reseca grave: ${datos.resecaGraveG||0} gr\n` +
      `  • Mancha leve: ${datos.manchaLeveG||0} gr\n` +
      `  • Mancha grave: ${datos.manchaGraveG||0} gr\n` +
      `  • Hongo inactivo: ${datos.hongoInactivoG||0} gr\n` +
      `  • Hongo activo: ${datos.hongoActivoG||0} gr\n` +
      (datos.observaciones ? `Observaciones: ${datos.observaciones}\n` : '') +
      `\nRespondé *SI* para guardar o *NO* para cancelar.`;

  } else if (datos.tipo === 'INGRESO_LOTE') {
    const bbs = (datos.bigBags || []).filter(b => b.kg && parseFloat(b.kg) > 0);
    const pesoTotal = bbs.reduce((a, b) => a + parseFloat(b.kg || 0), 0);
    const bbsStr = bbs.map(b => `  • ${b.codigo||'BB'}: ${b.kg} kg`).join('\n');
    return `📋 *Leí esto de la planilla — ¿es correcto?*\n\n` +
      `Tipo: Ingreso de lote\n` +
      `Tipo lote: ${datos.tipoLote||'—'}\n` +
      `Producto: ${datos.producto||'—'}\n` +
      `Variedad: ${datos.variedad||'—'}\n` +
      `Cliente/Productor: ${datos.cliente||datos.productor||'—'}\n` +
      `Fecha: ${datos.fecha||'—'}\n` +
      `Big Bags (${bbs.length}): ${pesoTotal.toFixed(1)} kg total\n${bbsStr||'  (ninguno)'}\n` +
      (datos.observaciones ? `Observaciones: ${datos.observaciones}\n` : '') +
      `\n⚠️ El número de lote se asigna automáticamente al confirmar.\n` +
      `\n🔍 *REVISÁ BIEN cada kg antes de confirmar* — especialmente los dígitos 7/9 y 0/9 que se parecen en letra manuscrita. Si algo no coincide con la planilla, respondé NO.\n` +
      `Respondé *SI* para guardar o *NO* para cancelar.`;

  } else if (datos.tipo === 'CONTROL_PROCESO') {
    return `📋 *Leí esto de la planilla — ¿es correcto?*\n\n` +
      `Tipo: Control de proceso\n` +
      `Punto: ${datos.punto||'—'}\n` +
      `Lote: ${datos.loteId||'—'}\n` +
      `Fecha: ${datos.fecha||'—'}\n` +
      `Turno: ${datos.turno||'—'}\n` +
      `Peso muestra: ${datos.pesoMuestra||0} gr\n` +
      `Cáscara: ${datos.cascaraG||0} gr\n` +
      `Capote: ${datos.capoteG||0} gr\n` +
      `Pulpa: ${datos.pulpaG||0} gr\n` +
      (datos.observaciones ? `Observaciones: ${datos.observaciones}\n` : '') +
      `\nRespondé *SI* para guardar o *NO* para cancelar.`;
  }
  return `📋 *Leí esto de la planilla — ¿es correcto?*\n\nTipo: ${datos.tipo}\n\nRespondé *SI* para guardar o *NO* para cancelar.`;
}

async function procesarImagenOCR(imageBase64, contentType) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  // Obtener lista de clientes registrados para ayudar al OCR
  let clientesStr = '';
  try {
    const clientes = db.prepare('SELECT nombre FROM clientes ORDER BY nombre').all();
    if (clientes.length) {
      clientesStr = `\nCLIENTES REGISTRADOS EN EL SISTEMA (usá estos nombres exactos cuando el texto se parezca a uno de ellos):\n${clientes.map(c=>`- ${c.nombre}`).join('\n')}\n`;
    }
  } catch(e) {}

  const prompt = `Sos un sistema OCR especializado en planillas de un galpón de empaque de nueces. Tu tarea es leer con MÁXIMA PRECISIÓN cada número y texto escrito a mano.
${clientesStr}

INSTRUCCIONES CRÍTICAS PARA LECTURA DE NÚMEROS:
- Leé cada número INDIVIDUALMENTE, dígito por dígito, sin asumir ni redondear.
- Los números con coma decimal (ej: 502,5 / 490,5 / 367,5) deben leerse exactamente — la coma es decimal.
- CONFUSIONES MÁS FRECUENTES — prestá atención especial:
  * El dígito 7 y el 9 se parecen mucho en letra manuscrita. Fijate en la parte superior: el 7 tiene una línea horizontal recta, el 9 tiene un círculo cerrado arriba.
  * El dígito 0 y el 9 también se confunden. El 0 es un óvalo cerrado sin rabo, el 9 tiene un rabo hacia abajo.
  * El dígito 3 y el 8: el 3 está abierto a la izquierda, el 8 está cerrado.
  * El dígito 6 y el 0: el 6 tiene un bucle abajo, el 0 no.
- Para fechas: el año de 2 dígitos "26" significa 2026. NUNCA interpretes "26" como "2016".
- Para big bags: leé el código y el peso exactamente. Solo incluí los que tienen peso — ignorá filas vacías.
- Pesos de big bags suelen estar entre 350 y 600 kg. Si leés algo fuera de ese rango, revisá el número.
- Verificá que la cantidad de big bags que cargás coincida con el "TOTAL BB" escrito en la planilla.
- Antes de generar el JSON, releé cada número una vez más para confirmar que es correcto.

TIPOS DE PLANILLA:
1. TURNO - campos: Lote, Turno, Fecha, Hora inicio, Hora fin, Kg cáscara, Variedades (nombre/cantidad/envase/kg por unidad)
2. CALIDAD_FRUTA - campos: Lote, Fecha, Hora, BB muestreados, Peso muestra total, Extra Light (g), Light (g), Light Ámbar (g), Ámbar (g), Surtido Industrial (g), Observaciones
3. CALIDAD_PULPA - campos: Lote, Fecha, Hora, Turno, Variedad (TIPO DE CORTE: Mariposa Extra Light, Mariposa Light, Cuartos, Octavos, Trozos, Surtido Industrial — NO es la variedad de nuez como Chandler), Color objetivo, Peso muestra, Forma (Mariposa/Cuartos/Octavos/Trozos/Polvo en g), Color (EL/Light/Amarillo/Ámbar Light/Ámbar en g), Defectos (Reseca leve/grave, Mancha leve/grave, Hongo inactivo/activo en g), Observaciones
4. INGRESO_LOTE - campos: N° Lote (ignorarlo — el sistema lo asigna), Fecha, Operario, Tipo (Propio/Tercero), Cliente (si es tercero), Producto, Variedad, Origen, Productor, Observaciones, lista de Big Bags con código y kg exacto de cada uno (solo los que tienen kg), Total BB, Peso total.
5. CONTROL_PROCESO - encabezado dice "GALPÓN DE EMPAQUE — CONTROL DE PROCESO" + nombre del punto. Campos: Fecha, Hora, Turno, Lote, y valores según punto.

Respondé ÚNICAMENTE con un JSON válido sin texto adicional, sin backticks:

Para TURNO:
{"tipo":"TURNO","loteId":"L-XXXX","fecha":"YYYY-MM-DD","turno":"mañana/tarde/noche","horaInicio":"HH:MM","horaFin":"HH:MM","kgCascara":0,"variedades":[{"nombre":"","cantidad":0,"envase":"caja","kg":0}],"observaciones":""}

Para CALIDAD_FRUTA:
{"tipo":"CALIDAD_FRUTA","loteId":"L-XXXX","fecha":"YYYY-MM-DD","hora":"HH:MM","bbMuestreados":0,"pesoMuestraTotal":0,"extraLight":0,"light":0,"lightAmbar":0,"ambar":0,"surtidoIndustrial":0,"observaciones":""}

Para CALIDAD_PULPA:
{"tipo":"CALIDAD_PULPA","loteId":"L-XXXX","fecha":"YYYY-MM-DD","hora":"HH:MM","turno":"","variedad":"","colorObjetivo":"EL","pesoMuestra":500,"mariposaG":0,"cuartosG":0,"octavosG":0,"trozosG":0,"polvoG":0,"elG":0,"lightG":0,"amarilloG":0,"ambarLightG":0,"ambarG":0,"resecaLeveG":0,"manchaLeveG":0,"resecaGraveG":0,"manchaGraveG":0,"hongoInactivoG":0,"hongoActivoG":0,"observaciones":""}

Para INGRESO_LOTE:
{"tipo":"INGRESO_LOTE","fecha":"YYYY-MM-DD","operario":"","tipoLote":"propio","cliente":"","producto":"","variedad":"","origen":"","productor":"","observaciones":"","bigBags":[{"codigo":"BB-001","kg":0}],"totalBB":0,"pesoTotal":0}

Para CONTROL_PROCESO:
{"tipo":"CONTROL_PROCESO","punto":"zaranda","fecha":"YYYY-MM-DD","hora":"HH:MM","turno":"mañana/tarde/noche","loteId":"","pesoMuestra":0,"cascaraG":0,"capoteG":0,"pulpaG":0,"mariposaG":0,"cuartosG":0,"cuartillosG":0,"extraLightG":0,"lightG":0,"amarilloG":0,"ambarLightG":0,"ambarG":0,"observaciones":""}
Valores para "punto": zaranda, canal1, aceptado1, rechazado1, aceptado2, rechazado2

Si no podés leer la planilla claramente, respondé: {"tipo":"ERROR","mensaje":"descripción del problema"}`;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Claude API error: ' + err);
  }

  const data = await response.json();
  const texto = data.content[0]?.text || '';
  const clean = texto.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Normaliza variantes de ID de lote: "L 0001", "l-0001", "L0001", "l 1" → "L-0001"
function normalizarLoteId(id) {
  if (!id) return id;
  const s = String(id).toUpperCase().trim().replace(/\s+/g, '-');
  // Si ya tiene formato correcto (L-18, LC-2, L-0001, etc.) devolverlo tal cual
  if (/^LC?-\d+$/.test(s)) return s;
  // Si tiene solo números, asumir lote individual
  const nums = s.replace(/[^0-9]/g, '');
  if (!nums) return s;
  // Detectar si es LC
  if (s.includes('LC') || s.includes('C')) return 'LC-' + parseInt(nums);
  return 'L-' + parseInt(nums);
}

// Aliases de variedades: clave en minúsculas → nombre oficial
const VARIEDAD_ALIASES = {
  'mel':   'Mariposa Extra Light',
  'mel/l': 'Mariposa Extra Light / Light',
  'mel/ l':'Mariposa Extra Light / Light',
  'mel /l':'Mariposa Extra Light / Light',
  'mariposa extra light / light': 'Mariposa Extra Light / Light',
  'mariposa extra light/light':   'Mariposa Extra Light / Light',
  'mariposas extra light / light':'Mariposa Extra Light / Light',
  'mariposas extra light/light':  'Mariposa Extra Light / Light',
  'mariposa extra light':         'Mariposa Extra Light',
  'mariposas extra light':        'Mariposa Extra Light',
  'ml':    'Mariposa Light',
  'mariposa light':  'Mariposa Light',
  'mariposas light': 'Mariposa Light',
};

function normalizarVariedad(nombre) {
  if (!nombre) return '';
  const limpio = nombre.trim();
  const clave = limpio.toLowerCase().replace(/\s+/g, ' ');
  // Buscar alias exacto
  if (VARIEDAD_ALIASES[clave]) return VARIEDAD_ALIASES[clave];
  // Capitalizar primera letra de cada palabra
  return limpio.replace(/\b\w/g, c => c.toUpperCase());
}


async function registrarDatosOCR(datos, usuarioNombre) {
  const hoy = new Date().toISOString().split('T')[0];
  const horaAhora = new Date().toTimeString().slice(0, 5);

  if (datos.tipo === 'TURNO') {
    const { fecha, turno, horaInicio, horaFin, kgCascara, variedades, observaciones } = datos;
    const loteId = normalizarLoteId(datos.loteId);
    const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(loteId);
    if (!lote) throw new Error(`Lote ${loteId} no encontrado en el sistema`);
    const pulpaTotal = (variedades || []).reduce((a, v) => a + (parseFloat(v.cantidad || 0) * parseFloat(v.kg || 0)), 0);
    const id = 'T-' + Date.now();
    db.prepare('INSERT INTO turnos (id,lote_id,fecha,turno,hora_inicio,hora_fin,kg_cascara,kg_total,pulpa_total,variedades,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, loteId, fecha || hoy, turno || '', horaInicio || '', horaFin || '', parseFloat(kgCascara) || 0, 0, pulpaTotal, JSON.stringify(variedades || []), usuarioNombre);
    const nota = `[OCR] Turno${turno ? ' "' + turno + '"' : ''}: ${kgCascara} kg → ${pulpaTotal.toFixed(1)} kg pulpa`;
    db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(loteId, new Date().toISOString(), 'produccion', nota, usuarioNombre);
    // Actualizar etapa del lote a produccion si estaba en recepcion
    if (lote.etapa === 'recepcion') {
      db.prepare("UPDATE lotes SET etapa='produccion', fecha_inicio_prod=? WHERE id=?").run(new Date().toISOString().split('T')[0], loteId);
    }
    // actualizar stock
    if (variedades && variedades.length > 0) {
      let stockKey = lote.tipo === 'tercero' && lote.cliente_id ? String(lote.cliente_id) : (lote.tipo === 'propio' ? '__PROPIO__' : null);
      // Si cliente_id es null pero tiene cliente_nombre, buscar el id
      if (!stockKey && lote.tipo === 'tercero' && lote.cliente_nombre) {
        const cli = db.prepare('SELECT id FROM clientes WHERE nombre LIKE ?').get('%' + lote.cliente_nombre.trim() + '%');
        if (cli) { stockKey = String(cli.id); db.prepare('UPDATE lotes SET cliente_id=? WHERE id=?').run(cli.id, loteId); }
      }
      if (stockKey) {
        variedades.forEach(v => {
          const nombre = normalizarVariedad((v.nombre || '').trim());
          const cantidad = parseInt(v.cantidad) || 0;
          const kgUnit = parseFloat(v.kg) || 0;
          if (nombre && cantidad > 0) {
            db.prepare('INSERT INTO stock (stock_key,variedad,cantidad,kg,envase) VALUES (?,?,?,?,?) ON CONFLICT(stock_key,variedad) DO UPDATE SET cantidad=cantidad+excluded.cantidad, kg=kg+excluded.kg, envase=excluded.envase').run(stockKey, nombre, cantidad, cantidad * kgUnit, v.envase || 'caja');
          }
        });
      }
    }
    return `✅ *Turno registrado desde planilla:*\n• Lote: ${loteId}\n• Turno: ${turno || '—'}\n• Kg cáscara: ${kgCascara}\n• Pulpa: ${pulpaTotal.toFixed(1)} kg\n• Variedades: ${(variedades || []).length}`;

  } else if (datos.tipo === 'CALIDAD_FRUTA') {
    const { fecha, hora, bbMuestreados, pesoMuestraTotal, extraLight, light, lightAmbar, ambar, surtidoIndustrial, observaciones } = datos;
    const loteId = normalizarLoteId(datos.loteId);
    const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(loteId);
    if (!lote) throw new Error(`Lote ${loteId} no encontrado en el sistema`);
    const el = parseFloat(extraLight) || 0, li = parseFloat(light) || 0, la = parseFloat(lightAmbar) || 0, am = parseFloat(ambar) || 0, su = parseFloat(surtidoIndustrial) || 0;
    const total = el + li + la + am + su || 1;
    const rend = ((el + li + la + am) / total * 100).toFixed(1);
    db.prepare('INSERT INTO calidad_fruta (lote_id,hora,fecha,bb_muestreados,peso_muestra_total,extra_light,light,light_ambar,ambar,surtido_industrial,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(loteId, hora || horaAhora, fecha || hoy, parseInt(bbMuestreados) || 0, parseFloat(pesoMuestraTotal) || 0, el, li, la, am, su, observaciones || '', usuarioNombre);
    logEvento('calidad_fruta', '[OCR] Calidad fruta ' + loteId + ': rend ' + rend + '%', usuarioNombre, loteId);
    return `✅ *Calidad fruta registrada:*\n• Lote: ${loteId}\n• BB muestreados: ${bbMuestreados}\n• Rendimiento estimado: ${rend}%\n• EL: ${el}g | L: ${li}g | LA: ${la}g | Á: ${am}g`;

  } else if (datos.tipo === 'CALIDAD_PULPA') {
    const d = {...datos, loteId: normalizarLoteId(datos.loteId)};
    const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(d.loteId);
    if (!lote) throw new Error(`Lote ${d.loteId} no encontrado en el sistema`);
    const tf = (d.mariposaG || 0) + (d.cuartosG || 0) + (d.octavosG || 0) + (d.trozosG || 0) + (d.polvoG || 0) || 1;
    const tc = (d.elG || 0) + (d.lightG || 0) + (d.amarilloG || 0) + (d.ambarLightG || 0) + (d.ambarG || 0) || 1;
    const pctCua = (d.cuartosG || 0) / tf * 100, pctOct = (d.octavosG || 0) / tf * 100, pctPolv = (d.polvoG || 0) / tf * 100;
    const pctEL = (d.elG || 0) / tc * 100;
    const pctRL = ((d.resecaLeveG || 0) + (d.manchaLeveG || 0)) / tf * 100;
    let estadoForma = 'OK', estadoColor = 'OK', estadoDefectos = 'OK';
    if (d.variedad === 'Mariposa' && (pctCua > 20 || pctOct > 3 || pctPolv > 0.2)) estadoForma = 'FUERA ESPEC';
    if (d.colorObjetivo === 'EL' && pctEL < 85) estadoColor = 'FUERA ESPEC';
    if (d.colorObjetivo === 'EL-L' && pctEL < 50) estadoColor = 'FUERA ESPEC';
    if (pctRL > 4 || (d.resecaGraveG || 0) / tf * 100 > 2 || (d.manchaGraveG || 0) / tf * 100 > 2 || (d.hongoInactivoG || 0) / tf * 100 > 2 || (d.hongoActivoG || 0) / tf * 100 > 0.2) estadoDefectos = 'FUERA ESPEC';
    const resultado = (estadoForma === 'OK' && estadoColor === 'OK' && estadoDefectos === 'OK') ? 'CONFORME' : 'NO CONFORME';
    db.prepare('INSERT INTO calidad_pulpa (lote_id,hora,fecha,turno,linea,variedad,color_objetivo,peso_muestra,mariposa_g,cuartos_g,octavos_g,trozos_g,polvo_g,el_g,light_g,amarillo_g,ambar_light_g,ambar_g,reseca_leve_g,mancha_leve_g,reseca_grave_g,mancha_grave_g,hongo_inactivo_g,hongo_activo_g,humedad,estado_forma,estado_color,estado_defectos,resultado,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(d.loteId, d.hora || horaAhora, d.fecha || hoy, d.turno || '', d.linea || '', d.variedad || '', d.colorObjetivo || '', d.pesoMuestra || 500, d.mariposaG || 0, d.cuartosG || 0, d.octavosG || 0, d.trozosG || 0, d.polvoG || 0, d.elG || 0, d.lightG || 0, d.amarilloG || 0, d.ambarLightG || 0, d.ambarG || 0, d.resecaLeveG || 0, d.manchaLeveG || 0, d.resecaGraveG || 0, d.manchaGraveG || 0, d.hongoInactivoG || 0, d.hongoActivoG || 0, d.humedad || 0, estadoForma, estadoColor, estadoDefectos, resultado, d.observaciones || '', usuarioNombre);
    logEvento('calidad_pulpa', '[OCR] Calidad pulpa ' + d.loteId + ': ' + resultado, usuarioNombre, d.loteId);
    return `✅ *Calidad pulpa registrada:*\n• Lote: ${d.loteId}\n• Resultado: *${resultado}*\n• Forma: ${estadoForma} | Color: ${estadoColor}\n• Defectos: ${estadoDefectos}`;


  } else if (datos.tipo === 'INGRESO_LOTE') {
    const { fecha, tipoLote, cliente, producto, variedad, origen, productor, observaciones, bigBags } = datos;
    // Validar cliente si es tercero
    let clienteId = null;
    let clienteNombre = cliente || '';
    if (tipoLote === 'tercero' && cliente) {
      const clienteRow = db.prepare("SELECT * FROM clientes WHERE nombre LIKE ?").get('%' + cliente.trim() + '%');
      if (!clienteRow) throw new Error('Cliente "' + cliente + '" no encontrado en el sistema. Debe estar cargado previamente.');
      clienteId = clienteRow.id;
      clienteNombre = clienteRow.nombre;
    }
    // Calcular peso total sumando los BBs con kg completado
    const bbsValidos = (bigBags || []).filter(b => b.kg && parseFloat(b.kg) > 0);
    const pesoTotal = bbsValidos.reduce((a, b) => a + parseFloat(b.kg || 0), 0);
    // Generar ID de lote con el nuevo formato
    const loteId = nextLoteId();
    // Insertar lote
    const bigBagsData = bbsValidos.map((b, i) => ({ num: i + 1, codigo: b.codigo, kg: parseFloat(b.kg) }));
    db.prepare('INSERT INTO lotes (id,tipo,producto,variedad,peso_ingreso,peso_actual,fecha,origen,obs,cliente_id,cliente_nombre,productor,etapa,big_bags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(loteId, tipoLote || 'propio', producto || '', variedad || '', pesoTotal, pesoTotal, fecha || hoy, origen || '', observaciones || '', clienteId, clienteNombre || null, productor || '', 'recepcion', JSON.stringify(bigBagsData));
    db.prepare('INSERT OR IGNORE INTO ingresos (lote_id,fecha_ingreso,tipo,producto,variedad,peso_ingreso,big_bags,cliente_id,cliente_nombre,productor,origen,obs,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(loteId, fecha || hoy, tipoLote || 'propio', producto || '', variedad || '', pesoTotal, JSON.stringify(bigBagsData), clienteId, clienteNombre || null, productor || '', origen || '', observaciones || '', usuarioNombre);
    const nota = '[OCR] Ingreso: ' + bbsValidos.length + ' BB, ' + pesoTotal.toFixed(1) + ' kg — Registrado por ' + usuarioNombre;
    db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(loteId, new Date().toISOString(), 'recepcion', nota, usuarioNombre);
    logEvento('lote', '[OCR] Ingreso lote ' + loteId + ': ' + bbsValidos.length + ' BB, ' + pesoTotal.toFixed(0) + ' kg', usuarioNombre, loteId);
    return '✅ *Lote ingresado correctamente*\n\n' +
      '🏷️ *Número asignado: ' + loteId + '*\n' +
      '👉 _Anotá este número en la planilla física._\n\n' +
      '• Tipo: ' + (tipoLote || 'propio') + (clienteNombre ? ' — ' + clienteNombre : '') + '\n' +
      '• Producto: ' + (producto || '—') + (variedad ? ' · ' + variedad : '') + '\n' +
      '• Big Bags: ' + bbsValidos.length + '\n' +
      '• Peso total: ' + pesoTotal.toFixed(1) + ' kg';

  } else if (datos.tipo === 'CONTROL_PROCESO') {
    const { punto, fecha, hora, turno, pesoMuestra, cascaraG, capoteG, pulpaG, mariposaG, cuartosG, cuartillosG, extraLightG, lightG, amarilloG, ambarLightG, ambarG, observaciones } = datos;
    if (!punto || !fecha) throw new Error('Faltan datos de punto o fecha en el control de proceso');

    const colores = { 'Extra Light': extraLightG||0, 'Light': lightG||0, 'Amarillo': amarilloG||0, 'Ámbar Light': ambarLightG||0, 'Ámbar': ambarG||0 };
    const subpulpa = punto === 'zaranda1' ? { mariposas: mariposaG||0, cuartos: cuartosG||0, cuartillos: cuartillosG||0 } : null;

    db.prepare(`INSERT INTO control_proceso (punto,fecha,hora,turno,peso_muestra,cascara_g,capote_g,pulpa_g,colores,subpulpa,observaciones,usuario)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(punto, fecha, hora||'', turno||'', pesoMuestra||null, cascaraG||0, capoteG||0, pulpaG||null,
        JSON.stringify(colores), subpulpa ? JSON.stringify(subpulpa) : null, observaciones||'', usuarioNombre);

    const puntoLabel = {zaranda1:'Zaranda 1',canal1:'Canal 1',aceptado1:'Aceptado 1',rechazado1:'Rechazado 1',aceptado2:'Aceptado 2',rechazado2:'Rechazado 2'}[punto]||punto;
    return `✅ *Control de proceso registrado:*\n• Punto: ${puntoLabel}\n• Fecha: ${fecha} ${hora||''}\n• Turno: ${turno||'—'}\n• Cáscara: ${cascaraG||0} gr · Capote: ${capoteG||0} gr${pulpaG?` · Pulpa: ${pulpaG} gr`:''}`;

  }

  throw new Error('Tipo de planilla no reconocido');
}

// ── Base de datos ──────────────────────────────────────────────────────────────
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'galpon.db');
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Crear tablas ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nombre TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'encargado',
    creado TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    contacto TEXT,
    localidad TEXT,
    creado TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lotes (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL,
    producto TEXT NOT NULL,
    variedad TEXT,
    peso_ingreso REAL DEFAULT 0,
    peso_actual REAL DEFAULT 0,
    fecha TEXT NOT NULL,
    origen TEXT,
    obs TEXT,
    cliente_id INTEGER,
    cliente_nombre TEXT,
    productor TEXT,
    etapa TEXT DEFAULT 'recepcion',
    finalizado INTEGER DEFAULT 0,
    fusionado INTEGER DEFAULT 0,
    fusionado_en TEXT,
    fusion_origen TEXT,
    envases_devueltos INTEGER DEFAULT 0,
    fecha_inicio_prod TEXT,
    big_bags TEXT DEFAULT '[]',
    creado TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
  );

  CREATE TABLE IF NOT EXISTS historia_lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id TEXT NOT NULL,
    fecha TEXT NOT NULL,
    etapa TEXT,
    nota TEXT,
    usuario TEXT,
    FOREIGN KEY (lote_id) REFERENCES lotes(id)
  );

  CREATE TABLE IF NOT EXISTS turnos (
    id TEXT PRIMARY KEY,
    lote_id TEXT NOT NULL,
    fecha TEXT NOT NULL,
    turno TEXT,
    hora_inicio TEXT,
    hora_fin TEXT,
    kg_cascara REAL DEFAULT 0,
    kg_total REAL DEFAULT 0,
    pulpa_total REAL DEFAULT 0,
    variedades TEXT DEFAULT '[]',
    usuario TEXT,
    creado TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lote_id) REFERENCES lotes(id)
  );

  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_key TEXT NOT NULL,
    variedad TEXT NOT NULL,
    cantidad INTEGER DEFAULT 0,
    kg REAL DEFAULT 0,
    envase TEXT,
    UNIQUE(stock_key, variedad)
  );

  CREATE TABLE IF NOT EXISTS despachos (
    id TEXT PRIMARY KEY,
    stock_key TEXT NOT NULL,
    cliente_id TEXT,
    cliente_nombre TEXT,
    es_propio INTEGER DEFAULT 0,
    fecha TEXT NOT NULL,
    lineas TEXT DEFAULT '[]',
    transp TEXT,
    obs TEXT,
    kg_total REAL DEFAULT 0,
    usuario TEXT,
    creado TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS variedades (
    nombre TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS devoluciones_bb (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    obs TEXT,
    usuario TEXT,
    creado TEXT DEFAULT (datetime('now'))
  );

`);

// ── Migraciones (columnas nuevas si no existen) ───────────────────────────────

// Crear tablas de calidad si no existen
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calidad_fruta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id TEXT NOT NULL,
      fecha TEXT NOT NULL,
      bb_muestreados INTEGER DEFAULT 0,
      extra_light REAL DEFAULT 0,
      light REAL DEFAULT 0,
      light_ambar REAL DEFAULT 0,
      ambar REAL DEFAULT 0,
      surtido_industrial REAL DEFAULT 0,
      observaciones TEXT,
      usuario TEXT,
      creado TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS calidad_pulpa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lote_id TEXT NOT NULL,
      fecha TEXT NOT NULL,
      turno TEXT,
      linea TEXT,
      variedad TEXT,
      color_objetivo TEXT,
      peso_muestra REAL DEFAULT 500,
      mariposa_g REAL DEFAULT 0,
      cuartos_g REAL DEFAULT 0,
      octavos_g REAL DEFAULT 0,
      trozos_g REAL DEFAULT 0,
      polvo_g REAL DEFAULT 0,
      el_g REAL DEFAULT 0,
      light_g REAL DEFAULT 0,
      amarillo_g REAL DEFAULT 0,
      ambar_light_g REAL DEFAULT 0,
      ambar_g REAL DEFAULT 0,
      reseca_leve_g REAL DEFAULT 0,
      mancha_leve_g REAL DEFAULT 0,
      reseca_grave_g REAL DEFAULT 0,
      mancha_grave_g REAL DEFAULT 0,
      hongo_inactivo_g REAL DEFAULT 0,
      hongo_activo_g REAL DEFAULT 0,
      humedad REAL DEFAULT 0,
      estado_forma TEXT,
      estado_color TEXT,
      estado_defectos TEXT,
      resultado TEXT,
      observaciones TEXT,
      usuario TEXT,
      creado TEXT DEFAULT (datetime('now'))
    );
  `);
} catch(e) { console.log('Tablas calidad:', e.message); }

try { db.exec("ALTER TABLE lotes ADD COLUMN bb_devueltos INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE usuarios ADD COLUMN whatsapp TEXT DEFAULT ''"); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS mantenimiento (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maquina TEXT NOT NULL,
  nivel TEXT NOT NULL DEFAULT 'atencion',
  descripcion TEXT NOT NULL,
  usuario TEXT NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  resuelto INTEGER DEFAULT 0,
  solucion TEXT DEFAULT '',
  usuario_resolucion TEXT DEFAULT '',
  fecha_resolucion TEXT DEFAULT '',
  hora_resolucion TEXT DEFAULT '',
  creado TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
// Tabla de eventos globales
try { db.exec(`CREATE TABLE IF NOT EXISTS eventos_globales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  usuario TEXT NOT NULL,
  lote_id TEXT DEFAULT '',
  fecha TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS ingresos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id TEXT NOT NULL UNIQUE,
  fecha_ingreso TEXT NOT NULL,
  tipo TEXT NOT NULL,
  producto TEXT NOT NULL,
  variedad TEXT DEFAULT '',
  peso_ingreso REAL DEFAULT 0,
  big_bags TEXT DEFAULT '[]',
  cliente_id TEXT DEFAULT NULL,
  cliente_nombre TEXT DEFAULT NULL,
  productor TEXT DEFAULT '',
  origen TEXT DEFAULT '',
  obs TEXT DEFAULT '',
  usuario TEXT NOT NULL,
  creado TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS control_proceso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  punto TEXT NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT DEFAULT '',
  turno TEXT DEFAULT '',
  lote_id TEXT DEFAULT '',
  peso_muestra REAL DEFAULT NULL,
  cascara_g REAL DEFAULT 0,
  capote_g REAL DEFAULT 0,
  pulpa_g REAL DEFAULT NULL,
  colores TEXT DEFAULT NULL,
  subpulpa TEXT DEFAULT NULL,
  observaciones TEXT DEFAULT '',
  usuario TEXT NOT NULL,
  creado TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}

try { db.exec(`CREATE TABLE IF NOT EXISTS reg_maquina (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  eq1_tolva TEXT DEFAULT '',
  eq1_elevador TEXT DEFAULT '',
  eq1_conos TEXT DEFAULT '',
  eq1_aspirador TEXT DEFAULT '',
  eq2_tolva TEXT DEFAULT '',
  eq2_elevador TEXT DEFAULT '',
  eq2_conos TEXT DEFAULT '',
  eq2_aspirador TEXT DEFAULT '',
  megavac_aspirador TEXT DEFAULT '',
  megavac_soplador TEXT DEFAULT '',
  observaciones TEXT DEFAULT '',
  usuario TEXT,
  creado TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS reg_selectora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lote_id TEXT NOT NULL,
  fecha TEXT NOT NULL,
  canal1_json TEXT DEFAULT '[]',
  canal2_json TEXT DEFAULT '[]',
  observaciones TEXT DEFAULT '',
  usuario TEXT,
  creado TEXT DEFAULT (datetime('now'))
)`); } catch(e) {}
// tabla calidad creada en el CREATE IF NOT EXISTS arriba

// ── Insertar usuario CEO por defecto si no existe ──────────────────────────────
try{db.prepare("ALTER TABLE calidad_fruta ADD COLUMN hora TEXT DEFAULT ''").run();}catch(e){}
try{db.prepare("ALTER TABLE control_proceso ADD COLUMN lote_id TEXT DEFAULT ''").run();}catch(e){}
try{db.prepare("ALTER TABLE calidad_fruta ADD COLUMN peso_muestra_total REAL DEFAULT 0").run();}catch(e){}
try{db.prepare("ALTER TABLE calidad_pulpa ADD COLUMN hora TEXT DEFAULT ''").run();}catch(e){}
const ceoExiste = db.prepare('SELECT id FROM usuarios WHERE rol = ?').get('ceo');
if (!ceoExiste) {
  const hash = bcrypt.hashSync(process.env.CEO_PASSWORD || 'ceo123', 10);
  db.prepare('INSERT OR IGNORE INTO usuarios (username, password, nombre, rol) VALUES (?, ?, ?, ?)').run('ceo', hash, 'CEO', 'ceo');
  console.log('✅ Usuario CEO creado: ceo / ceo123');
  if(process.env.CEO_WHATSAPP){db.prepare("UPDATE usuarios SET whatsapp=? WHERE username='ceo'").run(process.env.CEO_WHATSAPP);}
}

// Siempre asegurar whatsapp del CEO
if(process.env.CEO_WHATSAPP){db.prepare("UPDATE usuarios SET whatsapp=? WHERE username='ceo' AND (whatsapp IS NULL OR whatsapp='')").run(process.env.CEO_WHATSAPP);}
console.log("✅ WhatsApp CEO verificado");

// Usuario reportes (padre)
const padreExiste = db.prepare("SELECT id FROM usuarios WHERE username='padre'").get();
if (!padreExiste) {
  const hashPadre = bcrypt.hashSync("padre123", 10);
  db.prepare("INSERT OR IGNORE INTO usuarios (username, password, nombre, rol, whatsapp) VALUES (?, ?, ?, ?, ?)").run("padre", hashPadre, "Papa", "reportes", "5491123055070");
  console.log("✅ Usuario padre creado con rol reportes");
}
// Siempre asegurar whatsapp correcto del padre
db.prepare("UPDATE usuarios SET whatsapp='5491123055070' WHERE username='padre'").run();

// ── Insertar variedades por defecto ────────────────────────────────────────────
const varDefecto = ['Mariposa Extra Light','Mariposa Extra Light / Light','Mariposa Light','Cuartos','Octavos','Trozos','Surtido Industrial','Mitades'];
varDefecto.forEach(v => db.prepare('INSERT OR IGNORE INTO variedades (nombre) VALUES (?)').run(v));

// ── Insertar config de permisos por defecto ────────────────────────────────────
const permDefecto = {
  ceo:          { secs:['dash','nuevo','lotes','turno','fusion','stock','despachos','bigbags','calidad','regulacion','mantenimiento','clientes'], canEdit:true, canDelete:true, canFinalize:true, canFusion:true, canReasignar:true, canResolverMant:true, canBorrarMant:true },
  reportes:     { secs:['lotes','stock','despachos','bigbags','calidad','mantenimiento'], canEdit:false, canDelete:false, canFinalize:false, canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false },
  admin:        { secs:['dash','nuevo','lotes','turno','fusion','stock','despachos','bigbags','clientes'], canEdit:false, canDelete:false, canFinalize:true,  canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false },
  encargado:    { secs:['lotes','turno'],                                                                  canEdit:false, canDelete:false, canFinalize:false, canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false },
  maquinista:   { secs:['lotes'],                                                                          canEdit:false, canDelete:false, canFinalize:false, canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false },
  calidad:      { secs:['calidad'],                                                                        canEdit:false, canDelete:false, canFinalize:false, canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false },
  mantenimiento:{ secs:['mantenimiento'],                                                                  canEdit:false, canDelete:false, canFinalize:false, canFusion:false, canReasignar:false, canResolverMant:false, canBorrarMant:false }
};
Object.entries(permDefecto).forEach(([rol, val]) => {
  db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run('perm_'+rol, JSON.stringify(val));
});

// ── Contador de lotes ──────────────────────────────────────────────────────────
db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run('lote_counter', '0');
db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run('despacho_counter', '0');
db.prepare('INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)').run('lc_counter', '0');
// Garantizar que lc_counter existe aunque la DB sea antigua
db.prepare("INSERT OR IGNORE INTO config (clave, valor) VALUES ('lc_counter', '0')").run();

// Migrar lotes individuales existentes a tabla ingresos (solo si no están ya)
try {
  const lotesExistentes = db.prepare("SELECT * FROM lotes WHERE fusion_origen IS NULL AND id NOT LIKE 'LC-%'").all();
  const stmtIng = db.prepare(`INSERT OR IGNORE INTO ingresos (lote_id,fecha_ingreso,tipo,producto,variedad,peso_ingreso,big_bags,cliente_id,cliente_nombre,productor,origen,obs,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  lotesExistentes.forEach(l => {
    stmtIng.run(l.id, l.fecha, l.tipo, l.producto, l.variedad||'', l.peso_ingreso||0, l.big_bags||'[]', l.cliente_id||null, l.cliente_nombre||null, l.productor||'', l.origen||'', l.obs||'', 'sistema');
  });
} catch(e) { console.error('Migración ingresos:', e.message); }

// Corregir hijos de LC que quedaron con etapa/estado incorrecto
try {
  const consolidadores = db.prepare("SELECT * FROM lotes WHERE fusion_origen IS NOT NULL").all();
  consolidadores.forEach(c => {
    const hijos = JSON.parse(c.fusion_origen || '[]');
    hijos.forEach(hijoId => {
      const hijo = db.prepare('SELECT * FROM lotes WHERE id=?').get(hijoId);
      if (!hijo) return;
      // Si el hijo no tiene fusionado_en seteado, corregirlo
      if (!hijo.fusionado_en) {
        db.prepare("UPDATE lotes SET fusionado_en=?, etapa='produccion' WHERE id=?").run(c.id, hijoId);
        console.log(`✅ Fix: Lote ${hijoId} corregido como hijo de ${c.id}`);
      }
    });
  });
} catch(e) { console.error('Migración hijos LC:', e.message); }

// ── Middleware ─────────────────────────────────────────────────────────────────
app.set('etag', false);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}
function onlyCeo(req, res, next) {
  if (req.user?.rol !== 'ceo') return res.status(403).json({ error: 'Solo el CEO puede hacer esto' });
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS AUTH
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = jwt.sign({ id: user.id, username: user.username, nombre: user.nombre, rol: user.rol }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS USUARIOS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/usuarios', auth, onlyCeo, (req, res) => {
  const rows = db.prepare('SELECT id, username, nombre, rol, whatsapp, creado FROM usuarios ORDER BY id').all();
  res.json(rows);
});
app.post('/api/usuarios', auth, onlyCeo, (req, res) => {
  const { username, password, nombre, rol, whatsapp, canResolverMant, canBorrarMant } = req.body;
  if (!username || !password || !nombre || !rol) return res.status(400).json({ error: 'Faltan datos' });
  if (password.length < 4) return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });
  const rolesValidos = ['admin','encargado','maquinista','calidad','mantenimiento','reportes'];
  if (!rolesValidos.includes(rol)) return res.status(400).json({ error: 'Rol inválido' });
  const existe = db.prepare('SELECT id FROM usuarios WHERE username = ?').get(username.toLowerCase());
  if (existe) return res.status(400).json({ error: 'Ese usuario ya existe' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO usuarios (username, password, nombre, rol, whatsapp) VALUES (?, ?, ?, ?, ?)').run(username.toLowerCase(), hash, nombre, rol, whatsapp||'');
  // Actualizar permisos especiales si se enviaron
  if (canResolverMant !== undefined || canBorrarMant !== undefined) {
    const cfg = db.prepare("SELECT valor FROM config WHERE clave = ?").get('perm_'+rol);
    if (cfg) {
      const perms = JSON.parse(cfg.valor);
      if (canResolverMant !== undefined) perms.canResolverMant = !!canResolverMant;
      if (canBorrarMant !== undefined) perms.canBorrarMant = !!canBorrarMant;
      db.prepare("UPDATE config SET valor=? WHERE clave=?").run(JSON.stringify(perms), 'perm_'+rol);
    }
  }
  // Enviar WhatsApp de bienvenida si tiene numero registrado
  if (whatsapp) {
    const bienvenida = '👋 Hola ' + nombre + '!\n\nFuiste registrado en el sistema de gestión del galpón.\n\n📋 *Tus datos de acceso:*\n• Usuario: ' + username.toLowerCase() + '\n• Contraseña: ' + password + '\n• Rol: ' + rol + '\n\nPodés ingresar desde:\n🌐 Consultá la URL con el administrador\n\nO escribí *menu* acá para usar el bot de WhatsApp. 🤖';
    console.log("📤 Enviando bienvenida a", whatsapp); sendMetaMessage(whatsapp, bienvenida).catch(e => console.error('Error WA bienvenida:', e.message));
  }
  res.json({ id: info.lastInsertRowid, username: username.toLowerCase(), nombre, rol });
});
app.put('/api/usuarios/:id', auth, onlyCeo, (req, res) => {
  const { nombre, whatsapp, password } = req.body;
  const u = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (nombre) db.prepare('UPDATE usuarios SET nombre=? WHERE id=?').run(nombre, req.params.id);
  if (whatsapp !== undefined) db.prepare('UPDATE usuarios SET whatsapp=? WHERE id=?').run(whatsapp||'', req.params.id);
  if (password && password.length >= 4) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE usuarios SET password=? WHERE id=?').run(hash, req.params.id);
  }
  res.json({ ok: true });
});
app.delete('/api/usuarios/:id', auth, onlyCeo, (req, res) => {
  const u = db.prepare('SELECT rol FROM usuarios WHERE id = ?').get(req.params.id);
  if (!u || u.rol === 'ceo') return res.status(400).json({ error: 'No se puede eliminar el CEO' });
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS PERMISOS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/permisos', auth, (req, res) => {
  const rows = db.prepare("SELECT clave, valor FROM config WHERE clave LIKE 'perm_%'").all();
  const result = {};
  rows.forEach(r => { result[r.clave.replace('perm_', '')] = JSON.parse(r.valor); });
  res.json(result);
});
app.put('/api/permisos/:rol', auth, onlyCeo, (req, res) => {
  const { rol } = req.params;
  if (rol === 'ceo') return res.status(400).json({ error: 'No se puede modificar el CEO' });
  db.prepare('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)').run('perm_'+rol, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS CLIENTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/clientes', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM clientes ORDER BY nombre').all());
});
app.post('/api/clientes', auth, (req, res) => {
  const { nombre, contacto, localidad } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
  const info = db.prepare('INSERT INTO clientes (nombre, contacto, localidad) VALUES (?, ?, ?)').run(nombre, contacto||'', localidad||'');
  res.json({ id: info.lastInsertRowid, nombre, contacto, localidad });
});
app.put('/api/clientes/:id', auth, (req, res) => {
  const { nombre, contacto, localidad } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
  db.prepare('UPDATE clientes SET nombre=?, contacto=?, localidad=? WHERE id=?').run(nombre, contacto||'', localidad||'', req.params.id);
  res.json({ ok: true, id: parseInt(req.params.id), nombre, contacto, localidad });
});
app.delete('/api/clientes/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Solo el CEO puede borrar clientes' });
  db.prepare('DELETE FROM clientes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS VARIEDADES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/variedades', auth, (req, res) => {
  res.json(db.prepare('SELECT nombre FROM variedades ORDER BY nombre').all().map(r => r.nombre));
});
app.post('/api/variedades', auth, (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  db.prepare('INSERT OR IGNORE INTO variedades (nombre) VALUES (?)').run(nombre);
  res.json({ ok: true });
});

// ── Control de proceso ─────────────────────────────────────────────────────────
app.get('/api/control-proceso', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM control_proceso ORDER BY creado DESC LIMIT 200').all();
  res.json(rows.map(r => ({
    ...r,
    colores: r.colores ? JSON.parse(r.colores) : null,
    subpulpa: r.subpulpa ? JSON.parse(r.subpulpa) : null
  })));
});

app.post('/api/control-proceso', auth, (req, res) => {
  const { punto, fecha, hora, turno, lote_id, peso_muestra, cascara_g, capote_g, pulpa_g, colores, subpulpa, observaciones } = req.body;
  if (!punto || !fecha) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  const result = db.prepare(`INSERT INTO control_proceso (punto,fecha,hora,turno,peso_muestra,cascara_g,capote_g,pulpa_g,colores,subpulpa,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(punto, fecha, hora||'', turno||'', peso_muestra??null, cascara_g||0, capote_g||0, pulpa_g??null, colores?JSON.stringify(colores):null, subpulpa?JSON.stringify(subpulpa):null, observaciones||'', req.user.nombre);
  // Guardar lote_id si se envió (columna existe como lote_id en control_proceso, si no existe la agregamos)
  if (lote_id) {
    try { db.prepare("UPDATE control_proceso SET lote_id=? WHERE id=?").run(lote_id, result.lastInsertRowid); } catch(e) {}
  }
  logEvento('lote', `Control de proceso — ${punto} — ${fecha}${lote_id?' — '+lote_id:''}`, req.user.nombre, lote_id||null);

  // WhatsApp al CEO si es zaranda
  if (punto === 'zaranda' && subpulpa) {
    try {
      const ceo = db.prepare("SELECT whatsapp FROM usuarios WHERE rol='ceo' AND whatsapp != ''").get();
      if (ceo) {
        const sp = typeof subpulpa === 'string' ? JSON.parse(subpulpa) : subpulpa;
        const pct = (v, base) => base > 0 ? (v / base * 100).toFixed(1) + '%' : '—';
        const fmt = (z, label) => {
          if (!z || !z.peso_muestra) return '';
          const pm = z.peso_muestra || 0;
          const pulpa = z.pulpa_g || 0;
          return `\n*${label}* (muestra: ${pm} gr)\n` +
            `  Cáscara: ${z.cascara_g||0} gr (${pct(z.cascara_g||0, pm)})\n` +
            `  Capote: ${z.capote_g||0} gr (${pct(z.capote_g||0, pm)})\n` +
            `  Pulpa: ${pulpa} gr (${pct(pulpa, pm)})\n` +
            `  ↳ Mariposas: ${pct(z.subpulpa?.mariposas||0, pulpa)} | Cuartos: ${pct(z.subpulpa?.cuartos||0, pulpa)} | Cuartillos: ${pct(z.subpulpa?.cuartillos||0, pulpa)}`;
        };
        const msg =
          `🔬 *Control Zaranda — ${fecha} ${hora||''} · ${turno||''}*\n` +
          (lote_id ? `Lote: *${lote_id}*\n` : '') +
          `Operario: ${req.user.nombre}` +
          fmt(sp.z1, 'Zaranda 1') +
          fmt(sp.z2, 'Zaranda 2') +
          (observaciones ? `\n📝 ${observaciones}` : '');
        sendMetaMessage(ceo.whatsapp, msg).catch(e => console.error('WA zaranda:', e.message));
      }
    } catch(e) { console.error('Error WA zaranda:', e.message); }
  }

  // WhatsApp al CEO si es canal/aceptado/rechazado con colores
  if (['canal1','aceptado1','rechazado1','aceptado2','rechazado2'].includes(punto) && colores) {
    try {
      const ceo = db.prepare("SELECT whatsapp FROM usuarios WHERE rol='ceo' AND whatsapp != ''").get();
      if (ceo) {
        const col = typeof colores === 'string' ? JSON.parse(colores) : colores;
        const pm = peso_muestra || 0;
        const casc = cascara_g || 0;
        const cap = capote_g || 0;
        const pulpa = pm - casc - cap;
        const pct = (v, base) => base > 0 ? (v/base*100).toFixed(1)+'%' : '—';
        const totalColores = Object.values(col).reduce((a,v)=>a+(v||0),0);
        const puntoLabel = {canal1:'Canal 1',aceptado1:'Aceptado 1',rechazado1:'Rechazado 1',aceptado2:'Aceptado 2',rechazado2:'Rechazado 2'}[punto]||punto;
        let msgCol = Object.entries(col).map(([c,v])=>`  ${c}: ${v||0}gr (${pct(v||0,totalColores)})`).join('\n');
        const msg =
          `🔬 *Control ${puntoLabel} — ${fecha} ${hora||''} · ${turno||''}*\n` +
          (lote_id ? `Lote: *${lote_id}*\n` : '') +
          `Operario: ${req.user.nombre}\n` +
          `\n*Datos del proceso* (muestra: ${pm}gr)\n` +
          `  Cáscara: ${casc}gr (${pct(casc,pm)})\n` +
          `  Capote: ${cap}gr (${pct(cap,pm)})\n` +
          `  Pulpa: ${Math.max(0,pulpa).toFixed(0)}gr (${pct(Math.max(0,pulpa),pm)})\n` +
          (totalColores > 0 ? `\n*Colores de pulpa:*\n${msgCol}` : '') +
          (observaciones ? `\n📝 ${observaciones}` : '');
        sendMetaMessage(ceo.whatsapp, msg).catch(e => console.error('WA canal:', e.message));
      }
    } catch(e) { console.error('Error WA canal:', e.message); }
  }

  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/control-proceso/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Solo CEO' });
  db.prepare('DELETE FROM control_proceso WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});


app.get('/api/lotes/:id/calidad-consolidada', auth, (req, res) => {
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!lote || !lote.fusion_origen) return res.status(400).json({ error: 'No es un consolidador' });
  const hijos = JSON.parse(lote.fusion_origen || '[]');
  const placeholders = hijos.map(() => '?').join(',');
  const fruta = hijos.length
    ? db.prepare(`SELECT * FROM calidad_fruta WHERE lote_id IN (${placeholders}) ORDER BY fecha DESC, id DESC`).all(...hijos)
    : [];
  const pulpa = hijos.length
    ? db.prepare(`SELECT * FROM calidad_pulpa WHERE lote_id IN (${placeholders}) ORDER BY fecha DESC, id DESC`).all(...hijos)
    : [];
  res.json({ fruta, pulpa });
});

// ── Registro de ingresos (inmutable) ──────────────────────────────────────────
app.get('/api/ingresos', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM ingresos ORDER BY creado DESC').all();
  res.json(rows.map(r => ({
    ...r,
    bigBags: JSON.parse(r.big_bags || '[]'),
    pesoIngreso: r.peso_ingreso,
    clienteId: r.cliente_id,
    clienteNombre: r.cliente_nombre,
    fechaIngreso: r.fecha_ingreso
  })));
});

app.put('/api/ingresos/:loteId', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Sin permisos' });
  const { fecha, tipo, clienteNombre, productor, producto, variedad, bigBags, pesoIngreso } = req.body;
  const loteId = req.params.loteId;
  // Actualizar tabla ingresos
  db.prepare(`UPDATE ingresos SET fecha_ingreso=?,tipo=?,cliente_nombre=?,productor=?,producto=?,variedad=?,big_bags=?,peso_ingreso=? WHERE lote_id=?`)
    .run(fecha, tipo, clienteNombre||null, productor||null, producto, variedad||'', JSON.stringify(bigBags||[]), pesoIngreso||0, loteId);
  // Actualizar también la tabla lotes para mantener sincronía
  db.prepare(`UPDATE lotes SET fecha=?,tipo=?,cliente_nombre=?,productor=?,producto=?,variedad=?,big_bags=?,peso_ingreso=?,peso_actual=? WHERE id=?`)
    .run(fecha, tipo, clienteNombre||null, productor||null, producto, variedad||'', JSON.stringify(bigBags||[]), pesoIngreso||0, pesoIngreso||0, loteId);
  logEvento('lote', `Ingreso ${loteId} editado por CEO`, req.user.nombre, loteId);
  res.json({ ok: true });
});

app.delete('/api/ingresos/:loteId', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Sin permisos' });
  const loteId = req.params.loteId;
  db.prepare('DELETE FROM ingresos WHERE lote_id=?').run(loteId);
  logEvento('lote', `Ingreso ${loteId} eliminado por CEO`, req.user.nombre, loteId);
  res.json({ ok: true });
});


function nextLoteId() {
  const c = parseInt(db.prepare("SELECT valor FROM config WHERE clave = 'lote_counter'").get().valor) + 1;
  db.prepare("UPDATE config SET valor = ? WHERE clave = 'lote_counter'").run(String(c));
  return 'L-' + String(c);
}
function nextLcId() {
  db.prepare("INSERT OR IGNORE INTO config (clave, valor) VALUES ('lc_counter', '0')").run();
  const row = db.prepare("SELECT valor FROM config WHERE clave = 'lc_counter'").get();
  const c = parseInt(row ? row.valor : '0') + 1;
  db.prepare("INSERT OR REPLACE INTO config (clave, valor) VALUES ('lc_counter', ?)").run(String(c));
  return 'LC-' + String(c);
}
function nextDespId() {
  const c = parseInt(db.prepare("SELECT valor FROM config WHERE clave = 'despacho_counter'").get().valor) + 1;
  db.prepare("UPDATE config SET valor = ? WHERE clave = 'despacho_counter'").run(String(c));
  return 'D-' + String(c);
}
function loteConHistoria(row) {
  if (!row) return null;
  const historia = db.prepare('SELECT * FROM historia_lotes WHERE lote_id = ? ORDER BY fecha').all(row.id);
  const fusionOrigen = row.fusion_origen ? JSON.parse(row.fusion_origen) : null;
  return {
    ...row,
    bigBags: JSON.parse(row.big_bags || '[]'),
    fusionOrigen,
    esConsolidador: (Array.isArray(fusionOrigen) && fusionOrigen.length > 0) || !!(row.id && row.id.startsWith('LC-')),
    historia: historia.map(h => ({ fecha: h.fecha, etapa: h.etapa, nota: h.nota, user: h.usuario })),
    finalizado: !!row.finalizado, fusionado: !!row.fusionado, envasesDevueltos: !!row.envases_devueltos,
    pesoIngreso: row.peso_ingreso, pesoActual: row.peso_actual, clienteId: row.cliente_id ? String(row.cliente_id) : null,
    clienteNombre: row.cliente_nombre, fechaInicioProd: row.fecha_inicio_prod, fusionadoEn: row.fusionado_en,
    bbDevueltos: row.bb_devueltos || 0
  };
}

app.get('/api/lotes', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM lotes ORDER BY creado DESC').all();
  res.json(rows.map(loteConHistoria));
});
app.get('/api/lotes/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No encontrado' });
  res.json(loteConHistoria(row));
});
app.post('/api/lotes', auth, (req, res) => {
  const { tipo, producto, variedad, pesoIngreso, fecha, origen, obs, clienteId, clienteNombre, productor, bigBags, etapa, fusionOrigen } = req.body;
  if (!fecha || !tipo || !producto) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  const esCons = Array.isArray(fusionOrigen) && fusionOrigen.length > 0;
  const id = esCons ? nextLcId() : nextLoteId();
  const etapaInicial = etapa || 'recepcion';
  const nota = esCons
    ? `Lote consolidador creado — agrupa: ${fusionOrigen.join(', ')} — por ${req.user.nombre}`
    : `${bigBags?.length||0} BB, ${pesoIngreso?.toFixed(1)||0} kg — Registrado por ${req.user.nombre}`;
  db.prepare(`INSERT INTO lotes (id,tipo,producto,variedad,peso_ingreso,peso_actual,fecha,origen,obs,cliente_id,cliente_nombre,productor,etapa,big_bags,fusion_origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,tipo,producto,variedad||'',pesoIngreso||0,pesoIngreso||0,fecha,origen||'',obs||'',clienteId||null,clienteNombre||null,productor||'',etapaInicial,JSON.stringify(bigBags||[]),fusionOrigen?JSON.stringify(fusionOrigen):null);
  // Registrar ingreso inmutable (solo lotes individuales, no LC)
  if (!esCons) {
    try {
      db.prepare(`INSERT OR IGNORE INTO ingresos (lote_id,fecha_ingreso,tipo,producto,variedad,peso_ingreso,big_bags,cliente_id,cliente_nombre,productor,origen,obs,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, fecha, tipo, producto, variedad||'', pesoIngreso||0, JSON.stringify(bigBags||[]), clienteId||null, clienteNombre||null, productor||'', origen||'', obs||'', req.user.nombre);
    } catch(e) { console.error('Error registrando ingreso:', e.message); }
  }
  db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(id, new Date().toISOString(), etapaInicial, nota, req.user.username);
  logEvento('lote', esCons ? 'Consolidador ' + id + ' creado (' + fusionOrigen.join('+') + ')' : 'Ingreso de lote ' + id + ': ' + (pesoIngreso||0).toFixed(0) + ' kg', req.user.nombre, id);
  res.json(loteConHistoria(db.prepare('SELECT * FROM lotes WHERE id = ?').get(id)));
});
app.put('/api/lotes/:id', auth, (req, res) => {
  const l = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'No encontrado' });
  const { tipo, producto, variedad, fecha, origen, obs, clienteId, clienteNombre, productor, etapa, finalizado, envasesDevueltos, pesoActual, pesoIngreso, bigBags, fusionado, fusionadoEn, fusionOrigen, fechaInicioProd } = req.body;
  db.prepare(`UPDATE lotes SET tipo=COALESCE(?,tipo), producto=COALESCE(?,producto), variedad=COALESCE(?,variedad), fecha=COALESCE(?,fecha), origen=COALESCE(?,origen), obs=COALESCE(?,obs), cliente_id=?, cliente_nombre=COALESCE(?,cliente_nombre), productor=COALESCE(?,productor), etapa=COALESCE(?,etapa), finalizado=COALESCE(?,finalizado), envases_devueltos=COALESCE(?,envases_devueltos), peso_actual=COALESCE(?,peso_actual), peso_ingreso=COALESCE(?,peso_ingreso), big_bags=COALESCE(?,big_bags), fusionado=COALESCE(?,fusionado), fusionado_en=COALESCE(?,fusionado_en), fusion_origen=COALESCE(?,fusion_origen), fecha_inicio_prod=COALESCE(?,fecha_inicio_prod) WHERE id=?`).run(tipo,producto,variedad,fecha,origen,obs,clienteId||null,clienteNombre,productor,etapa,finalizado!=null?+finalizado:null,envasesDevueltos!=null?+envasesDevueltos:null,pesoActual,pesoIngreso,bigBags?JSON.stringify(bigBags):null,fusionado!=null?+fusionado:null,fusionadoEn,fusionOrigen?JSON.stringify(fusionOrigen):null,fechaInicioProd,req.params.id);
  if (req.body.historiaNota) db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(req.params.id, new Date().toISOString(), etapa||l.etapa, req.body.historiaNota, req.user.username);

  // Si se está finalizando un hijo, verificar si el consolidador debe finalizarse también
  if (finalizado === true || finalizado === 1) {
    const consolidador = db.prepare("SELECT * FROM lotes WHERE fusion_origen IS NOT NULL AND finalizado=0").all().find(c => {
      try { return JSON.parse(c.fusion_origen||'[]').includes(req.params.id); } catch(e) { return false; }
    });
    if (consolidador) {
      const hijos = JSON.parse(consolidador.fusion_origen || '[]');
      const todosFinalizados = hijos.every(hId => {
        if (hId === req.params.id) return true; // este acaba de finalizarse
        const h = db.prepare('SELECT finalizado FROM lotes WHERE id=?').get(hId);
        return h && h.finalizado;
      });
      if (todosFinalizados) {
        db.prepare("UPDATE lotes SET finalizado=1, etapa='stock' WHERE id=?").run(consolidador.id);
        db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(consolidador.id, new Date().toISOString(), 'stock', `Finalizado automáticamente — todos los lotes hijos finalizados`, req.user.username);
        logEvento('lote', 'Consolidador ' + consolidador.id + ' finalizado automáticamente', req.user.nombre, consolidador.id);
      }
    }
  }

  res.json(loteConHistoria(db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id)));
});

// ── Agregar hijo a consolidador existente ──────────────────────────────────────
app.post('/api/lotes/:id/agregar-hijo', auth, (req, res) => {
  const consolidador = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!consolidador) return res.status(404).json({ error: 'Consolidador no encontrado' });
  if (!consolidador.fusion_origen) return res.status(400).json({ error: 'Este lote no es un consolidador' });
  const { hijoId } = req.body;
  if (!hijoId) return res.status(400).json({ error: 'Falta hijoId' });
  const hijo = db.prepare('SELECT * FROM lotes WHERE id = ?').get(hijoId);
  if (!hijo) return res.status(404).json({ error: 'Lote hijo no encontrado' });

  const hijos = JSON.parse(consolidador.fusion_origen || '[]');
  if (hijos.includes(hijoId)) return res.status(400).json({ error: 'El lote ya pertenece a este consolidador' });

  // Verificar que el hijo no pertenece a otro consolidador activo
  const otroConsolidador = db.prepare("SELECT * FROM lotes WHERE fusion_origen IS NOT NULL AND finalizado=0").all().find(c => {
    if (c.id === req.params.id) return false;
    try { return JSON.parse(c.fusion_origen||'[]').includes(hijoId); } catch(e) { return false; }
  });
  if (otroConsolidador) return res.status(400).json({ error: `El lote ya pertenece al consolidador ${otroConsolidador.id}` });

  hijos.push(hijoId);
  const nuevoPeso = (consolidador.peso_ingreso || 0) + (hijo.peso_ingreso || 0);
  db.prepare('UPDATE lotes SET fusion_origen=?, peso_ingreso=?, peso_actual=? WHERE id=?').run(JSON.stringify(hijos), nuevoPeso, nuevoPeso, req.params.id);
  // Pasar el hijo a produccion y marcarlo como parte del consolidador
  db.prepare("UPDATE lotes SET etapa='produccion', fusionado_en=? WHERE id=?").run(req.params.id, hijoId);
  db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(req.params.id, new Date().toISOString(), consolidador.etapa, `Lote ${hijoId} agregado al consolidador por ${req.user.nombre}`, req.user.username);
  db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(hijoId, new Date().toISOString(), 'produccion', `Incorporado al consolidador ${req.params.id} — pasó a producción`, req.user.username);
  logEvento('lote', `Lote ${hijoId} agregado al consolidador ${req.params.id}`, req.user.nombre, req.params.id);
  res.json(loteConHistoria(db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id)));
});

// ── Totales consolidados de un consolidador ────────────────────────────────────
app.get('/api/lotes/:id/consolidado', auth, (req, res) => {
  const consolidador = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (!consolidador || !consolidador.fusion_origen) return res.status(400).json({ error: 'No es un consolidador' });
  const hijos = JSON.parse(consolidador.fusion_origen || '[]');

  let kgCascara = 0, pulpaTotal = 0, cantTurnos = 0;
  const variedadesMap = {};

  hijos.forEach(hId => {
    const turnos = db.prepare('SELECT * FROM turnos WHERE lote_id=?').all(hId);
    cantTurnos += turnos.length;
    turnos.forEach(t => {
      kgCascara += t.kg_cascara || 0;
      pulpaTotal += t.pulpa_total || 0;
      const vars = JSON.parse(t.variedades || '[]');
      vars.forEach(v => {
        const nombre = normalizarVariedad((v.nombre || '').trim());
        if (!nombre) return;
        if (!variedadesMap[nombre]) variedadesMap[nombre] = { cantidad: 0, kg: 0 };
        variedadesMap[nombre].cantidad += parseInt(v.cantidad) || 0;
        variedadesMap[nombre].kg += (parseInt(v.cantidad) || 0) * (parseFloat(v.kg) || 0);
      });
    });
  });

  const rendimiento = kgCascara > 0 ? ((pulpaTotal / kgCascara) * 100).toFixed(1) : 0;
  res.json({
    consolidadorId: req.params.id,
    hijos,
    kgCascara: parseFloat(kgCascara.toFixed(1)),
    pulpaTotal: parseFloat(pulpaTotal.toFixed(1)),
    rendimiento: parseFloat(rendimiento),
    cantTurnos,
    variedades: Object.entries(variedadesMap).map(([nombre, v]) => ({ nombre, ...v }))
  });
});

app.delete('/api/lotes/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Solo el CEO puede borrar lotes' });
  // Revertir stock generado por los turnos del lote antes de borrarlo
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(req.params.id);
  if (lote) {
    const stockKey = lote.tipo === 'tercero' && lote.cliente_id ? String(lote.cliente_id) : (lote.tipo === 'propio' ? '__PROPIO__' : null); 
    if (stockKey) {
      const turnos = db.prepare('SELECT * FROM turnos WHERE lote_id = ?').all(req.params.id);
      turnos.forEach(t => {
        const vars = JSON.parse(t.variedades || '[]');
        vars.forEach(v => {
          const nombre = normalizarVariedad((v.nombre || '').trim());
          const cantidad = parseInt(v.cantidad) || 0;
          const kgUnit = parseFloat(v.kg) || 0;
          if (nombre && cantidad > 0) {
            db.prepare('UPDATE stock SET cantidad=MAX(0,cantidad-?), kg=MAX(0.0,kg-?) WHERE stock_key=? AND variedad=?').run(cantidad, cantidad*kgUnit, stockKey, nombre);
            db.prepare('DELETE FROM stock WHERE stock_key=? AND variedad=? AND cantidad<=0').run(stockKey, nombre);
          }
        });
      });
    }
  }
  db.prepare('DELETE FROM historia_lotes WHERE lote_id = ?').run(req.params.id);
  db.prepare('DELETE FROM turnos WHERE lote_id = ?').run(req.params.id);
  db.prepare('DELETE FROM lotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS TURNOS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/turnos', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM turnos ORDER BY creado DESC').all();
  res.json(rows.map(t => ({ ...t, variedades: JSON.parse(t.variedades||'[]'), kgCascara: t.kg_cascara, kgTotal: t.kg_total, pulpaTotal: t.pulpa_total, loteId: t.lote_id, horaInicio: t.hora_inicio, horaFin: t.hora_fin })));
});
app.post('/api/turnos', auth, (req, res) => {
  const { loteId, fecha, turno, hi, hf, variedades } = req.body;
  const kgCascara = parseFloat(req.body.kgCascara) || 0;
  const kgTotal = parseFloat(req.body.kgTotal) || 0;
  const pulpaTotal = parseFloat(req.body.pulpaTotal) || (variedades||[]).reduce((a,v)=>a+(parseFloat(v.cantidad||0)*parseFloat(v.kg||0)),0);
  if (!loteId || !fecha || !kgCascara) return res.status(400).json({ error: 'Faltan datos' });
  const id = 'T-' + Date.now();
  db.prepare('INSERT INTO turnos (id,lote_id,fecha,turno,hora_inicio,hora_fin,kg_cascara,kg_total,pulpa_total,variedades,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,loteId,fecha,turno||'',hi||'',hf||'',kgCascara,kgTotal,pulpaTotal,JSON.stringify(variedades||[]),req.user.username);
  // actualizar historia del lote
  const nota = `Turno${turno?' "'+turno+'"':''}: ${kgCascara.toFixed(0)} kg → ${pulpaTotal.toFixed(1)} kg pulpa`;
  db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(loteId, new Date().toISOString(), 'produccion', nota, req.user.username);
  // actualizar stock
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(loteId);
  if (lote && variedades && variedades.length > 0) {
    const stockKey = lote.tipo === 'tercero' && lote.cliente_id ? String(lote.cliente_id) : (lote.tipo === 'propio' ? '__PROPIO__' : null); 
    if (stockKey) {
      variedades.forEach(v => {
        const nombre = normalizarVariedad((v.nombre || '').trim());
        const cantidad = parseInt(v.cantidad) || 0;
        const kgUnit = parseFloat(v.kg) || 0;
        const kgTotal2 = cantidad * kgUnit;
        const envase = v.envase || 'caja';
        if (nombre && cantidad > 0) {
          db.prepare('INSERT INTO stock (stock_key,variedad,cantidad,kg,envase) VALUES (?,?,?,?,?) ON CONFLICT(stock_key,variedad) DO UPDATE SET cantidad=cantidad+excluded.cantidad, kg=kg+excluded.kg, envase=excluded.envase').run(stockKey, nombre, cantidad, kgTotal2, envase);
        }
      });
    }
  }
  logEvento('turno', 'Turno ' + loteId + ': ' + kgCascara.toFixed(0) + ' kg cascara → ' + pulpaTotal.toFixed(1) + ' kg pulpa', req.user.nombre, loteId);
  res.json({ id, loteId, fecha, turno, hi, hf, kgCascara, kgTotal, pulpaTotal, variedades, user: req.user.username });
});
// Reconstruye el stock de un cliente/propio desde cero basándose en todos sus turnos
function reconstruirStock(stockKey) {
  if (!stockKey) return;
  // Borrar todo el stock de este stockKey
  db.prepare('DELETE FROM stock WHERE stock_key=?').run(stockKey);
  // Reconstruir desde todos los turnos de lotes con este stockKey
  const lotes = stockKey === '__PROPIO__'
    ? db.prepare("SELECT * FROM lotes WHERE tipo='propio'").all()
    : db.prepare("SELECT * FROM lotes WHERE tipo='tercero' AND cliente_id=?").all(parseInt(stockKey));
  lotes.forEach(lote => {
    const turnos = db.prepare('SELECT * FROM turnos WHERE lote_id=?').all(lote.id);
    turnos.forEach(t => {
      const vars = JSON.parse(t.variedades||'[]');
      vars.forEach(v => {
        const nombre = normalizarVariedad((v.nombre||'').trim());
        const cantidad = parseInt(v.cantidad)||0;
        const kgUnit = parseFloat(v.kg)||0;
        if (nombre && cantidad > 0) {
          db.prepare('INSERT INTO stock (stock_key,variedad,cantidad,kg,envase) VALUES (?,?,?,?,?) ON CONFLICT(stock_key,variedad) DO UPDATE SET cantidad=cantidad+excluded.cantidad, kg=kg+excluded.kg, envase=excluded.envase').run(stockKey, nombre, cantidad, cantidad*kgUnit, v.envase||'caja');
        }
      });
    });
  });
}

app.put('/api/turnos/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo' && req.user.rol !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  const { fecha, turno, hi, hf, kgCascara, variedades } = req.body;
  const pulpaTotal = (variedades||[]).reduce((a,v)=>a+(v.cantidad*v.kg),0);
  // Actualizar turno primero
  db.prepare('UPDATE turnos SET fecha=COALESCE(?,fecha),turno=COALESCE(?,turno),hora_inicio=COALESCE(?,hora_inicio),hora_fin=COALESCE(?,hora_fin),kg_cascara=COALESCE(?,kg_cascara),variedades=COALESCE(?,variedades),pulpa_total=? WHERE id=?').run(fecha,turno,hi,hf,kgCascara,variedades?JSON.stringify(variedades):null,pulpaTotal,req.params.id);
  // Reconstruir stock desde cero
  const tActualizado = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (tActualizado) {
    const loteEdit = db.prepare('SELECT * FROM lotes WHERE id = ?').get(tActualizado.lote_id);
    if (loteEdit) {
      const stockKey = loteEdit.tipo === 'tercero' && loteEdit.cliente_id ? String(loteEdit.cliente_id) : (loteEdit.tipo === 'propio' ? '__PROPIO__' : null);
      reconstruirStock(stockKey);
    }
  }
  res.json({ ok: true, pulpaTotal });
});
app.delete('/api/turnos/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Solo el CEO puede borrar turnos' });
  const t = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrado' });
  // revertir stock reconstruyendo desde cero
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(t.lote_id);
  if (lote) {
    const stockKey = lote.tipo === 'tercero' && lote.cliente_id ? String(lote.cliente_id) : (lote.tipo === 'propio' ? '__PROPIO__' : null);
    db.prepare('DELETE FROM turnos WHERE id = ?').run(req.params.id);
    reconstruirStock(stockKey);
    logEvento('turno', 'Turno borrado: ' + t.id + ' del lote ' + t.lote_id, req.user.nombre, t.lote_id);
    return res.json({ ok: true });
  }
  logEvento('turno', 'Turno borrado: ' + t.id + ' del lote ' + t.lote_id, req.user.nombre, t.lote_id);
  db.prepare('DELETE FROM turnos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});


// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS DEVOLUCIONES BIG BAGS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/devoluciones-bb/:loteId', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM devoluciones_bb WHERE lote_id = ? ORDER BY creado').all(req.params.loteId);
  res.json(rows);
});
app.get('/api/devoluciones-bb', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM devoluciones_bb ORDER BY creado DESC').all();
  res.json(rows);
});
app.post('/api/devoluciones-bb', auth, (req, res) => {
  const { loteId, cantidad, fecha, obs } = req.body;
  if (!loteId || !cantidad || cantidad <= 0) return res.status(400).json({ error: 'Faltan datos o cantidad inválida' });
  const lote = db.prepare('SELECT * FROM lotes WHERE id = ?').get(loteId);
  if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });
  const totalBB = JSON.parse(lote.big_bags || '[]').length;
  const yaDevueltos = lote.bb_devueltos || 0;
  const pendientes = totalBB - yaDevueltos;
  if (cantidad > pendientes) return res.status(400).json({ error: `Solo quedan ${pendientes} BB pendientes de devolución` });
  const nuevosDevueltos = yaDevueltos + cantidad;
  db.prepare('UPDATE lotes SET bb_devueltos=? WHERE id=?').run(nuevosDevueltos, loteId);
  const nota = `Devolución parcial: ${cantidad} BB devueltos (total devueltos: ${nuevosDevueltos}/${totalBB})${obs?' — '+obs:''}`;
  db.prepare('INSERT INTO historia_lotes (lote_id,fecha,etapa,nota,usuario) VALUES (?,?,?,?,?)').run(loteId, new Date().toISOString(), lote.etapa, nota, req.user.username);
  const info = db.prepare('INSERT INTO devoluciones_bb (lote_id,cantidad,fecha,obs,usuario) VALUES (?,?,?,?,?)').run(loteId, cantidad, fecha || new Date().toISOString().split('T')[0], obs||'', req.user.username);
  res.json({ id: info.lastInsertRowid, loteId, cantidad, nuevosDevueltos, totalBB, pendientes: totalBB - nuevosDevueltos });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS STOCK
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/stock', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stock WHERE cantidad > 0 ORDER BY stock_key, variedad').all();
  const result = {};
  rows.forEach(r => {
    if (!result[r.stock_key]) result[r.stock_key] = {};
    result[r.stock_key][r.variedad] = { nombre: r.variedad, cantidad: r.cantidad, kg: r.kg, envase: r.envase };
  });
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS DESPACHOS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/despachos', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM despachos ORDER BY creado DESC').all();
  res.json(rows.map(d => ({ ...d, lineas: JSON.parse(d.lineas||'[]'), esPropio: !!d.es_propio, clienteNombre: d.cliente_nombre, clienteId: d.cliente_id, kgTotal: d.kg_total })));
});
app.post('/api/despachos', auth, (req, res) => {
  const { stockKey, clienteNombre, esPropio, fecha, lineas, transp, obs } = req.body;
  if (!stockKey || !lineas?.length) return res.status(400).json({ error: 'Faltan datos' });
  // validar stock
  for (const l of lineas) {
    const s = db.prepare('SELECT cantidad FROM stock WHERE stock_key=? AND variedad=?').get(stockKey, l.nombre);
    if (!s || s.cantidad < l.cantidad) return res.status(400).json({ error: `"${l.nombre}": supera el stock disponible` });
  }
  const id = nextDespId();
  const kgTotal = lineas.reduce((a,l)=>a+l.kgTotal,0);
  const clienteId = esPropio ? null : stockKey;
  db.prepare('INSERT INTO despachos (id,stock_key,cliente_id,cliente_nombre,es_propio,fecha,lineas,transp,obs,kg_total,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,stockKey,clienteId,clienteNombre,esPropio?1:0,fecha,JSON.stringify(lineas),transp||'',obs||'',kgTotal,req.user.username);
  // descontar stock
  lineas.forEach(l => {
    db.prepare('UPDATE stock SET cantidad=cantidad-?, kg=kg-? WHERE stock_key=? AND variedad=?').run(l.cantidad, l.kgTotal, stockKey, l.nombre);
    db.prepare('DELETE FROM stock WHERE stock_key=? AND variedad=? AND cantidad<=0').run(stockKey, l.nombre);
  });
  logEvento('despacho', 'Despacho ' + id + ': ' + kgTotal.toFixed(0) + ' kg a ' + (clienteNombre||'Producción propia'), req.user.nombre);
  res.json({ id, stockKey, clienteNombre, esPropio, fecha, lineas, transp, obs, kgTotal, user: req.user.username });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVIR EL FRONTEND
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// MÓDULO CALIDAD
// ═══════════════════════════════════════════════════════════
app.get('/api/calidad/fruta', auth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM calidad_fruta ORDER BY creado DESC').all();
    res.json(rows);
  } catch(e) {
    console.error('GET calidad/fruta error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calidad/fruta', auth, (req, res) => {
  try {
    const { loteId, fecha, bbMuestreados, extraLight, light, lightAmbar, ambar, surtidoIndustrial, picadoInsecto, hongo, vano, rancio, observaciones } = req.body;
    if (!loteId || !fecha) return res.status(400).json({ error: 'Faltan datos' });
    const el=parseFloat(extraLight)||0, li=parseFloat(light)||0, la=parseFloat(lightAmbar)||0, am=parseFloat(ambar)||0, su=parseFloat(surtidoIndustrial)||0;
    const total = el+li+la+am+su || 1;
    const pctEL=el/total*100, pctL=li/total*100, pctLA=la/total*100, pctA=am/total*100, pctS=su/total*100;
    const rendEst = pctEL+pctL+pctLA+pctA;
    const info = db.prepare('INSERT INTO calidad_fruta (lote_id,hora,fecha,bb_muestreados,peso_muestra_total,extra_light,light,light_ambar,ambar,surtido_industrial,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(loteId,req.body.hora||'',fecha,parseInt(bbMuestreados)||0,parseFloat(req.body.pesoMuestraTotal)||0,el,li,la,am,su,observaciones||'',req.user.username);
    logEvento('calidad_fruta', 'Calidad fruta ' + loteId + ': rendimiento ' + rendEst.toFixed(1) + '%', req.user.nombre, loteId);
    res.json({ id: info.lastInsertRowid, rendimientoEstimado: rendEst.toFixed(1), pctEL: pctEL.toFixed(1), pctL: pctL.toFixed(1), pctLA: pctLA.toFixed(1), pctA: pctA.toFixed(1), pctS: pctS.toFixed(1) });
  } catch(e) {
    console.error('POST calidad/fruta error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/calidad/fruta/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Sin permisos' });
  db.prepare('DELETE FROM calidad_fruta WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/calidad/pulpa', auth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM calidad_pulpa ORDER BY creado DESC').all();
    res.json(rows);
  } catch(e) {
    console.error('GET calidad/pulpa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calidad/pulpa', auth, (req, res) => {
  try {
    const d = req.body;
    if (!d.loteId || !d.fecha) return res.status(400).json({ error: 'Faltan datos' });
    const tf = (d.mariposaG||0)+(d.cuartosG||0)+(d.octavosG||0)+(d.trozosG||0)+(d.polvoG||0) || 1;
    const tc = (d.elG||0)+(d.lightG||0)+(d.amarilloG||0)+(d.ambarLightG||0)+(d.ambarG||0) || 1;
    const pctCua=(d.cuartosG||0)/tf*100, pctOct=(d.octavosG||0)/tf*100, pctPolv=(d.polvoG||0)/tf*100;
    const pctEL=(d.elG||0)/tc*100;
    const pctRL=((d.resecaLeveG||0)+(d.manchaLeveG||0))/tf*100;
    let estadoForma='OK', estadoColor='OK', estadoDefectos='OK';
    if (d.variedad==='Mariposa' && (pctCua>20||pctOct>3||pctPolv>0.2)) estadoForma='FUERA ESPEC';
    if (d.colorObjetivo==='EL' && pctEL<85) estadoColor='FUERA ESPEC';
    if (d.colorObjetivo==='EL-L' && pctEL<50) estadoColor='FUERA ESPEC';
    if (pctRL>4||(d.resecaGraveG||0)/tf*100>2||(d.manchaGraveG||0)/tf*100>2||(d.hongoInactivoG||0)/tf*100>2||(d.hongoActivoG||0)/tf*100>0.2) estadoDefectos='FUERA ESPEC';
    const resultado = (estadoForma==='OK'&&estadoColor==='OK'&&estadoDefectos==='OK') ? 'CONFORME' : 'NO CONFORME';
    const info = db.prepare('INSERT INTO calidad_pulpa (lote_id,hora,fecha,turno,linea,variedad,color_objetivo,peso_muestra,mariposa_g,cuartos_g,octavos_g,trozos_g,polvo_g,el_g,light_g,amarillo_g,ambar_light_g,ambar_g,reseca_leve_g,mancha_leve_g,reseca_grave_g,mancha_grave_g,hongo_inactivo_g,hongo_activo_g,humedad,estado_forma,estado_color,estado_defectos,resultado,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(d.loteId,d.hora||'',d.fecha,d.turno||'',d.linea||'',d.variedad||'',d.colorObjetivo||'',d.pesoMuestra||500,d.mariposaG||0,d.cuartosG||0,d.octavosG||0,d.trozosG||0,d.polvoG||0,d.elG||0,d.lightG||0,d.amarilloG||0,d.ambarLightG||0,d.ambarG||0,d.resecaLeveG||0,d.manchaLeveG||0,d.resecaGraveG||0,d.manchaGraveG||0,d.hongoInactivoG||0,d.hongoActivoG||0,d.humedad||0,estadoForma,estadoColor,estadoDefectos,resultado,d.observaciones||'',req.user.username);
    logEvento('calidad_pulpa', 'Calidad pulpa ' + d.loteId + ': ' + resultado, req.user.nombre, d.loteId);
    res.json({ id: info.lastInsertRowid, estadoForma, estadoColor, estadoDefectos, resultado });
  } catch(e) {
    console.error('POST calidad/pulpa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/calidad/pulpa/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Sin permisos' });
  const d = req.body;
  // Recalcular estados y resultado igual que en el POST
  const tf = (d.mariposa_g||0)+(d.cuartos_g||0)+(d.octavos_g||0)+(d.trozos_g||0)+(d.polvo_g||0)||1;
  const estadoForma = (d.mariposa_g||0)/tf >= 0.6 ? 'OK' : 'NO OK';
  const tc = (d.el_g||0)+(d.light_g||0)+(d.amarillo_g||0)+(d.ambar_light_g||0)+(d.ambar_g||0)||1;
  const estadoColor = ((d.el_g||0)+(d.light_g||0))/tc >= 0.5 ? 'OK' : 'NO OK';
  const defTotal = (d.reseca_leve_g||0)+(d.reseca_grave_g||0)+(d.mancha_leve_g||0)+(d.mancha_grave_g||0)+(d.hongo_inactivo_g||0)+(d.hongo_activo_g||0);
  const estadoDefectos = defTotal/((d.peso_muestra||500)) <= 0.03 ? 'OK' : 'NO OK';
  const resultado = estadoForma==='OK' && estadoColor==='OK' && estadoDefectos==='OK' ? 'CONFORME' : 'NO CONFORME';
  db.prepare(`UPDATE calidad_pulpa SET variedad=?,color_objetivo=?,fecha=?,hora=?,turno=?,peso_muestra=?,
    mariposa_g=?,cuartos_g=?,octavos_g=?,trozos_g=?,polvo_g=?,
    el_g=?,light_g=?,amarillo_g=?,ambar_light_g=?,ambar_g=?,
    reseca_leve_g=?,mancha_leve_g=?,reseca_grave_g=?,mancha_grave_g=?,hongo_inactivo_g=?,hongo_activo_g=?,
    humedad=?,estado_forma=?,estado_color=?,estado_defectos=?,resultado=?,observaciones=?
    WHERE id=?`).run(
    d.variedad||'', d.color_objetivo||'', d.fecha, d.hora||'', d.turno||'', d.peso_muestra||0,
    d.mariposa_g||0, d.cuartos_g||0, d.octavos_g||0, d.trozos_g||0, d.polvo_g||0,
    d.el_g||0, d.light_g||0, d.amarillo_g||0, d.ambar_light_g||0, d.ambar_g||0,
    d.reseca_leve_g||0, d.mancha_leve_g||0, d.reseca_grave_g||0, d.mancha_grave_g||0, d.hongo_inactivo_g||0, d.hongo_activo_g||0,
    d.humedad||0, estadoForma, estadoColor, estadoDefectos, resultado, d.observaciones||'',
    req.params.id
  );
  logEvento('calidad_pulpa', `Calidad pulpa #${req.params.id} editada por CEO`, req.user.nombre, null);
  res.json({ ok: true, resultado });
});

app.delete('/api/calidad/pulpa/:id', auth, (req, res) => {
  if (req.user.rol !== 'ceo') return res.status(403).json({ error: 'Sin permisos' });
  db.prepare('DELETE FROM calidad_pulpa WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS REGULACIÓN MÁQUINA
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/regulacion/maquina', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reg_maquina ORDER BY fecha DESC').all();
  res.json(rows.map(r => ({...r, loteId: r.lote_id, eq1Tolva: r.eq1_tolva, eq1Elevador: r.eq1_elevador, eq1Conos: r.eq1_conos, eq1Aspirador: r.eq1_aspirador, eq2Tolva: r.eq2_tolva, eq2Elevador: r.eq2_elevador, eq2Conos: r.eq2_conos, eq2Aspirador: r.eq2_aspirador, megavacAspirador: r.megavac_aspirador, megavacSoplador: r.megavac_soplador, obs: r.observaciones})));
});

app.post('/api/regulacion/maquina', auth, (req, res) => {
  const {loteId,fecha,eq1Tolva,eq1Elevador,eq1Conos,eq1Aspirador,eq2Tolva,eq2Elevador,eq2Conos,eq2Aspirador,megavacAspirador,megavacSoplador,obs} = req.body;
  const info = db.prepare('INSERT INTO reg_maquina (lote_id,fecha,eq1_tolva,eq1_elevador,eq1_conos,eq1_aspirador,eq2_tolva,eq2_elevador,eq2_conos,eq2_aspirador,megavac_aspirador,megavac_soplador,observaciones,usuario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(loteId,fecha,eq1Tolva||'',eq1Elevador||'',eq1Conos||'',eq1Aspirador||'',eq2Tolva||'',eq2Elevador||'',eq2Conos||'',eq2Aspirador||'',megavacAspirador||'',megavacSoplador||'',obs||'',req.user.username);
  res.json({id: info.lastInsertRowid});
});

app.put('/api/regulacion/maquina/:id', auth, (req, res) => {
  const {loteId,fecha,eq1Tolva,eq1Elevador,eq1Conos,eq1Aspirador,eq2Tolva,eq2Elevador,eq2Conos,eq2Aspirador,megavacAspirador,megavacSoplador,obs} = req.body;
  db.prepare('UPDATE reg_maquina SET lote_id=?,fecha=?,eq1_tolva=?,eq1_elevador=?,eq1_conos=?,eq1_aspirador=?,eq2_tolva=?,eq2_elevador=?,eq2_conos=?,eq2_aspirador=?,megavac_aspirador=?,megavac_soplador=?,observaciones=? WHERE id=?').run(loteId,fecha,eq1Tolva||'',eq1Elevador||'',eq1Conos||'',eq1Aspirador||'',eq2Tolva||'',eq2Elevador||'',eq2Conos||'',eq2Aspirador||'',megavacAspirador||'',megavacSoplador||'',obs||'',req.params.id);
  res.json({ok:true});
});

app.delete('/api/regulacion/maquina/:id', auth, (req, res) => {
  if(req.user.rol !== 'ceo') return res.status(403).json({error:'Solo CEO'});
  db.prepare('DELETE FROM reg_maquina WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS REGULACIÓN SELECTORA
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/regulacion/selectora', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reg_selectora ORDER BY fecha DESC').all();
  res.json(rows.map(r => ({...r, loteId: r.lote_id, canal1: JSON.parse(r.canal1_json||'[]'), canal2: JSON.parse(r.canal2_json||'[]'), obs: r.observaciones})));
});

app.post('/api/regulacion/selectora', auth, (req, res) => {
  const {loteId,fecha,canal1,canal2,obs} = req.body;
  const info = db.prepare('INSERT INTO reg_selectora (lote_id,fecha,canal1_json,canal2_json,observaciones,usuario) VALUES (?,?,?,?,?,?)').run(loteId,fecha,JSON.stringify(canal1||[]),JSON.stringify(canal2||[]),obs||'',req.user.username);
  res.json({id: info.lastInsertRowid});
});

app.put('/api/regulacion/selectora/:id', auth, (req, res) => {
  const {loteId,fecha,canal1,canal2,obs} = req.body;
  db.prepare('UPDATE reg_selectora SET lote_id=?,fecha=?,canal1_json=?,canal2_json=?,observaciones=? WHERE id=?').run(loteId,fecha,JSON.stringify(canal1||[]),JSON.stringify(canal2||[]),obs||'',req.params.id);
  res.json({ok:true});
});

app.delete('/api/regulacion/selectora/:id', auth, (req, res) => {
  if(req.user.rol !== 'ceo') return res.status(403).json({error:'Solo CEO'});
  db.prepare('DELETE FROM reg_selectora WHERE id=?').run(req.params.id);
  res.json({ok:true});
});


// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS MANTENIMIENTO
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/mantenimiento', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM mantenimiento ORDER BY resuelto ASC, id DESC').all();
  res.json(rows.map(r => ({
    ...r,
    resuelto: !!r.resuelto,
    usuarioResolucion: r.usuario_resolucion,
    fechaResolucion: r.fecha_resolucion,
    horaResolucion: r.hora_resolucion
  })));
});

app.post('/api/mantenimiento', auth, (req, res) => {
  const {maquina, nivel, descripcion} = req.body;
  if(!maquina || !descripcion) return res.status(400).json({error:'Faltan datos'});
  const now = new Date();
  const fecha = now.toISOString().split('T')[0];
  const hora = now.toTimeString().slice(0,5);
  const info = db.prepare('INSERT INTO mantenimiento (maquina,nivel,descripcion,usuario,fecha,hora) VALUES (?,?,?,?,?,?)').run(maquina, nivel||'atencion', descripcion, req.user.username, fecha, hora);
  logEvento('mantenimiento', 'Mantenimiento en ' + maquina + ': ' + descripcion.slice(0,60), req.user.nombre);
  res.json({id: info.lastInsertRowid});
});

app.put('/api/mantenimiento/:id', auth, (req, res) => {
  const {solucion} = req.body;
  const now = new Date();
  const fecha = now.toISOString().split('T')[0];
  const hora = now.toTimeString().slice(0,5);
  db.prepare('UPDATE mantenimiento SET resuelto=1, solucion=?, usuario_resolucion=?, fecha_resolucion=?, hora_resolucion=? WHERE id=?').run(solucion||'', req.user.username, fecha, hora, req.params.id);
  res.json({ok: true});
});

app.delete('/api/mantenimiento/:id', auth, (req, res) => {
  if(req.user.rol !== 'ceo') return res.status(403).json({error:'Solo CEO'});
  db.prepare('DELETE FROM mantenimiento WHERE id=?').run(req.params.id);
  res.json({ok: true});
});


// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK META WHATSAPP BUSINESS API
// ═══════════════════════════════════════════════════════════════════════════════
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'verificacion2024';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

// Verificación del webhook (GET) — Meta llama esto al configurar
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Función para registrar eventos globales
function logEvento(tipo, descripcion, usuario, lote_id = '') {
  try {
    const ahoraAR = new Date(Date.now() - 3*60*60*1000).toISOString().replace('T',' ').slice(0,19);
    db.prepare('INSERT INTO eventos_globales (tipo, descripcion, usuario, lote_id, fecha) VALUES (?, ?, ?, ?, ?)').run(tipo, descripcion, usuario, lote_id, ahoraAR);
  } catch(e) { console.error('Error logEvento:', e.message); }
}

// Endpoint para obtener ultimos eventos globales
app.get('/api/eventos', auth, (req, res) => {
  const eventos = db.prepare('SELECT * FROM eventos_globales ORDER BY fecha DESC LIMIT 50').all();
  res.json(eventos);
});

// Función para enviar mensaje por Meta API
async function sendMetaMessage(to, mensaje) {
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) return;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + META_ACCESS_TOKEN },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: mensaje }
      })
    });
    if (!metaRes.ok) { const data = await metaRes.json(); console.error('❌ Meta API error:', JSON.stringify(data)); }
  } catch(e) { console.error('Meta WhatsApp error:', e.message); }
}

// Recepción de mensajes (POST)
app.post('/webhook/meta', express.json(), async (req, res) => {
  res.status(200).send('OK'); // Responder rápido a Meta

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const from = message.from; // número sin +, ej: 5492622696572
    const msgType = message.type;

    // Buscar usuario
    const usuario = db.prepare("SELECT * FROM usuarios WHERE whatsapp = ?").get(from);
    if (!usuario) {
      await sendMetaMessage(from, '❌ Tu número no está registrado en el sistema. Contactá al administrador.');
      return;
    }

    // ── IMAGEN (OCR) ──────────────────────────────────────────────────────────
    if (msgType === 'image') {
      const mediaId = message.image.id;
      try {
        await sendMetaMessage(from, '📸 Procesando planilla... aguardá un momento.');

        // Obtener URL de la imagen desde Meta
        const mediaRes = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
          headers: { 'Authorization': 'Bearer ' + META_ACCESS_TOKEN }
        });
        const mediaData = await mediaRes.json();
        const imageUrl = mediaData.url;

        // Descargar imagen
        const imgRes = await fetch(imageUrl, {
          headers: { 'Authorization': 'Bearer ' + META_ACCESS_TOKEN }
        });
        const imgBuffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(imgBuffer).toString('base64');
        let contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        contentType = contentType.split(';')[0].trim();
        if (!['image/jpeg','image/png','image/gif','image/webp'].includes(contentType)) contentType = 'image/jpeg';

        const datos = await procesarImagenOCR(base64, contentType);

        if (datos.tipo === 'ERROR') {
          await sendMetaMessage(from, `❌ No pude leer la planilla:\n${datos.mensaje}\n\nAsegurate de que la foto esté bien iluminada.`);
        } else {
          // Guardar en pendiente y pedir confirmación
          pendingOCR.set(from, { datos, usuarioNombre: usuario.nombre, timestamp: Date.now() });
          const msgConfirmacion = formatearConfirmacionOCR(datos);
          await sendMetaMessage(from, msgConfirmacion);
        }
      } catch(e) {
        console.error('Meta OCR error:', e.message);
        await sendMetaMessage(from, `❌ Error al procesar la imagen: ${e.message}`);
      }
      return;
    }

    // ── TEXTO ─────────────────────────────────────────────────────────────────
    if (msgType !== 'text') return;
    const bodyRaw = (message.text.body || '').trim();
    const body = bodyRaw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const perms = (() => {
      try {
        const cfg = db.prepare("SELECT valor FROM config WHERE clave = ?").get('perm_' + usuario.rol);
        return cfg ? JSON.parse(cfg.valor) : {};
      } catch(e) { return {}; }
    })();
    const secs = perms.secs || [];
    const CEO_NUM = process.env.CEO_WHATSAPP || '';

    // ── CONFIRMACIÓN OCR PENDIENTE ─────────────────────────────────────────────
    if (pendingOCR.has(from)) {
      const pending = pendingOCR.get(from);
      // Limpiar si expiró
      if (Date.now() - pending.timestamp > PENDING_OCR_TTL) {
        pendingOCR.delete(from);
      } else if (body === 'si' || body === 'sí' || body === 's') {
        pendingOCR.delete(from);
        try {
          const confirmacion = await registrarDatosOCR(pending.datos, pending.usuarioNombre);
          await sendMetaMessage(from, confirmacion);
          if (usuario.rol !== 'ceo') {
            if(CEO_NUM) await sendMetaMessage(CEO_NUM, `📋 *Registro vía foto confirmado*\nOperario: ${pending.usuarioNombre}\n${confirmacion}`);
          }
        } catch(e) {
          await sendMetaMessage(from, `❌ Error al guardar: ${e.message}`);
        }
        return;
      } else if (body === 'no' || body === 'n') {
        pendingOCR.delete(from);
        await sendMetaMessage(from, `❌ *Registro cancelado.* Podés mandar la foto de nuevo cuando quieras.`);
        return;
      }
    }

    // ── MENÚ ──────────────────────────────────────────────────────────────────
    if (body === 'menu' || body === 'hola' || body === 'inicio' || body === '0') {
      const esCeoRep = usuario.rol === 'ceo' || usuario.rol === 'reportes';
      let menu = `🏭 *Galpón de Empaque*\nHola ${usuario.nombre}! (${usuario.rol})\n\n`;

      if (secs.includes('lotes') || esCeoRep) {
        menu += `📦 *LOTES*\n1️⃣ Lotes activos (recepción)\n2️⃣ Lotes en producción\n\n`;
      }
      if (secs.includes('turno') || esCeoRep) {
        menu += `⚙️ *PRODUCCIÓN*\n3️⃣ Turnos de hoy\n4️⃣ Reporte del mes\n\n`;
      }
      if (secs.includes('calidad') || esCeoRep) {
        menu += `🔬 *CALIDAD*\n5️⃣ Calidad fruta del día\n6️⃣ Calidad pulpa del día\n\n`;
      }
      if (esCeoRep) {
        menu += `📊 *GESTIÓN*\n7️⃣ Stock actual\n8️⃣ Despachos de hoy\n9️⃣ Big Bags activos\n\n`;
      }
      if (secs.includes('mantenimiento') || esCeoRep) {
        menu += `🔧 *MANTENIMIENTO*\n🔟 Pendientes\n\n`;
      }
      menu += `📋 *CONSULTAS*\n*lote [id]* → detalle de un lote\n*cal [id]* → calidad de un lote\n*desp hoy* → despachos de hoy\n\n`;
      menu += `📸 Mandá una *foto* de cualquier planilla para registrarla automáticamente.`;
      await sendMetaMessage(from, menu);

    // ── 1: LOTES ACTIVOS (recepción) ──────────────────────────────────────────
    } else if (body === '1' && (secs.includes('lotes') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const lotes = db.prepare("SELECT * FROM lotes WHERE etapa='recepcion' AND finalizado=0 AND fusionado=0 ORDER BY fecha DESC").all();
      if (!lotes.length) { await sendMetaMessage(from, '📦 No hay lotes activos en recepción.'); return; }
      let msg = `📦 *Lotes activos (recepción):*\n\n`;
      lotes.forEach(l => { msg += `• *${l.id}* — ${l.producto} | ${l.peso_ingreso||0} kg | ${l.fecha}\n`; });
      await sendMetaMessage(from, msg);

    // ── 2: LOTES EN PRODUCCIÓN ────────────────────────────────────────────────
    } else if (body === '2' && (secs.includes('lotes') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const lotes = db.prepare(`
        SELECT l.id, l.producto, l.peso_ingreso,
               COALESCE(SUM(t.kg_cascara), 0) as kg_proc,
               COALESCE(SUM(t.pulpa_total), 0) as pulpa_proc
        FROM lotes l
        LEFT JOIN turnos t ON t.lote_id = l.id
        WHERE l.etapa='produccion' AND l.finalizado=0
        GROUP BY l.id
      `).all();
      if (!lotes.length) { await sendMetaMessage(from, '⚙️ No hay lotes en producción.'); return; }
      let msg = `⚙️ *Lotes en producción:*\n\n`;
      lotes.forEach(l => {
        const pct  = l.peso_ingreso > 0 ? ((l.kg_proc / l.peso_ingreso) * 100).toFixed(0) : 0;
        const rend = l.kg_proc > 0 ? ((l.pulpa_proc / l.kg_proc) * 100).toFixed(1) : 0;
        msg += `• *${l.id}* — ${l.producto}\n  ${l.kg_proc.toFixed(0)} kg (${pct}%) | Pulpa: ${l.pulpa_proc.toFixed(0)} kg | Rend: ${rend}%\n`;
      });
      await sendMetaMessage(from, msg);

    // ── 3: TURNOS DE HOY ──────────────────────────────────────────────────────
    } else if (body === '3' && (secs.includes('turno') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoyAR = new Date(Date.now() - 3*60*60*1000).toISOString().split('T')[0];
      const turnos = db.prepare("SELECT t.*, l.producto FROM turnos t LEFT JOIN lotes l ON l.id=t.lote_id WHERE t.fecha=? ORDER BY t.id DESC").all(hoyAR);
      if (!turnos.length) { await sendMetaMessage(from, `📋 No hay turnos registrados hoy (${hoyAR}).`); return; }
      let msg = `📋 *Turnos de hoy (${hoyAR}):*\n\n`;
      turnos.forEach(t => { msg += `• ${t.lote_id} — ${t.producto||''}\n  ${t.turno||''} | ${t.kg_cascara||0} kg cáscara | ${t.pulpa_total||0} kg pulpa\n`; });
      await sendMetaMessage(from, msg);

    // ── 4: REPORTE DEL MES ────────────────────────────────────────────────────
    } else if (body === '4' && (secs.includes('turno') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoyAR = new Date(Date.now() - 3*60*60*1000).toISOString().split('T')[0];
      const mes = hoyAR.slice(0,7);
      const hace30 = new Date(Date.now() - 3*60*60*1000 - 30*24*60*60*1000).toISOString().split('T')[0];
      const hoyT = db.prepare("SELECT COUNT(*) as c, SUM(kg_cascara) as kg, SUM(pulpa_total) as pulpa FROM turnos WHERE fecha=?").get(hoyAR);
      const mesT = db.prepare("SELECT COUNT(*) as c, SUM(kg_cascara) as kg, SUM(pulpa_total) as pulpa FROM turnos WHERE fecha >= ?").get(hace30);
      const rend = mesT?.kg > 0 ? ((mesT.pulpa / mesT.kg) * 100).toFixed(1) : 0;
      await sendMetaMessage(from, `📊 *Reporte de Producción*\n\n*Hoy (${hoyAR}):*\nTurnos: ${hoyT?.c||0} | Cáscara: ${(hoyT?.kg||0).toFixed(0)} kg | Pulpa: ${(hoyT?.pulpa||0).toFixed(0)} kg\n\n*Últimos 30 días:*\nTurnos: ${mesT?.c||0} | Cáscara: ${(mesT?.kg||0).toFixed(0)} kg | Pulpa: ${(mesT?.pulpa||0).toFixed(0)} kg | Rend: ${rend}%`);

    // ── 5: CALIDAD FRUTA DEL DÍA ──────────────────────────────────────────────
    } else if (body === '5' && (secs.includes('calidad') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoyAR = new Date(Date.now() - 3*60*60*1000).toISOString().split('T')[0];
      const fruta = db.prepare("SELECT * FROM calidad_fruta WHERE fecha=? ORDER BY id DESC").all(hoyAR);
      if (!fruta.length) { await sendMetaMessage(from, `🔬 No hay controles de fruta hoy (${hoyAR}).`); return; }
      let msg = `🔬 *Calidad fruta hoy (${hoyAR}):*\n\n`;
      fruta.forEach(c => {
        const total = (c.extra_light+c.light+c.light_ambar+c.ambar+c.surtido_industrial) || 1;
        const rend = ((c.extra_light+c.light+c.light_ambar+c.ambar)/total*100).toFixed(1);
        msg += `• ${c.lote_id} — Rend: ${rend}% | BB: ${c.bb_muestreados||0} | ${c.hora||''}\n`;
      });
      await sendMetaMessage(from, msg);

    // ── 6: CALIDAD PULPA DEL DÍA ──────────────────────────────────────────────
    } else if (body === '6' && (secs.includes('calidad') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoyAR = new Date(Date.now() - 3*60*60*1000).toISOString().split('T')[0];
      const pulpa = db.prepare("SELECT * FROM calidad_pulpa WHERE fecha=? ORDER BY id DESC").all(hoyAR);
      if (!pulpa.length) { await sendMetaMessage(from, `🧪 No hay controles de pulpa hoy (${hoyAR}).`); return; }
      let msg = `🧪 *Calidad pulpa hoy (${hoyAR}):*\n\n`;
      pulpa.forEach(c => {
        const res = c.resultado === 'CONFORME' ? '✅' : '❌';
        msg += `${res} ${c.lote_id} — ${c.variedad||'—'} | ${c.resultado} | ${c.hora||''}\n`;
      });
      await sendMetaMessage(from, msg);

    // ── 7: STOCK ACTUAL ───────────────────────────────────────────────────────
    } else if (body === '7' && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const stock = db.prepare("SELECT * FROM stock ORDER BY kg DESC LIMIT 10").all();
      if (!stock.length) { await sendMetaMessage(from, '📦 Stock vacío.'); return; }
      let msg = `📦 *Stock actual:*\n\n`;
      stock.forEach(s => { msg += `• ${s.variedad}: ${s.cantidad} ud (${s.kg?.toFixed(0)||0} kg)\n`; });
      await sendMetaMessage(from, msg);

    // ── 8: DESPACHOS DE HOY ───────────────────────────────────────────────────
    } else if (body === '8' && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoy = new Date().toISOString().split('T')[0];
      const despachos = db.prepare("SELECT * FROM despachos WHERE fecha=? ORDER BY id DESC").all(hoy);
      if (!despachos.length) { await sendMetaMessage(from, `🚚 No hay despachos hoy.`); return; }
      let msg = `🚚 *Despachos de hoy:*\n\n`;
      despachos.forEach(d => { msg += `• ${d.id} — ${d.cliente_nombre||'Propio'} | ${d.kg_total||0} kg\n`; });
      await sendMetaMessage(from, msg);

    // ── 9: BIG BAGS ACTIVOS ───────────────────────────────────────────────────
    } else if (body === '9' && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const lotes = db.prepare("SELECT * FROM lotes WHERE big_bags IS NOT NULL AND big_bags != '[]' AND finalizado=0 AND fusionado=0").all();
      let msg = `🛢️ *Big Bags activos:*\n\n`, total = 0;
      lotes.forEach(l => { try { const bbs = JSON.parse(l.big_bags||'[]'); if(bbs.length){ msg+=`• ${l.id} — ${l.producto}: ${bbs.length} BB\n`; total+=bbs.length; } } catch(e){} });
      const devs = db.prepare("SELECT SUM(cantidad) as c FROM devoluciones_bb").get();
      msg += `\nTotal BB: ${total} | Devueltos: ${devs?.c||0}`;
      await sendMetaMessage(from, msg);

    // ── 10: MANTENIMIENTO PENDIENTE ───────────────────────────────────────────
    } else if (body === '10' && (secs.includes('mantenimiento') || usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const pendientes = db.prepare("SELECT * FROM mantenimiento WHERE resuelto=0 ORDER BY CASE nivel WHEN 'critico' THEN 0 WHEN 'atencion' THEN 1 ELSE 2 END").all();
      if (!pendientes.length) { await sendMetaMessage(from, '✅ No hay mantenimientos pendientes.'); return; }
      let msg = `🔧 *Mantenimiento pendiente:*\n\n`;
      pendientes.forEach(m => { const e = m.nivel==='critico'?'🔴':m.nivel==='atencion'?'🟡':'🔵'; msg += `${e} ${m.maquina} — ${m.nivel.toUpperCase()}\n  ${m.descripcion}\n  Reportó: ${m.usuario} (${m.fecha} ${m.hora})\n\n`; });
      await sendMetaMessage(from, msg);

    // ── REGISTRAR MANTENIMIENTO ────────────────────────────────────────────────
    } else if (body.startsWith('mant ') && secs.includes('mantenimiento')) {
      const partes = body.replace('mant ','').split(' ');
      const maquina = partes[0]||'General', nivel = ['critico','atencion','preventivo'].includes(partes[1])?partes[1]:'atencion', descripcion = partes.slice(2).join(' ')||'Sin descripción';
      const now = new Date(), fecha = now.toISOString().split('T')[0], hora = now.toTimeString().slice(0,5);
      db.prepare('INSERT INTO mantenimiento (maquina,nivel,descripcion,usuario,fecha,hora) VALUES (?,?,?,?,?,?)').run(maquina,nivel,descripcion,usuario.nombre,fecha,hora);
      await sendMetaMessage(from, `✅ Mantenimiento registrado:\n• Máquina: ${maquina}\n• Nivel: ${nivel.toUpperCase()}\n• Descripción: ${descripcion}`);
      if (nivel==='critico') await sendMetaMessage(CEO_NUM, `🚨 *ALERTA CRÍTICA DE MANTENIMIENTO*\n\nReportó: ${usuario.nombre}\nMáquina: ${maquina}\nFecha: ${fecha} ${hora}\nDetalle: ${descripcion}`);

    } else if (body.startsWith('lote ') && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const loteId=body.replace('lote ','').trim().toUpperCase();
      const l=db.prepare("SELECT * FROM lotes WHERE id=?").get(loteId);
      if(!l){await sendMetaMessage(from,`❌ Lote ${loteId} no encontrado.`);return;}
      const t=db.prepare("SELECT SUM(kg_cascara) as kg,SUM(pulpa_total) as pulpa,COUNT(*) as c FROM turnos WHERE lote_id=?").get(loteId);
      const rend=t?.kg>0?((t.pulpa||0)/(t.kg||1)*100).toFixed(1):0;
      await sendMetaMessage(from,`📋 *Lote ${l.id}*\n${l.producto}${l.variedad?' · '+l.variedad:''} | ${l.tipo==='tercero'?(l.cliente_nombre||''):(l.productor||'Propio')}\nEstado: ${l.etapa} | Ingreso: ${l.peso_ingreso||0} kg\nTurnos: ${t?.c||0} | Procesado: ${(t?.kg||0).toFixed(0)} kg | Pulpa: ${(t?.pulpa||0).toFixed(0)} kg | Rend: ${rend}%`);

    } else if (body.startsWith('cal ') && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const loteId=body.replace('cal ','').trim().toUpperCase();
      const fruta=db.prepare("SELECT * FROM calidad_fruta WHERE lote_id=? ORDER BY id DESC LIMIT 5").all(loteId);
      const pulpa=db.prepare("SELECT * FROM calidad_pulpa WHERE lote_id=? ORDER BY id DESC LIMIT 5").all(loteId);
      if(!fruta.length&&!pulpa.length){await sendMetaMessage(from,`🔬 No hay controles para lote ${loteId}.`);return;}
      let msg=`🔬 *Calidad ${loteId}:*\n\n`;
      if(fruta.length){msg+=`*Fruta:*\n`;fruta.forEach(c=>{const t=(c.extra_light+c.light+c.light_ambar+c.ambar+c.surtido_industrial)||1;msg+=`• ${c.fecha} — Rend: ${((c.extra_light+c.light+c.light_ambar+c.ambar)/t*100).toFixed(1)}%\n`;});}
      if(pulpa.length){msg+=`\n*Pulpa:*\n`;pulpa.forEach(c=>{msg+=`• ${c.fecha} — ${c.resultado}\n`;});}
      await sendMetaMessage(from,msg);

    } else if (body === 'desp hoy' && (usuario.rol === 'ceo' || usuario.rol === 'reportes')) {
      const hoy=new Date().toISOString().split('T')[0];
      const despachos=db.prepare("SELECT * FROM despachos WHERE fecha=? ORDER BY id DESC").all(hoy);
      if(!despachos.length){await sendMetaMessage(from,`🚚 No hay despachos hoy.`);return;}
      let msg=`🚚 *Despachos hoy:*\n\n`;despachos.forEach(d=>{msg+=`• ${d.id} — ${d.kg_total||0} kg\n`;});await sendMetaMessage(from,msg);

    } else {
      await sendMetaMessage(from, `❓ No entendí el mensaje. Respondé *menu* para ver las opciones.`);
    }

  } catch(e) {
    console.error('Meta webhook error:', e.message);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// RECONSTRUIR STOCK COMPLETO (solo CEO)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/set-counter', auth, onlyCeo, (req, res) => {
  const { clave, valor } = req.body;
  if (!clave || valor === undefined) return res.status(400).json({ error: 'Falta clave o valor' });
  db.prepare("INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)").run(clave, String(valor));
  res.json({ ok: true, clave, valor });
});
app.get('/api/admin/fix-stock', auth, onlyCeo, (req, res) => {
  try {
    const lotes = db.prepare('SELECT DISTINCT tipo, cliente_id FROM lotes').all();
    const stockKeys = new Set();
    lotes.forEach(l => {
      if (l.tipo === 'tercero' && l.cliente_id) stockKeys.add(String(l.cliente_id));
      else if (l.tipo === 'propio') stockKeys.add('__PROPIO__');
    });
    stockKeys.forEach(sk => reconstruirStock(sk));
    res.json({ ok: true, message: 'Stock reconstruido para ' + stockKeys.size + ' clientes' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FRONTEND
// ═══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});




app.listen(PORT, () => {
  console.log(`🚀 Galpón de Empaque corriendo en http://localhost:${PORT}`);
  console.log(`📁 Base de datos: ${process.env.DATABASE_PATH || './galpon.db'}`);
});