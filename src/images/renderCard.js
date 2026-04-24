const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const { log } = require('../logger');
const { escapeHtml } = require('../telegram/pairStyling');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'runtime', 'generated-cards');

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getLogoPath() {
  const configuredPath = String(config.telegram.brandLogoPath || '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .trim();

  if (!configuredPath) {
    return '';
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(path.join(__dirname, '..', '..'), configuredPath);
}

function renderRows(rows = [], startY = 796, rowGap = 58) {
  return rows
    .map((row, index) => {
      const y = startY + index * rowGap;
      return `
        <text x="96" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="28" fill="#8ea6c3">${escapeHtml(row.label)}</text>
        <text x="984" y="${y}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="32" font-weight="700" fill="#f6f8fb">${escapeHtml(row.value)}</text>
      `;
    })
    .join('');
}

function renderChart(chart) {
  if (!chart || !Array.isArray(chart.points) || chart.points.length === 0) {
    return '';
  }

  const chartX = 96;
  const chartY = 280;
  const chartWidth = 888;
  const chartHeight = 410;
  const values = chart.points.map((point) => Number(point.value)).filter(Number.isFinite);

  if (values.length === 0) {
    return '';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, Math.max(Math.abs(max) * 0.01, 1));
  const toY = (value) => chartY + chartHeight - ((value - min) / range) * chartHeight;

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const y = chartY + (chartHeight / 4) * index;
    return `<line x1="${chartX}" y1="${y}" x2="${chartX + chartWidth}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />`;
  }).join('');

  const candleCount = 16;
  const candleGap = 10;
  const candleWidth = 28;
  const totalCandlesWidth = candleCount * candleWidth + (candleCount - 1) * candleGap;
  const candleStartX = chartX + (chartWidth - totalCandlesWidth) / 2;
  const firstValue = Number(chart.points[0].value);
  const lastValue = Number(chart.points[chart.points.length - 1].value);
  const directionUp = lastValue >= firstValue;
  const candles = [];

  for (let index = 0; index < candleCount; index += 1) {
    const progress = index / Math.max(1, candleCount - 1);
    const wave = Math.sin(progress * Math.PI * 1.2) * range * 0.06;
    const drift = directionUp ? progress * range * 0.72 : -progress * range * 0.72;
    const base = firstValue + drift + wave;
    const open = base + (index % 2 === 0 ? -range * 0.03 : range * 0.02);
    const close = base + (directionUp ? range * 0.035 : -range * 0.035) + Math.cos(progress * Math.PI * 2) * range * 0.015;
    const wickHigh = Math.max(open, close) + range * (0.035 + (index % 3) * 0.008);
    const wickLow = Math.min(open, close) - range * (0.03 + (index % 4) * 0.006);
    candles.push({ open, close, wickHigh, wickLow });
  }

  const candleSvg = candles
    .map((candle, index) => {
      const x = candleStartX + index * (candleWidth + candleGap);
      const openY = toY(candle.open);
      const closeY = toY(candle.close);
      const highY = toY(candle.wickHigh);
      const lowY = toY(candle.wickLow);
      const bodyY = Math.min(openY, closeY);
      const bodyHeight = Math.max(10, Math.abs(closeY - openY));
      const bullish = candle.close >= candle.open;
      const bodyColor = bullish ? '#43d17a' : '#ff6b6b';
      const glowColor = bullish ? 'rgba(67,209,122,0.20)' : 'rgba(255,107,107,0.20)';

      return `
        <line x1="${x + candleWidth / 2}" y1="${highY}" x2="${x + candleWidth / 2}" y2="${lowY}" stroke="${bodyColor}" stroke-opacity="0.75" stroke-width="4" stroke-linecap="round" />
        <rect x="${x}" y="${bodyY}" width="${candleWidth}" height="${bodyHeight}" rx="8" fill="${bodyColor}" />
        <rect x="${x - 2}" y="${bodyY - 2}" width="${candleWidth + 4}" height="${bodyHeight + 4}" rx="10" fill="${glowColor}" />
      `;
    })
    .join('');

  const levelLines = chart.points
    .map((point) => {
      const y = toY(Number(point.value));
      const color = point.color || '#f6f8fb';
      return `
        <line x1="${chartX}" y1="${y}" x2="${chartX + chartWidth}" y2="${y}" stroke="${color}" stroke-opacity="0.24" stroke-width="2" stroke-dasharray="10 10" />
      `;
    })
    .join('');

  const markers = chart.points
    .map((point, index) => {
      const x = chartX + 34 + index * ((chartWidth - 68) / Math.max(1, chart.points.length - 1));
      const y = toY(Number(point.value));
      const color = point.color || '#f6f8fb';
      const labelY = index % 2 === 0 ? Math.max(chartY + 26, y - 16) : Math.min(chartY + chartHeight - 14, y + 34);
      return `
        <circle cx="${x}" cy="${y}" r="7" fill="${color}" />
        <text x="${x}" y="${labelY}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" fill="${color}">${escapeHtml(point.label)}</text>
      `;
    })
    .join('');

  const callout = chart.outcomeLabel
    ? `
      <rect x="${chartX + chartWidth - 236}" y="${chartY + 20}" width="212" height="52" rx="18" fill="${chart.outcomeColor || '#f6f8fb'}" fill-opacity="0.18" stroke="${chart.outcomeColor || '#f6f8fb'}" stroke-opacity="0.45" />
      <text x="${chartX + chartWidth - 130}" y="${chartY + 54}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" font-weight="700" fill="${chart.outcomeColor || '#f6f8fb'}">${escapeHtml(chart.outcomeLabel)}</text>
    `
    : '';

  return `
    <rect x="${chartX}" y="${chartY}" width="${chartWidth}" height="${chartHeight}" rx="28" fill="#111d31" fill-opacity="0.95" />
    <text x="${chartX + 24}" y="${chartY + 40}" font-family="Segoe UI, Arial, sans-serif" font-size="20" letter-spacing="3" fill="#8ea6c3">PRICE STRUCTURE</text>
    ${callout}
    ${gridLines}
    ${levelLines}
    ${candleSvg}
    ${markers}
  `;
}

