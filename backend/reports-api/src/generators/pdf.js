'use strict';

/**
 * Composición del PDF con PDFKit.
 *
 * `bufferPages: true` es obligatorio y no un detalle de estilo: sin él,
 * bufferedPageRange() devuelve un rango vacío y no se puede volver atrás para
 * numerar las páginas ni estampar la marca de veda. El sistema base creaba el
 * documento sin esa opción y la numeración salía siempre "1 de 1".
 *
 * Todas las gráficas se dibujan a mano con rect / moveTo / lineTo. No hay
 * dependencia de un motor de gráficas ni de un navegador headless: menos
 * superficie, menos peso y un PDF vectorial que se puede imprimir.
 */

const PDFDocument = require('pdfkit');

// ── Paleta ──────────────────────────────────────────────────────────────────
const COLOR = {
  ink: '#1B1B1B',
  muted: '#6B6B6B',
  hair: '#D8D8D8',
  panel: '#F4F6F8',
  accent: '#1A3E6F',
  positive: '#2E7D32',
  neutral: '#8A8A8A',
  negative: '#C62828',
  mixed: '#EF6C00',
  warning: '#B26A00',
  blackout: '#C62828',
};

const SEVERITY_COLOR = {
  info: '#4A6FA5',
  low: '#8A8A8A',
  medium: '#B26A00',
  high: '#C05621',
  critical: '#C62828',
};

const PAGE = { size: 'A4', margins: { top: 56, bottom: 64, left: 50, right: 50 } };

