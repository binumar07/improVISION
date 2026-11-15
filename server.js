/**
 * Zero-Dependency HTTP & API Server for Field Shift Dashboard
 * NASA Space Apps Challenge 2026
 * Powered by: NASA POWER, Meteomatics / Open-Meteo, ECMWF Seasonal & FAO-56
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const engine = require('./src/agro_engine');

// Native .env parser (Zero external dependencies)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        process.env[key] = val;
      }
    }
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const METEO_USER = process.env.METEOMATICS_USER;
const METEO_PASS = process.env.METEOMATICS_PASSWORD;
const METEO_AUTH = (METEO_USER && METEO_PASS) 
  ? 'Basic ' + Buffer.from(`${METEO_USER}:${METEO_PASS}`).toString('base64') 
  : null;

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, error: e.message, raw: data });
        }
      });
    }).on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. API: Crops Metadata
  if (pathname === '/api/crops') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(engine.cropsData));
    return;
  }

  // 2. API: Ecological Zones Metadata
  if (pathname === '/api/zones') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(engine.zonesData));
    return;
  }

  // 3. API: Calculation Engine
  if (pathname === '/api/calculate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { cropId, zoneId, sowingDOY, sowingDate = null, customET0, previousCropId, forecastTemps, forecastDates = [], forecastRainfall = [], weatherProvider = null, tempAnomaly = 0, rainAnomalyPct = 0 } = payload;

        const zone = engine.zonesData.zones.find(z => z.id === zoneId) || engine.zonesData.zones[1];
        const crop = engine.cropsData.crops.find(c => c.id === cropId) || engine.cropsData.crops[2];

        const baseET0 = customET0 || 5.8;
        const et0 = Math.max(1.0, baseET0 + (tempAnomaly * 0.3));

        let activeTemps = forecastTemps;
        if (!activeTemps || !activeTemps.tempMax) {
          activeTemps = {
            tempMax: [32, 33, 34, 35.5, 36.5, 34, 33].map(t => t + tempAnomaly),
            tempMin: [22, 23, 23.5, 24, 24.5, 23, 22].map(t => t + tempAnomaly),
            tempMean: [27, 28, 28.75, 29.75, 30.5, 28.5, 27.5].map(t => t + tempAnomaly)
          };
        }

        const waterReq = engine.calculateCropWaterRequirements(crop, et0);
        const soilWater = engine.calculateSoilWaterLimits(zone.soil_profile, crop.root_depth_m, crop.p_depletion);
        const thermalAssessment = engine.evaluateThermalSuitability(crop, activeTemps);
        const forecastStart = forecastDates.length ? String(forecastDates[0]).slice(0, 10) : null;
        const forecastEnd = forecastDates.length ? String(forecastDates[forecastDates.length - 1]).slice(0, 10) : null;
        const plantingWithinForecast = Boolean(sowingDate && forecastStart && forecastEnd && String(sowingDate).slice(0, 10) >= forecastStart && String(sowingDate).slice(0, 10) <= forecastEnd);
        thermalAssessment.forecastApplicable = plantingWithinForecast;
        thermalAssessment.forecastApplicabilityNote = plantingWithinForecast
          ? 'The selected planting date falls within the available short-range forecast window.'
          : `The selected planting date (${sowingDate || 'not specified'}) is outside the available short-range forecast window (${forecastStart || 'unavailable'} to ${forecastEnd || 'unavailable'}); short-range heat alerts are not applied to this planting plan.`;
        const drySpellRisk = engine.assessDrySpellCollision(crop, sowingDOY, zone);
        const forecastDrySpell = engine.assessForecastDrySpell(crop, sowingDOY, forecastDates, forecastRainfall, sowingDate);
        const optimalSowing = engine.findOptimalSowingWindow(crop, zone);
        const rotationAnalysis = engine.generateRotationStrategies(previousCropId || cropId, zoneId, sowingDOY);

        const responseData = {
          zone,
          crop,
          et0: Number(et0.toFixed(2)),
          tempAnomaly,
          rainAnomalyPct,
          waterReq,
          soilWater,
          thermalAssessment,
          drySpellRisk,
          forecastDrySpell,
          optimalSowing,
          rotationAnalysis,
          provider: weatherProvider || (METEO_AUTH ? "Meteomatics (configured; forecast not supplied) + NASA POWER" : "Open-Meteo + NASA POWER"),
          weather: { provider: weatherProvider, dates: forecastDates, rainfall_mm: forecastRainfall, forecastDays: forecastTemps?.tempMax?.length || 0, sourceNote: weatherProvider ? "Live short-range forecast; not a seasonal forecast." : "No live forecast supplied; model fallback values used." }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 4. Live Meteomatics Weather & ET0 API (NASA Space Apps Global Offer)
  if (pathname === '/api/meteomatics') {
    if (!METEO_AUTH) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Meteomatics credentials not configured in .env" }));
      return;
    }

    const lat = parsedUrl.searchParams.get('lat') || '12.0022';
    const lon = parsedUrl.searchParams.get('lon') || '8.5920';

    const now = new Date();
    const startStr = now.toISOString().split('T')[0] + 'T00:00:00Z';
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const endStr = end.toISOString().split('T')[0] + 'T00:00:00Z';

    const timeRange = `${startStr}--${endStr}:P1D`;
    const params = 't_max_2m_24h:C,t_min_2m_24h:C,precip_24h:mm,evapotranspiration_24h:mm';
    const meteoUrl = `https://api.meteomatics.com/${timeRange}/${params}/${lat},${lon}/json`;

    try {
      const result = await fetchJson(meteoUrl, { 'Authorization': METEO_AUTH });
      res.writeHead(result.status >= 200 && result.status < 300 ? 200 : result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 5. Live NASA POWER Fetch Proxy
  if (pathname === '/api/nasa-power') {
    const lat = parsedUrl.searchParams.get('lat') || '12.0022';
    const lon = parsedUrl.searchParams.get('lon') || '8.5920';
    const start = parsedUrl.searchParams.get('start') || '20240701';
    const end = parsedUrl.searchParams.get('end') || '20240715';

    const nasaUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=ALLSKY_SFC_SW_DWN,T2M_MAX,T2M_MIN,T2M,RH2M,WS2M,PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${start}&end=${end}&format=JSON`;

    try {
      const result = await fetchJson(nasaUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 6. Live Open-Meteo Weather Forecast Fallback Proxy
  if (pathname === '/api/forecast') {
    const lat = parsedUrl.searchParams.get('lat') || '12.0022';
    const lon = parsedUrl.searchParams.get('lon') || '8.5920';
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration&timezone=Africa%2FLagos`;

    try {
      const result = await fetchJson(forecastUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 7. Open-Meteo ECMWF seasonal outlook: weekly near-term + monthly long-range guidance
  if (pathname === '/api/seasonal-outlook') {
    const lat = Number(parsedUrl.searchParams.get('lat') || 12.0022);
    const lon = Number(parsedUrl.searchParams.get('lon') || 8.5920);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid latitude and longitude are required.' })); return;
    }
    const q = new URLSearchParams({
      latitude: String(lat), longitude: String(lon),
      daily: 'precipitation_sum,temperature_2m_mean,et0_fao_evapotranspiration',
      weekly: 'precipitation_mean,precipitation_anomaly,temperature_2m_mean,temperature_2m_anomaly',
      monthly: 'precipitation_mean,precipitation_anomaly,temperature_2m_mean,temperature_2m_anomaly',
      forecast_days: '217', timezone: 'Africa/Lagos',
      models: 'ecmwf_seasonal_ensemble_mean_seamless'
    });
    try {
      const result = await fetchJson(`https://seasonal-api.open-meteo.com/v1/seasonal?${q}`);
      const ok = result.status >= 200 && result.status < 300 && result.data && (result.data.weekly || result.data.monthly);
      res.writeHead(ok ? 200 : (result.status >= 400 ? result.status : 502), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? {
        ...result.data,
        provider: 'Open-Meteo / ECMWF Seasonal Seamless Ensemble Mean',
        forecastType: 'probabilistic seasonal outlook',
        note: 'Weekly guidance is most useful in the sub-seasonal window; monthly anomalies support broad seasonal planning. These are area-scale ensemble guidance, not deterministic local rainfall or dry-spell dates.'
      } : {
        error: 'Seasonal forecast provider returned an error.',
        details: result.data || result.raw || 'No response body returned by provider.',
        providerStatus: result.status || null
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach seasonal forecast provider.', details: e.message }));
    }
    return;
  }

  // Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`================================================================`);
  console.log(`  🌾 FIELD SHIFT DECISION SUPPORT SYSTEM SERVER RUNNING!        `);
  console.log(`  🔗 Local Access:    http://localhost:${PORT}                  `);
  console.log(`  🌐 Network Access:  http://127.0.0.1:${PORT}                  `);
  console.log(`  ⚡ Weather Intelligence: ${METEO_AUTH ? "Meteomatics Global API (ACTIVE)" : "Open-Meteo"}`);
  console.log(`  🛰 Powered by: NASA POWER, Meteomatics / Open-Meteo & FAO-56    `);
  console.log(`================================================================`);
});