function buildCardSvg({
  eyebrow = 'Trading Bot',
  title,
  subtitle = '',
  accentColor = '#3ea6ff',
  badge = '',
  rows = [],
  footer = 'Educational use only. Manage your own risk.',
  chart = null,
}) {
  const rowGap = 58;
  const infoCardY = 742;
  const infoCardHeight = Math.min(458, Math.max(320, rows.length * rowGap + 76));
  const footerY = infoCardY + infoCardHeight + 56;
  const signatureY = footerY + 48;

  return `
    <svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#07111f" />
          <stop offset="55%" stop-color="#0d1829" />
          <stop offset="100%" stop-color="#151f34" />
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="${accentColor}" />
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0.12" />
        </linearGradient>
      </defs>
      <rect width="1080" height="1350" fill="url(#bg)" />
      <circle cx="930" cy="150" r="260" fill="${accentColor}" fill-opacity="0.08" />
      <circle cx="120" cy="1150" r="190" fill="${accentColor}" fill-opacity="0.06" />
      <rect x="52" y="54" width="976" height="1242" rx="38" fill="#0b1526" fill-opacity="0.88" stroke="rgba(255,255,255,0.08)" />
      <rect x="52" y="54" width="976" height="12" rx="6" fill="url(#accent)" />

      <text x="96" y="122" font-family="Segoe UI, Arial, sans-serif" font-size="24" letter-spacing="5" fill="#8ea6c3">${escapeHtml(eyebrow.toUpperCase())}</text>
      <text x="96" y="194" font-family="Segoe UI, Arial, sans-serif" font-size="60" font-weight="800" fill="#f6f8fb">${escapeHtml(title)}</text>
      <text x="96" y="246" font-family="Segoe UI, Arial, sans-serif" font-size="28" fill="#c5d1e0">${escapeHtml(subtitle)}</text>

      <rect x="764" y="94" width="224" height="68" rx="26" fill="${accentColor}" fill-opacity="0.18" stroke="${accentColor}" stroke-opacity="0.45" />
      <text x="876" y="138" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${escapeHtml(badge)}</text>

      ${renderChart(chart)}

      <rect x="72" y="${infoCardY}" width="936" height="${infoCardHeight}" rx="30" fill="#122039" fill-opacity="0.96" />
      ${renderRows(rows, infoCardY + 62, rowGap)}

      <text x="96" y="${footerY}" font-family="Segoe UI, Arial, sans-serif" font-size="22" fill="#8ea6c3">${escapeHtml(footer)}</text>
      <text x="96" y="${signatureY}" font-family="Segoe UI, Arial, sans-serif" font-size="18" letter-spacing="3" fill="#5f738f">AUTO-GENERATED BY TRADING BOT</text>
    </svg>
  `;
}

async function buildLogoOverlay() {
  const logoPath = getLogoPath();

  if (!logoPath) {
    return null;
  }

  if (!fs.existsSync(logoPath)) {
    log(`[IMAGES] Brand logo not found at ${logoPath}, skipping logo overlay`);
    return null;
  }

  try {
    const trimmedLogo = await sharp(logoPath)
      .trim({ background: { r: 255, g: 255, b: 255, alpha: 1 }, threshold: 18 })
      .resize({
        width: 100,
        height: 100,
        fit: 'cover',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .composite([
        {
          input: Buffer.from(`
            <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" fill="#ffffff" />
            </svg>
          `),
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();

    const ringSvg = Buffer.from(`
      <svg width="132" height="132" viewBox="0 0 132 132" xmlns="http://www.w3.org/2000/svg">
        <circle cx="66" cy="66" r="64" fill="#07111f" fill-opacity="0.84" />
        <circle cx="66" cy="66" r="60" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3" />
      </svg>
    `);

    return await sharp({
      create: {
        width: 132,
        height: 132,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: ringSvg, left: 0, top: 0 },
        { input: trimmedLogo, left: 16, top: 16 },
      ])
      .png()
      .toBuffer();
  } catch (err) {
    log(`[IMAGES] Brand logo could not be processed from ${logoPath}: ${err.message}`);
    return null;
  }
}

async function renderCardImage({ prefix, ...cardData }) {
  ensureOutputDir();
  const svg = buildCardSvg(cardData);
  const baseImage = sharp(Buffer.from(svg));
  const logoOverlay = await buildLogoOverlay();
  const pipeline = logoOverlay
    ? baseImage.composite([{ input: logoOverlay, left: 856, top: 178 }])
    : baseImage;
  const buffer = await pipeline.png().toBuffer();
  const filePath = path.join(OUTPUT_DIR, `${prefix}-${Date.now()}.png`);
  fs.writeFileSync(filePath, buffer);
  return {
    buffer,
    filePath,
  };
}

module.exports = {
  renderCardImage,
};