// ── Formateo ────────────────────────────────────────────────────────────────
function fmtNumber(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 's/d';
  try {
    return Number(value).toLocaleString('es-MX', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } catch {
    return Number(value).toFixed(decimals);
  }
}

function fmtPct(value, decimals = 1) {
  if (value === null || value === undefined) return 's/d';
  return `${fmtNumber(value, decimals)} %`;
}

function fmtDate(value) {
  if (!value) return 's/d';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 's/d';
  try {
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function fmtDateShort(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fmtDateTime(value) {
  if (!value) return 's/d';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 's/d';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Recorta sin partir palabras a la mitad cuando se puede. */
function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

// ── Primitivas de maquetación ───────────────────────────────────────────────
class Layout {
  constructor(doc) {
    this.doc = doc;
  }

  get left() { return this.doc.page.margins.left; }

  get right() { return this.doc.page.width - this.doc.page.margins.right; }

  get width() { return this.right - this.left; }

  get bottom() { return this.doc.page.height - this.doc.page.margins.bottom; }

  /** Añade página si no caben `height` puntos. Evita títulos huérfanos al pie. */
  ensure(height) {
    if (this.doc.y + height > this.bottom) {
      this.doc.addPage();
      return true;
    }
    return false;
  }

  h1(text) {
    const doc = this.doc;
    this.ensure(60);
    doc.fillColor(COLOR.accent).font('Helvetica-Bold').fontSize(16).text(text, this.left, doc.y);
    doc.moveDown(0.25);
    const y = doc.y;
    doc.moveTo(this.left, y).lineTo(this.right, y).lineWidth(1.2).strokeColor(COLOR.accent).stroke();
    doc.moveDown(0.7);
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(10);
  }

  h2(text) {
    const doc = this.doc;
    this.ensure(40);
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(11.5).text(text, this.left, doc.y);
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(10);
  }

  p(text, options = {}) {
    const doc = this.doc;
    const size = options.size || 9.5;
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(size)
      .fillColor(options.color || COLOR.ink)
      .text(text, this.left, doc.y, { width: this.width, align: options.align || 'left', lineGap: options.lineGap ?? 1.5 });
    doc.moveDown(options.gap ?? 0.5);
    doc.fillColor(COLOR.ink);
  }

  /** Recuadro de aviso. Se usa para advertencias metodológicas y de veda. */
  callout(title, body, color = COLOR.warning) {
    const doc = this.doc;
    const padding = 8;
    const textWidth = this.width - padding * 2 - 4;
    doc.font('Helvetica-Bold').fontSize(9.5);
    const titleHeight = title ? doc.heightOfString(title, { width: textWidth }) : 0;
    doc.font('Helvetica').fontSize(9);
    const bodyHeight = doc.heightOfString(body, { width: textWidth, lineGap: 1.5 });
    const boxHeight = titleHeight + bodyHeight + padding * 2 + (title ? 3 : 0);

    this.ensure(boxHeight + 10);
    const top = doc.y;
    doc.save();
    doc.rect(this.left, top, this.width, boxHeight).fillOpacity(1).fill(COLOR.panel);
    // Barra lateral de color: identifica el tipo de aviso de un vistazo.
    doc.rect(this.left, top, 3.5, boxHeight).fill(color);
    doc.restore();

    let y = top + padding;
    if (title) {
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(color)
        .text(title, this.left + padding + 4, y, { width: textWidth });
      y += titleHeight + 3;
    }
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ink)
      .text(body, this.left + padding + 4, y, { width: textWidth, lineGap: 1.5 });

    doc.y = top + boxHeight + 10;
    doc.x = this.left;
  }

  /**
   * Tabla con encabezado. `columns`: {label, key, width (proporción), align, format}.
   * El encabezado se repite si la tabla salta de página: una tabla sin
   * encabezado en la segunda página es ilegible.
   */
  table(columns, rows, options = {}) {
    const doc = this.doc;
    const totalUnits = columns.reduce((acc, c) => acc + (c.width || 1), 0);
    const colWidth = (c) => ((c.width || 1) / totalUnits) * this.width;
    const rowHeight = options.rowHeight || 16;
    const headerHeight = 18;

    const drawHeader = () => {
      const top = doc.y;
      doc.save().rect(this.left, top, this.width, headerHeight).fill(COLOR.accent).restore();
      let x = this.left;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
      for (const c of columns) {
        const w = colWidth(c);
        doc.text(c.label, x + 4, top + 5, { width: w - 8, align: c.align || 'left', ellipsis: true });
        x += w;
      }
      doc.y = top + headerHeight;
      doc.fillColor(COLOR.ink);
    };

    this.ensure(headerHeight + rowHeight * 2);
    drawHeader();

    let index = 0;
    for (const row of rows) {
      if (doc.y + rowHeight > this.bottom) {
        doc.addPage();
        drawHeader();
      }
      const top = doc.y;
      // Cebra: sin ella, las tablas anchas se leen de renglón cruzado.
      if (index % 2 === 1) {
        doc.save().rect(this.left, top, this.width, rowHeight).fill('#FAFBFC').restore();
      }
      let x = this.left;
      for (const c of columns) {
        const w = colWidth(c);
        const raw = typeof c.format === 'function' ? c.format(row[c.key], row) : row[c.key];
        const value = raw === null || raw === undefined || raw === '' ? 's/d' : String(raw);
        const color = typeof c.color === 'function' ? c.color(row[c.key], row) : (c.color || COLOR.ink);
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color)
          .text(value, x + 4, top + 4.5, { width: w - 8, align: c.align || 'left', ellipsis: true, lineBreak: false });
        x += w;
      }
      doc.strokeColor(COLOR.hair).lineWidth(0.4)
        .moveTo(this.left, top + rowHeight).lineTo(this.right, top + rowHeight).stroke();
      doc.y = top + rowHeight;
      index += 1;
    }
    doc.x = this.left;
    doc.moveDown(0.8);
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(9.5);
  }

  /** Barras horizontales dibujadas con rect. */
  barChart(items, options = {}) {
    const doc = this.doc;
    const barHeight = options.barHeight || 15;
    const gap = options.gap || 7;
    const labelWidth = options.labelWidth || 118;
    const valueWidth = options.valueWidth || 78;
    const trackWidth = this.width - labelWidth - valueWidth;
    const max = options.max ?? Math.max(1, ...items.map((i) => Math.abs(Number(i.value) || 0)));
    const height = items.length * (barHeight + gap) + 6;

    this.ensure(height);
    let y = doc.y;

    for (const item of items) {
      const value = Number(item.value) || 0;
      const ratio = max === 0 ? 0 : Math.min(1, Math.abs(value) / max);

      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.ink)
        .text(truncate(item.label, 28), this.left, y + 3.5, { width: labelWidth - 6, ellipsis: true, lineBreak: false });

      const trackX = this.left + labelWidth;
      doc.save().rect(trackX, y, trackWidth, barHeight).fill('#EDF0F3').restore();
      if (ratio > 0) {
        doc.save().rect(trackX, y, Math.max(1.5, trackWidth * ratio), barHeight)
          .fill(item.color || COLOR.accent).restore();
      }

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.ink)
        .text(item.display ?? fmtNumber(value, 1), trackX + trackWidth + 6, y + 3.5,
          { width: valueWidth - 6, align: 'right', lineBreak: false });

      y += barHeight + gap;
    }

    doc.y = y + 4;
    doc.x = this.left;
  }

  /**
   * Gráfica de líneas trazada con moveTo/lineTo.
   * `series`: [{ label, color, points: [{x: Date|string, y: number|null}] }]
   */
  lineChart(series, options = {}) {
    const doc = this.doc;
    const height = options.height || 168;
    const padLeft = 40;
    const padBottom = 22;
    const padTop = 10;

    this.ensure(height + 30);
    const top = doc.y;
    const plotX = this.left + padLeft;
    const plotY = top + padTop;
    const plotW = this.width - padLeft - 8;
    const plotH = height - padTop - padBottom;

    const allY = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v !== null && Number.isFinite(v));
    if (allY.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(COLOR.muted)
        .text('Sin datos suficientes para trazar la serie en este periodo.', this.left, top, { width: this.width });
      doc.y = top + 20;
      return;
    }

    // Escala con holgura del 10 % para que la línea no toque los bordes.
    let minY = Math.min(...allY);
    let maxY = Math.max(...allY);
    if (options.zeroBaseline && minY > 0) minY = 0;
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const span = maxY - minY;
    minY -= span * 0.1;
    maxY += span * 0.1;

    const pointCount = Math.max(...series.map((s) => s.points.length), 1);
    const xAt = (i) => plotX + (pointCount <= 1 ? plotW / 2 : (i / (pointCount - 1)) * plotW);
    const yAt = (v) => plotY + plotH - ((v - minY) / (maxY - minY)) * plotH;

    // Marco y rejilla horizontal.
    doc.save();
    doc.rect(plotX, plotY, plotW, plotH).lineWidth(0.6).strokeColor(COLOR.hair).stroke();
    const gridLines = 4;
    doc.font('Helvetica').fontSize(7).fillColor(COLOR.muted);
    for (let g = 0; g <= gridLines; g += 1) {
      const value = minY + ((maxY - minY) * g) / gridLines;
      const y = yAt(value);
      if (g > 0 && g < gridLines) {
        doc.moveTo(plotX, y).lineTo(plotX + plotW, y).lineWidth(0.35).strokeColor('#ECEFF2').stroke();
      }
      doc.text(fmtNumber(value, Math.abs(maxY - minY) < 5 ? 2 : 1), this.left, y - 3.5,
        { width: padLeft - 6, align: 'right', lineBreak: false });
    }
    // Línea del cero, si el rango la cruza: separa lo favorable de lo adverso.
    if (minY < 0 && maxY > 0) {
      const zero = yAt(0);
      doc.moveTo(plotX, zero).lineTo(plotX + plotW, zero).lineWidth(0.8).strokeColor('#B0B7BE').dash(2, { space: 2 }).stroke();
      doc.undash();
    }
    doc.restore();

    // Series.
    for (const s of series) {
      doc.save().lineWidth(s.width || 1.4).strokeColor(s.color || COLOR.accent);
      if (s.dashed) doc.dash(3, { space: 2 });
      let started = false;
      s.points.forEach((point, i) => {
        if (point.y === null || !Number.isFinite(point.y)) {
          // Hueco en los datos: se corta la línea en vez de interpolar. Unir
          // dos puntos separados por un día sin recolección dibuja una
          // tendencia que nunca existió.
          started = false;
          return;
        }
        const x = xAt(i);
        const y = yAt(point.y);
        if (!started) { doc.moveTo(x, y); started = true; } else { doc.lineTo(x, y); }
      });
      doc.stroke();
      doc.undash();
      doc.restore();

      // Puntos, sólo si la serie es corta; con 90 días serían una mancha.
      if (s.points.length <= 45) {
        doc.save().fillColor(s.color || COLOR.accent);
        s.points.forEach((point, i) => {
          if (point.y === null || !Number.isFinite(point.y)) return;
          doc.circle(xAt(i), yAt(point.y), 1.6).fill();
        });
        doc.restore();
      }
    }

    // Eje X: como máximo 8 etiquetas para que no se encimen.
    const base = series[0]?.points || [];
    const step = Math.max(1, Math.ceil(base.length / 8));
    doc.font('Helvetica').fontSize(7).fillColor(COLOR.muted);
    base.forEach((point, i) => {
      if (i % step !== 0 && i !== base.length - 1) return;
      doc.text(fmtDateShort(point.x), xAt(i) - 14, plotY + plotH + 5, { width: 28, align: 'center', lineBreak: false });
    });

    // Leyenda.
    let legendX = plotX;
    const legendY = plotY + plotH + 15;
    doc.fontSize(7.5);
    for (const s of series) {
      doc.save().rect(legendX, legendY + 1.5, 9, 3).fill(s.color || COLOR.accent).restore();
      doc.fillColor(COLOR.ink).text(s.label, legendX + 13, legendY, { lineBreak: false });
      legendX += 13 + doc.widthOfString(s.label) + 16;
    }

    doc.y = top + height + 12;
    doc.x = this.left;
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(9.5);
  }
}

// ── Secciones ───────────────────────────────────────────────────────────────

function coverPage(doc, L, data) {
  const { campaign, period, overview } = data;
  const centerWidth = L.width;

  doc.save().rect(0, 0, doc.page.width, 150).fill(COLOR.accent).restore();
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11)
    .text('OESTE-SENTIMIENTOS', L.left, 44, { characterSpacing: 2.5 });
  doc.font('Helvetica').fontSize(9.5)
    .text('Análisis de conversación pública digital', L.left, 62);
  doc.font('Helvetica').fontSize(8.5).fillColor('#C9D6E8')
    .text(campaign.organization_name || '', L.left, 116, { width: centerWidth });

  doc.y = 200;
  doc.fillColor(COLOR.muted).font('Helvetica').fontSize(10)
    .text('INFORME DE CAMPAÑA', L.left, doc.y, { characterSpacing: 1.5 });
  doc.moveDown(0.6);

  doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(26)
    .text(campaign.name, L.left, doc.y, { width: centerWidth, lineGap: 2 });
  doc.moveDown(0.4);

  doc.font('Helvetica').fontSize(11).fillColor(COLOR.muted)
    .text([campaign.code, campaign.contest_label, campaign.geo_area_name].filter(Boolean).join('  ·  '),
      L.left, doc.y, { width: centerWidth });
  doc.moveDown(1.6);

  // Ficha del periodo. Que el periodo esté en la portada evita que alguien
  // cite el informe sin decir de cuándo son los datos.
  const rows = [
    ['Periodo analizado', `${fmtDate(period.start)} — ${fmtDate(period.end)} (${period.days} días)`],
    ['Generado', fmtDateTime(data.generated_at)],
    ['Solicitado por', data.generated_by || 's/d'],
    ['Contenidos analizados', overview ? fmtNumber(overview.total_mentions) : '0'],
    ['Autores únicos', overview ? fmtNumber(overview.unique_authors) : '0'],
    ['Fuentes activas', fmtNumber(campaign.active_source_count)],
  ];
  if (campaign.election_date) {
    rows.push(['Fecha de la elección',
      `${fmtDate(campaign.election_date)}${campaign.days_to_election !== null ? ` (faltan ${campaign.days_to_election} días)` : ''}`]);
  }

  const boxTop = doc.y;
  const lineH = 19;
  doc.save().rect(L.left, boxTop, L.width, rows.length * lineH + 14).fill(COLOR.panel).restore();
  let y = boxTop + 8;
  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.muted)
      .text(label, L.left + 12, y, { width: 150, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.ink)
      .text(value, L.left + 168, y, { width: L.width - 180, lineBreak: false });
    y += lineH;
  }
  doc.y = boxTop + rows.length * lineH + 26;

  if (campaign.in_blackout) {
    L.callout(
      'INFORME GENERADO DURANTE LA VEDA ELECTORAL',
      `La campaña está en periodo de veda (${fmtDate(campaign.blackout_starts_on)} — ${fmtDate(campaign.blackout_ends_on)}). `
      + 'Este documento es de uso interno. Su difusión, publicación o uso propagandístico puede infringir la normativa '
      + 'electoral aplicable. Verifique las obligaciones vigentes antes de compartirlo.',
      COLOR.blackout,
    );
  }

  // Aviso de interpretación en portada: es lo primero que debe leerse, no una
  // nota al pie que nadie llega a ver.
  L.callout(
    'Qué mide y qué no mide este informe',
    'Los indicadores describen la conversación pública digital observada en las fuentes listadas en la nota '
    + 'metodológica. No son una medición de intención de voto ni una encuesta. Lea la nota metodológica del final '
    + 'antes de tomar decisiones a partir de estas cifras.',
    COLOR.accent,
  );
}

function executiveSummary(doc, L, data) {
  const { overview, risk, campaign, period } = data;
  L.h1('1. Resumen ejecutivo');

  if (!overview || Number(overview.total_mentions || 0) === 0) {
    L.p('No se registraron contenidos analizados para esta campaña en el periodo seleccionado. '
      + 'No se presentan indicadores porque no hay base para calcularlos.', { color: COLOR.muted });
    return;
  }

  const net = overview.net_sentiment;
  const momentum = overview.sentiment_momentum;
  const tone = net === null ? 'indeterminado' : (net > 5 ? 'favorable' : (net < -5 ? 'adverso' : 'equilibrado'));
  const trend = momentum === null ? 'sin comparación disponible'
    : (momentum > 2 ? 'con mejora respecto al periodo previo'
      : (momentum < -2 ? 'con deterioro respecto al periodo previo' : 'estable respecto al periodo previo'));

  L.p(
    `Entre el ${fmtDate(period.start)} y el ${fmtDate(period.end)} se analizaron `
    + `${fmtNumber(overview.total_mentions)} contenidos de ${fmtNumber(overview.unique_authors)} autores únicos `
    + `sobre la campaña ${campaign.name}. El balance de sentimiento neto es de ${fmtNumber(net, 1)} puntos, `
    + `un tono ${tone}, ${trend}. La polarización del periodo se sitúa en ${fmtNumber(overview.polarization_index, 2)} `
    + `y la toxicidad promedio en ${fmtNumber(overview.avg_toxicity, 3)}.`,
  );

  // Tarjetas de indicadores. Tres por fila para que quepan en el ancho útil.
  const cards = [
    { label: 'Menciones', value: fmtNumber(overview.total_mentions), color: COLOR.accent },
    { label: 'Sentimiento neto', value: fmtNumber(net, 1), color: net >= 0 ? COLOR.positive : COLOR.negative },
    { label: 'Negativo', value: fmtPct(overview.negative_pct), color: COLOR.negative },
    { label: 'Alcance estimado', value: fmtNumber(overview.total_reach), color: COLOR.accent },
    { label: 'Alertas abiertas', value: fmtNumber(overview.open_alerts), color: Number(overview.open_alerts) > 0 ? COLOR.warning : COLOR.muted },
    {
      label: 'Riesgo de crisis (24 h)',
      value: risk ? `${fmtNumber(risk.risk_index, 1)} · ${risk.risk_level || 's/d'}` : 's/d',
      color: risk && Number(risk.risk_index) >= 60 ? COLOR.negative : COLOR.muted,
    },
  ];

  const perRow = 3;
  const cardW = (L.width - 10 * (perRow - 1)) / perRow;
  const cardH = 46;
  L.ensure(cardH * 2 + 16);
  let cx = L.left;
  let cy = doc.y;
  cards.forEach((card, i) => {
    if (i > 0 && i % perRow === 0) { cx = L.left; cy += cardH + 10; }
    doc.save().rect(cx, cy, cardW, cardH).fill(COLOR.panel).restore();
    doc.save().rect(cx, cy, 3, cardH).fill(card.color).restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
      .text(card.label.toUpperCase(), cx + 10, cy + 8, { width: cardW - 16, lineBreak: false, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(card.color)
      .text(card.value, cx + 10, cy + 21, { width: cardW - 16, lineBreak: false });
    cx += cardW + 10;
  });
  doc.y = cy + cardH + 16;
  doc.x = L.left;

  if (overview.is_reliable === false) {
    L.callout(
      'Muestra por debajo del mínimo de fiabilidad',
      'El volumen del periodo no alcanza el mínimo que el registro de indicadores exige para considerar estas '
      + 'cifras publicables. Se muestran para no ocultar información, pero no deben leerse como tendencia ni '
      + 'compararse con otros periodos.',
    );
  }

  if (risk && risk.explanation) {
    L.h2('Riesgo de crisis en las últimas 24 horas');
    L.p(risk.explanation, { size: 9 });
    if (risk.is_reliable === false) {
      L.p('El índice se calculó sobre una muestra insuficiente; tómelo como indicativo.', { size: 8.5, color: COLOR.muted });
    }
  }
}

function sentimentDistribution(doc, L, data) {
  const { overview } = data;
  L.h1('2. Distribución de sentimiento');

  if (!overview || Number(overview.total_mentions || 0) === 0) {
    L.p('Sin contenidos analizados en el periodo.', { color: COLOR.muted });
    return;
  }

  const total = Number(overview.total_mentions) || 0;
  const buckets = [
    { key: 'positive', label: 'Positivo', count: Number(overview.positive_count) || 0, color: COLOR.positive },
    { key: 'neutral', label: 'Neutral', count: Number(overview.neutral_count) || 0, color: COLOR.neutral },
    { key: 'negative', label: 'Negativo', count: Number(overview.negative_count) || 0, color: COLOR.negative },
    { key: 'mixed', label: 'Mixto', count: Number(overview.mixed_count) || 0, color: COLOR.mixed },
  ];

  L.table(
    [
      { label: 'Categoría', key: 'label', width: 2, bold: true },
      { label: 'Contenidos', key: 'count', width: 1.4, align: 'right', format: (v) => fmtNumber(v) },
      { label: 'Porcentaje', key: 'pct', width: 1.4, align: 'right', format: (v) => fmtPct(v) },
    ],
    buckets.map((b) => ({ ...b, pct: total === 0 ? 0 : (b.count * 100) / total })),
  );

  L.h2('Reparto visual');
  L.barChart(
    buckets.map((b) => ({
      label: b.label,
      value: total === 0 ? 0 : (b.count * 100) / total,
      color: b.color,
      display: `${fmtPct(total === 0 ? 0 : (b.count * 100) / total)} (${fmtNumber(b.count)})`,
    })),
    { max: 100 },
  );

  L.p(
    `Sentimiento neto: ${fmtNumber(overview.net_sentiment, 1)} puntos. `
    + `Puntuación promedio: ${fmtNumber(overview.avg_sentiment_score, 3)}. `
    + `Confianza promedio del clasificador: ${fmtNumber(overview.avg_confidence, 3)}. `
    + `Contenidos en cola de revisión humana: ${fmtNumber(overview.review_backlog)}.`,
    { size: 9, color: COLOR.muted },
  );
}

function timelineSection(doc, L, data) {
  const rows = data.sections.timeline || [];
  L.h1('3. Evolución temporal');

  if (rows.length === 0) {
    L.p('Sin serie temporal para el periodo seleccionado.', { color: COLOR.muted });
    return;
  }

  L.h2('Sentimiento neto por día');
  L.lineChart([
    {
      label: 'Sentimiento neto',
      color: COLOR.accent,
      points: rows.map((r) => ({ x: r.period, y: r.net_sentiment })),
    },
    {
      label: 'Media móvil 7 días',
      color: COLOR.positive,
      dashed: true,
      width: 1.1,
      points: rows.map((r) => ({ x: r.period, y: r.rolling_avg_7 })),
    },
  ]);

  L.h2('Volumen diario de contenidos');
  L.lineChart([
    {
      label: 'Contenidos analizados',
      color: COLOR.mixed,
      points: rows.map((r) => ({ x: r.period, y: Number(r.total_count) })),
    },
  ], { zeroBaseline: true, height: 130 });

  const spikes = rows.filter((r) => r.is_spike);
  if (spikes.length > 0) {
    L.p(
      `Se detectaron ${spikes.length} días con volumen anómalo: `
      + `${spikes.slice(0, 10).map((s) => fmtDateShort(s.period)).join(', ')}`
      + `${spikes.length > 10 ? '…' : ''}. Un pico de volumen puede deberse a un hecho real o a un cambio en la `
      + 'cobertura de las fuentes; conviene verificar ambas cosas antes de interpretarlo.',
      { size: 9 },
    );
  }

  const unreliable = rows.filter((r) => r.is_reliable === false).length;
  if (unreliable > 0) {
    L.p(`${unreliable} de ${rows.length} días quedan por debajo del volumen mínimo de fiabilidad y aparecen en la `
      + 'gráfica sin marca especial; considérelo al leer la pendiente.', { size: 8.5, color: COLOR.muted });
  }
}

function contendersSection(doc, L, data) {
  const rows = data.sections.contenders || [];
  L.h1('4. Tablero competitivo');

  if (rows.length === 0) {
    L.p('No hay contendientes con menciones en el periodo.', { color: COLOR.muted });
    return;
  }

  L.table(
    [
      { label: '#', key: 'rank_by_wilson', width: 0.4, align: 'right' },
      { label: 'Contendiente', key: 'contender_name', width: 2.4, bold: true },
      { label: 'Menciones', key: 'mentions', width: 1, align: 'right', format: (v) => fmtNumber(v) },
      { label: 'Conversación', key: 'share_of_voice', width: 1.1, align: 'right', format: (v) => fmtPct(v) },
      {
        label: 'Apoyo neto',
        key: 'net_support',
        width: 1,
        align: 'right',
        format: (v) => fmtNumber(v, 1),
        color: (v) => (Number(v) >= 0 ? COLOR.positive : COLOR.negative),
      },
      { label: 'Wilson LB', key: 'support_wilson_lb', width: 1, align: 'right', format: (v) => fmtNumber(v, 1) },
      {
        label: 'Momento',
        key: 'competitive_momentum',
        width: 0.9,
        align: 'right',
        format: (v) => (v === null ? 's/d' : `${Number(v) > 0 ? '+' : ''}${fmtNumber(v, 1)}`),
        color: (v) => (v === null ? COLOR.muted : (Number(v) >= 0 ? COLOR.positive : COLOR.negative)),
      },
      { label: 'Fiable', key: 'is_reliable', width: 0.6, align: 'center', format: (v) => (v ? 'Sí' : 'No'), color: (v) => (v ? COLOR.ink : COLOR.warning) },
    ],
    rows,
  );

  L.h2('Participación en la conversación');
  L.barChart(
    rows.slice(0, 10).map((r) => ({
      label: r.contender_name,
      value: r.share_of_voice ?? 0,
      color: r.is_own ? COLOR.accent : COLOR.neutral,
      display: fmtPct(r.share_of_voice),
    })),
    { max: 100 },
  );

  L.callout(
    'Cómo leer el apoyo neto',
    'El apoyo neto resume la postura detectada en los textos que mencionan a cada contendiente; no es una '
    + 'estimación de voto. La columna "Wilson LB" es el límite inferior del intervalo de confianza: con pocas '
    + 'menciones se aleja mucho del valor puntual, y esa distancia es precisamente la incertidumbre. Ordene por '
    + 'Wilson LB, no por apoyo neto, cuando compare contendientes con volúmenes muy distintos.',
    COLOR.accent,
  );

  const lowAttribution = rows.filter((r) => r.model_attribution_ratio !== null && Number(r.model_attribution_ratio) < 0.6);
  if (lowAttribution.length > 0) {
    L.p(
      `En ${lowAttribution.length} contendiente(s) menos del 60 % de las posturas provienen de atribución directa del `
      + 'modelo; el resto se infirió por coincidencia de alias o mención. Trate esas filas con cautela adicional.',
      { size: 8.5, color: COLOR.warning },
    );
  }
}

function topicsSection(doc, L, data) {
  const rows = data.sections.topics || [];
  L.h1('5. Agenda de temas');

  if (rows.length === 0) {
    L.p('No se clasificaron temas en el periodo.', { color: COLOR.muted });
    return;
  }

  L.table(
    [
      { label: 'Tema', key: 'label_es', width: 2.4, bold: true },
      { label: 'Dimensión', key: 'dimension', width: 1.2 },
      { label: 'Menciones', key: 'mentions', width: 1, align: 'right', format: (v) => fmtNumber(v) },
      { label: 'Peso', key: 'topic_share', width: 0.9, align: 'right', format: (v) => fmtPct(v) },
      {
        label: 'Sentimiento',
        key: 'avg_sentiment',
        width: 1,
        align: 'right',
        format: (v) => fmtNumber(v, 2),
        color: (v) => (Number(v) >= 0 ? COLOR.positive : COLOR.negative),
      },
      { label: 'Negativo', key: 'negative_pct', width: 0.9, align: 'right', format: (v) => fmtPct(v) },
      {
        label: 'Crecimiento',
        key: 'topic_growth',
        width: 1,
        align: 'right',
        format: (v) => (v === null ? 's/d' : `${Number(v) > 0 ? '+' : ''}${fmtPct(v)}`),
        color: (v) => (v === null ? COLOR.muted : (Number(v) >= 0 ? COLOR.positive : COLOR.negative)),
      },
      { label: 'Emergente', key: 'is_emerging', width: 0.8, align: 'center', format: (v) => (v ? 'Sí' : '') },
    ],
    rows,
  );

  const emerging = rows.filter((r) => r.is_emerging);
  if (emerging.length > 0) {
    L.h2('Temas emergentes');
    L.p(
      `Crecen aceleradamente: ${emerging.map((t) => t.label_es).join(', ')}. `
      + 'Un tema emergente con sentimiento negativo es el candidato natural a convertirse en la próxima crisis; '
      + 'uno con sentimiento positivo, a ser el mensaje que ya está funcionando.',
      { size: 9 },
    );
  }
}

function alertsSection(doc, L, data) {
  const rows = data.sections.alerts || [];
  L.h1('6. Alertas del periodo');

  if (rows.length === 0) {
    L.p('No se generaron alertas en el periodo. Verifique también que haya reglas activas: la ausencia de alertas '
      + 'puede significar que no pasó nada o que nadie configuró qué vigilar.', { color: COLOR.muted });
    return;
  }

  const bySeverity = rows.reduce((acc, r) => {
    acc[r.severity_code] = (acc[r.severity_code] || 0) + 1;
    return acc;
  }, {});

  L.p(
    `${rows.length} alertas en el periodo`
    + `${data.open_alerts ? `, ${data.open_alerts.open_now} siguen abiertas (${data.open_alerts.critical_now} críticas)` : ''}. `
    + `Reparto: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  );

  L.table(
    [
      { label: 'Fecha', key: 'created_at', width: 1.1, format: (v) => fmtDateTime(v).slice(0, 16) },
      {
        label: 'Sev.',
        key: 'severity_label',
        width: 0.7,
        bold: true,
        color: (v, row) => SEVERITY_COLOR[row.severity_code] || COLOR.ink,
      },
      { label: 'Tipo', key: 'alert_type_label', width: 1.3 },
      { label: 'Título', key: 'title', width: 3, format: (v) => truncate(v, 60) },
      {
        label: 'Observado',
        key: 'observed_value',
        width: 0.9,
        align: 'right',
        format: (v, row) => (v === null ? 's/d' : `${fmtNumber(v, 2)}${row.metric_unit === 'percent' ? ' %' : ''}`),
      },
      { label: 'Umbral', key: 'threshold_value', width: 0.8, align: 'right', format: (v) => fmtNumber(v, 2) },
      { label: 'n', key: 'sample_size', width: 0.6, align: 'right', format: (v) => fmtNumber(v) },
      { label: 'Estado', key: 'status', width: 0.9 },
    ],
    rows.slice(0, 40),
  );

  if (rows.length > 40) {
    L.p(`Se muestran las 40 alertas de mayor severidad de un total de ${rows.length}. El listado completo está en el tablero.`,
      { size: 8.5, color: COLOR.muted });
  }

  const blackoutAlerts = rows.filter((r) => r.during_blackout).length;
  if (blackoutAlerts > 0) {
    L.p(`${blackoutAlerts} alerta(s) se generaron durante la veda electoral y quedaron registradas sin notificación externa.`,
      { size: 9, color: COLOR.warning });
  }

  const falsePositives = rows.filter((r) => r.was_false_positive).length;
  if (falsePositives > 0) {
    L.p(`${falsePositives} alerta(s) se marcaron como falso positivo al revisarse. Si la proporción es alta, el umbral `
      + 'de la regla correspondiente está mal calibrado y conviene ajustarlo antes de que el equipo empiece a '
      + 'ignorar las notificaciones.', { size: 9, color: COLOR.warning });
  }
}

/**
 * Nota metodológica. OBLIGATORIA y siempre al final.
 *
 * Es la sección que separa un informe defendible de un tablero de números
 * sueltos. Dice qué se midió, sobre qué muestra, con qué fuentes y con qué
 * limitaciones, y arrastra la advertencia (caveat) de cada indicador desde
 * civic_kpi.metric_registry en lugar de repetirla a mano.
 */
function methodologySection(doc, L, data) {
  const { campaign, period, overview, sources, metrics, models } = data;

  doc.addPage();
  L.h1('Nota metodológica');

  L.callout(
    'Este informe no mide intención de voto',
    'Los indicadores describen la CONVERSACIÓN PÚBLICA DIGITAL registrada en las fuentes listadas más abajo. '
    + 'No son, ni pueden convertirse en, una estimación de resultados electorales. Quien publica en redes y medios '
    + 'digitales NO constituye una muestra representativa del electorado: está sesgado por edad, nivel de acceso a '
    + 'internet, intensidad de la opinión y por los propios algoritmos de distribución de cada plataforma. Un '
    + 'contendiente puede dominar la conversación digital y perder la elección, y al revés.',
    COLOR.blackout,
  );

  L.h2('Universo y tamaño de muestra');
  const total = overview ? Number(overview.total_mentions || 0) : 0;
  L.p(
    `El informe se calcula sobre ${fmtNumber(total)} contenidos analizados, publicados entre el `
    + `${fmtDate(period.start)} y el ${fmtDate(period.end)} (${period.days} días), procedentes de `
    + `${fmtNumber(overview?.unique_authors)} autores únicos. `
    + 'El conteo de autores únicos se hace sobre un identificador seudonimizado: una misma persona con varias '
    + 'cuentas se cuenta varias veces, por lo que es una cota superior y no un número de personas. '
    + 'Se excluyen del cálculo los contenidos marcados como duplicados o excluidos, y las inferencias sustituidas '
    + 'por un reanálisis posterior.',
  );

  if (overview && overview.is_reliable === false) {
    L.p('ATENCIÓN: el volumen del periodo está por debajo del mínimo de fiabilidad definido en el registro de '
      + 'indicadores. Las cifras se publican por transparencia, no porque sean concluyentes.',
    { bold: true, color: COLOR.warning, size: 9 });
  }

  L.h2('Fuentes incluidas');
  if (!sources || sources.length === 0) {
    L.p('No hay fuentes registradas para esta campaña.', { color: COLOR.muted });
  } else {
    L.table(
      [
        { label: 'Fuente', key: 'name', width: 2.2, bold: true },
        { label: 'Tipo', key: 'type_label', width: 1.4 },
        { label: 'Dato público', key: 'is_public_data', width: 0.9, align: 'center', format: (v) => (v ? 'Sí' : 'No') },
        { label: 'Base legal', key: 'legal_basis', width: 1.6, format: (v) => truncate(v || 's/d', 34) },
        { label: 'Vol. 7 días', key: 'volume_7d', width: 1, align: 'right', format: (v) => fmtNumber(v) },
        {
          label: 'Salud',
          key: 'health',
          width: 0.9,
          format: (v) => v || 's/d',
          color: (v) => (v === 'healthy' ? COLOR.positive : (v === 'unknown' ? COLOR.muted : COLOR.warning)),
        },
      ],
      sources,
    );
    const degraded = sources.filter((s) => s.health && s.health !== 'healthy' && s.health !== 'unknown');
    if (degraded.length > 0) {
      L.p(
        `${degraded.length} fuente(s) presentan problemas de recolección en el periodo `
        + `(${degraded.map((s) => s.name).join(', ')}). Una caída de volumen atribuida a "menos conversación" puede `
        + 'ser en realidad una fuente que dejó de reportar. Contraste siempre ambas explicaciones.',
        { size: 9, color: COLOR.warning },
      );
    }
  }

  L.h2('Procesamiento');
  if (models && models.length > 0) {
    L.p(
      'La clasificación de sentimiento, emociones, postura y temas la realizaron los siguientes modelos: '
      + `${models.map((m) => `${m.model_name || 'sin identificar'} (${fmtNumber(m.n)} contenidos)`).join('; ')}. `
      + 'Cada inferencia conserva la versión del modelo y del prompt con la que se produjo, de modo que un '
      + 'resultado puede reproducirse o reanalizarse.',
    );
  } else {
    L.p('No se registraron modelos para las inferencias del periodo.', { color: COLOR.muted });
  }
  L.p(
    'La clasificación es automática y tiene error. El sistema marca para revisión humana los casos de baja '
    + 'confianza, sospecha de sarcasmo o riesgo alto; esos contenidos pueden cambiar de etiqueta tras la revisión. '
    + `Confianza promedio del clasificador en este periodo: ${fmtNumber(overview?.avg_confidence, 3)}. `
    + `Contenidos pendientes de revisión: ${fmtNumber(overview?.review_backlog)}.`,
    { size: 9 },
  );

  L.h2('Definición y advertencias de cada indicador');
  L.p(
    'Cada indicador del registro trae su propia advertencia de interpretación. Se reproducen íntegras: son parte '
    + 'del dato, no una nota al margen.',
    { size: 9, color: COLOR.muted },
  );

  if (!metrics || metrics.length === 0) {
    L.p('No se pudo leer el registro de indicadores.', { color: COLOR.muted });
  } else {
    for (const m of metrics) {
      L.ensure(52);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.accent)
        .text(`${m.label_es} (${m.code})`, L.left, doc.y, { width: L.width });
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.ink)
        .text(m.definition, L.left + 10, doc.y, { width: L.width - 10, lineGap: 1 });
      doc.moveDown(0.1);
      const meta = [
        m.formula ? `Fórmula: ${m.formula}` : null,
        m.unit ? `Unidad: ${m.unit}` : null,
        `Muestra mínima: ${fmtNumber(m.min_sample_size)}`,
      ].filter(Boolean).join('  ·  ');
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
        .text(meta, L.left + 10, doc.y, { width: L.width - 10 });
      if (m.caveat) {
        doc.moveDown(0.1);
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLOR.warning)
          .text(`Advertencia: ${m.caveat}`, L.left + 10, doc.y, { width: L.width - 10, lineGap: 1 });
      }
      doc.moveDown(0.7);
      doc.fillColor(COLOR.ink);
    }
  }

  L.h2('Limitaciones generales');
  const limitations = [
    'La cobertura depende de las fuentes activas y de sus condiciones de acceso. Lo que no se recolecta no existe para este informe.',
    'El volumen no equivale a apoyo: una campaña de crítica intensa genera más conversación que una aprobación silenciosa.',
    'Los indicadores de postura sólo consideran los textos que mencionan explícitamente a un contendiente.',
    'Las cuentas automatizadas y la actividad coordinada distorsionan el volumen; se detectan cuando es posible, pero no se eliminan del conteo salvo indicación expresa.',
    'Las comparaciones entre periodos exigen cobertura equivalente: si cambiaron las fuentes, la comparación no es válida.',
    'Ningún indicador de este informe debe usarse para tomar acciones sobre personas identificadas. Las banderas de riesgo existen para proteger al equipo y priorizar respuesta, no para perfilar autores.',
  ];
  for (const item of limitations) {
    L.ensure(24);
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.ink)
      .text(`•  ${item}`, L.left + 6, doc.y, { width: L.width - 12, lineGap: 1 });
    doc.moveDown(0.35);
  }

  L.h2('Trazabilidad');
  L.p(
    `Campaña: ${campaign.name} (${campaign.code}). Organización: ${campaign.organization_name || 's/d'}. `
    + `Zona horaria de referencia: ${campaign.timezone || 'UTC'}. `
    + `Informe generado el ${fmtDateTime(data.generated_at)} por ${data.generated_by || 's/d'}. `
    + 'Los datos provienen del esquema civic_api / civic_kpi de Análisis de Sentimientos y pueden reproducirse consultando las '
    + 'mismas funciones con los mismos parámetros.',
    { size: 8.5, color: COLOR.muted },
  );
}

// ── Decoración de todas las páginas ─────────────────────────────────────────
/**
 * Pie de página con numeración y, si procede, marca de veda.
 *
 * Sólo es posible gracias a bufferPages: true. Se ejecuta DESPUÉS de componer
 * el contenido y ANTES de doc.end().
 */
function decoratePages(doc, data) {
  const range = doc.bufferedPageRange();
  const total = range.count;

  for (let i = range.start; i < range.start + total; i += 1) {
    doc.switchToPage(i);

    // Escribir en la zona del margen inferior dispararía un salto de página
    // automático. Anular temporalmente el margen es la forma soportada de
    // evitarlo (y hay que restaurarlo, o el resto del documento se descuadra).
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const y = doc.page.height - 42;

    // La portada (índice 0) no lleva pie: rompería el bloque de color.
    if (i > range.start) {
      doc.save();
      doc.moveTo(left, y - 8).lineTo(left + width, y - 8).lineWidth(0.5).strokeColor(COLOR.hair).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
        .text(
          `${data.campaign.name} · ${data.campaign.code} · ${fmtDate(data.period.start)} a ${fmtDate(data.period.end)}`,
          left, y, { width: width * 0.7, lineBreak: false },
        );
      doc.text(`Página ${i - range.start + 1} de ${total}`, left + width * 0.7, y,
        { width: width * 0.3, align: 'right', lineBreak: false });
      doc.restore();
    }

    // Marca de veda electoral, en diagonal y sobre todas las páginas.
    if (data.campaign.in_blackout) {
      doc.save();
      doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(52).fillColor(COLOR.blackout).fillOpacity(0.1)
        .text('VEDA ELECTORAL', 0, doc.page.height / 2 - 34,
          { width: doc.page.width, align: 'center', lineBreak: false });
      doc.fillOpacity(1);
      doc.restore();

      // Franja superior, legible y no decorativa: quien reciba una hoja suelta
      // debe poder ver de qué se trata.
      doc.save();
      doc.rect(0, 0, doc.page.width, 15).fillOpacity(0.92).fill(COLOR.blackout);
      doc.fillOpacity(1).font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
        .text('DOCUMENTO GENERADO EN VEDA ELECTORAL · USO INTERNO · NO DIFUNDIR', 0, 4,
          { width: doc.page.width, align: 'center', lineBreak: false, characterSpacing: 0.6 });
      doc.restore();
    }

    doc.page.margins.bottom = savedBottom;
  }
}

// ── Punto de entrada ────────────────────────────────────────────────────────
/**
 * Compone el PDF y lo escribe en `stream`.
 * @returns {Promise<void>} se resuelve cuando el stream termina de escribirse.
 */
function renderCampaignReport(data, stream) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      // Sin esto no hay numeración de páginas ni marca de veda retroactiva.
      bufferPages: true,
      size: PAGE.size,
      margins: PAGE.margins,
      autoFirstPage: true,
      info: {
        Title: `Informe de campaña · ${data.campaign.name}`,
        Author: 'Análisis de Sentimientos',
        Subject: `Análisis de conversación pública digital · ${data.campaign.code}`,
        Keywords: 'oeste-sentimientos, campaña, sentimiento, conversación digital',
        CreationDate: new Date(),
      },
    });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    stream.on('error', fail);
    doc.on('error', fail);
    stream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });

    try {
      doc.pipe(stream);
      const L = new Layout(doc);
      const wanted = new Set(data.requested_sections || Object.keys(data.sections));

      coverPage(doc, L, data);

      if (wanted.has('executive_summary')) { doc.addPage(); executiveSummary(doc, L, data); }
      if (wanted.has('sentiment_distribution')) { doc.addPage(); sentimentDistribution(doc, L, data); }
      if (wanted.has('timeline')) { doc.addPage(); timelineSection(doc, L, data); }
      if (wanted.has('contenders')) { doc.addPage(); contendersSection(doc, L, data); }
      if (wanted.has('topics')) { doc.addPage(); topicsSection(doc, L, data); }
      if (wanted.has('alerts')) { doc.addPage(); alertsSection(doc, L, data); }

      // Siempre, se pida o no. Un informe sin nota metodológica no debe salir
      // de este servicio.
      methodologySection(doc, L, data);

      decoratePages(doc, data);
      doc.end();
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { renderCampaignReport, COLOR, fmtNumber, fmtPct, fmtDate };
