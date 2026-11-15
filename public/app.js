/**
 * Field Shift Frontend Application Logic
 * NASA Space Apps Challenge 2026
 */

let map, marker, stageChartInstance;
let availableCrops = [];
let availableZones = [];
let currentFarmCoords = { lat: 12.0022, lon: 8.5920 };
let currentCropInfo = null;
let latestWeather = null;
let latestSeasonalMonthly = null;
let latestSeasonalLocation = null;
let latestRotationAnalysis = null;


// Accessible mobile navigation drawer
function initMobileNavigation() {
  const menuButton = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const closeButton = document.getElementById('sidebar-close');
  if (!menuButton || !sidebar || !overlay) return;

  const openMenu = () => {
    sidebar.classList.add('active');
    overlay.classList.add('active');
    sidebar.setAttribute('aria-hidden', 'false');
    menuButton.setAttribute('aria-expanded', 'true');
    menuButton.setAttribute('aria-label', 'Close navigation menu');
    document.body.classList.add('sidebar-open');
    closeButton?.focus();
  };
  const closeMenu = () => {
    sidebar.classList.remove('active');
    overlay.classList.remove('active');
    sidebar.setAttribute('aria-hidden', 'true');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open navigation menu');
    document.body.classList.remove('sidebar-open');
    menuButton.focus();
  };

  menuButton.addEventListener('click', () => {
    sidebar.classList.contains('active') ? closeMenu() : openMenu();
  });
  closeButton?.addEventListener('click', closeMenu);
  overlay.addEventListener('click', closeMenu);
  sidebar.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebar.classList.contains('active')) closeMenu();
  });
}

// Seasonal guidance is evaluated separately from the immediate 1–14 day forecast.
async function loadSeasonalOutlook() {
  const button = document.getElementById('load-seasonal-outlook');
  const panel = document.getElementById('seasonal-outlook-content');
  const stagePanel = document.getElementById('seasonal-stage-risk');
  if (!button || !panel) return;
  button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…';
  panel.textContent = 'Retrieving ECMWF seasonal guidance for the selected farm…';
  if (stagePanel) stagePanel.innerHTML = '';
  try {
    const {lat, lon} = currentFarmCoords;
    const response = await fetch(`/api/seasonal-outlook?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    const data = await response.json();
    if (!response.ok) {
      const detail = data.details ? ` (${typeof data.details === 'string' ? data.details : JSON.stringify(data.details)})` : '';
      throw new Error((data.error || 'Seasonal outlook unavailable') + detail);
    }
    latestSeasonalMonthly = data.monthly || null;
    latestSeasonalLocation = { lat: Number(lat), lon: Number(lon) };
    const weekly = data.weekly || {};
    const dates = weekly.time || [];
    const rain = weekly.precipitation_mean || [];
    const rainAnom = weekly.precipitation_anomaly || [];
    const temp = weekly.temperature_2m_mean || [];
    const tempAnom = weekly.temperature_2m_anomaly || [];
    const cards = dates.slice(0, 6).map((date, i) => {
      const r = Number(rain[i]), ra = Number(rainAnom[i]), t = Number(temp[i]), ta = Number(tempAnom[i]);
      const tendency = Number.isFinite(ra) ? (ra < -5 ? 'Drier than average' : ra > 5 ? 'Wetter than average' : 'Near average') : 'Anomaly unavailable';
      return `<div class="seasonal-metric"><span>Week of ${date}</span><strong>${Number.isFinite(r) ? r.toFixed(1)+' mm' : '—'}</strong><span>Mean weekly rainfall • ${tendency}</span><span>${Number.isFinite(t) ? t.toFixed(1)+'°C' : '—'}${Number.isFinite(ta) ? ` (${ta > 0 ? '+' : ''}${ta.toFixed(1)}°C anomaly)` : ''}</span></div>`;
    }).join('');
    panel.innerHTML = `<div class="text-xs text-cyan-200 mt-2">${data.provider || 'Open-Meteo / ECMWF'} · ${data.forecastType || 'Seasonal outlook'}</div><div class="seasonal-grid">${cards || '<p>Weekly values are not available for this period; see monthly outlook below.</p>'}</div><p class="text-xs text-slate-400 mt-3">${data.note || ''}</p>`;
    renderSeasonalCropStageRisk(data.monthly || {}, data.provider || 'ECMWF seasonal ensemble');
    if (latestRotationAnalysis) renderRotationStrategies(latestRotationAnalysis);
    const overviewData = document.getElementById('farmer-overview-results');
    if (overviewData) { const peak = document.querySelector('#seasonal-stage-risk .seasonal-metric:nth-child(3) strong'); const card = overviewData.children[2]; if (card) { card.querySelector('strong').textContent = peak?.textContent || 'Seasonal outlook loaded'; card.querySelector('small').textContent = 'Seasonal guidance is compared with crop growth stages, especially peak water demand.'; } }
  } catch (error) {
    panel.textContent = `Seasonal outlook could not be loaded: ${error.message}. Immediate short-range weather analysis remains available.`;
    if (stagePanel) stagePanel.innerHTML = '<p class="text-xs text-amber-300">Long-range crop-stage risk is unavailable until seasonal provider data is received. No seasonal risk level has been inferred.</p>';
  } finally {
    button.disabled = false; button.innerHTML = '<i class="fa-solid fa-rotate"></i> Refresh outlook';
  }
}

function renderSeasonalCropStageRisk(monthly, provider) {
  const target = document.getElementById('seasonal-stage-risk');
  if (!target) return;
  const times = monthly.time || [];
  const pMean = monthly.precipitation_mean || [];
  const pAnom = monthly.precipitation_anomaly || [];
  const tAnom = monthly.temperature_2m_anomaly || [];
  if (!times.length || !currentCropInfo) {
    target.innerHTML = '<p class="text-xs text-amber-300">Monthly outlook or crop-stage metadata is unavailable; seasonal crop-stage risk cannot be assessed yet.</p>';
    return;
  }
  const sowStr = document.getElementById('input-date')?.value;
  const sow = sowStr ? new Date(`${sowStr}T00:00:00`) : new Date();
  if (Number.isNaN(sow.getTime())) return;
  const stages = currentCropInfo.stages || {};
  const stageDefs = [
    {name:'Establishment', days:Number(stages.ini_days || 0), kc:Number(currentCropInfo.kc?.ini || 0.3)},
    {name:'Vegetative development', days:Number(stages.dev_days || 0), kc:(Number(currentCropInfo.kc?.ini || 0.3)+Number(currentCropInfo.kc?.mid || 1))/2},
    {name:'Peak water demand / reproductive stage', days:Number(stages.mid_days || 0), kc:Number(currentCropInfo.kc?.mid || 1)},
    {name:'Maturation', days:Number(stages.late_days || 0), kc:(Number(currentCropInfo.kc?.mid || 1)+Number(currentCropInfo.kc?.late || 0.3))/2}
  ];
  let cursor = new Date(sow);
  const stageWindows = stageDefs.map(stage => {
    const start = new Date(cursor), end = new Date(cursor);
    end.setDate(end.getDate() + Math.max(0, stage.days) - 1);
    cursor.setDate(cursor.getDate() + Math.max(0, stage.days));
    return {...stage, start, end};
  });
  const monthRows = times.map((key, i) => {
    const [yy, mm] = String(key).slice(0,7).split('-').map(Number);
    if (!yy || !mm) return null;
    const start = new Date(yy, mm-1, 1), end = new Date(yy, mm, 0);
    const mean = Number(pMean[i]), anomaly = Number(pAnom[i]), tempA = Number(tAnom[i]);
    const pct = Number.isFinite(mean) && mean > 0 && Number.isFinite(anomaly) ? anomaly / mean * 100 : NaN;
    return {key:String(key).slice(0,7),start,end,mean,anomaly,tempA,pct};
  }).filter(Boolean);
  const stageScores = stageWindows.map(stage => {
    let weighted = 0, weightDays = 0, coveredDays = 0, warmDays = 0;
    for (const m of monthRows) {
      const lo = Math.max(stage.start.getTime(),m.start.getTime());
      const hi = Math.min(stage.end.getTime(),m.end.getTime());
      const days = Math.max(0,Math.floor((hi-lo)/86400000)+1);
      if (!days) continue;
      coveredDays += days;
      const deficit = Number.isFinite(m.pct) ? Math.max(0, -m.pct) : 0;
      weighted += deficit * days * Math.max(.3,stage.kc);
      weightDays += days;
      if (Number.isFinite(m.tempA) && m.tempA >= 1) warmDays += days;
    }
    const deficitPct = weightDays ? weighted / weightDays : NaN;
    let level = 'INSUFFICIENT OUTLOOK COVERAGE';
    if (coveredDays > 0) level = deficitPct >= 40 || (deficitPct >= 25 && warmDays >= 7) ? 'HIGHER CONCERN' : deficitPct >= 15 ? 'ELEVATED CONCERN' : 'LOWER SIGNAL';
    return {...stage,coveredDays,deficitPct,level,warmDays};
  });
  const peak = stageScores.find(s=>s.name.startsWith('Peak'));
  const rows = stageScores.map(s => `<div class="seasonal-metric"><span>${s.name} · ${s.start.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}–${s.end.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</span><strong>${s.level}</strong><span>Crop coefficient Kc ${s.kc.toFixed(2)} · ${s.coveredDays} day(s) within monthly outlook</span><span>${Number.isFinite(s.deficitPct) ? `${s.deficitPct.toFixed(0)}% Kc-weighted rainfall-deficit signal` : 'Insufficient anomaly data'}${s.warmDays ? ` · ${s.warmDays} warmer-anomaly day(s)` : ''}</span></div>`).join('');
  target.innerHTML = `<div class="border-t border-cyan-900/70 pt-4 mt-4"><h3 class="text-sm font-extrabold text-white">Long-term crop-stage water risk</h3><p class="text-xs text-slate-400 mt-1">Monthly rainfall anomalies are aligned with the selected crop calendar and Kc. Peak consumptive-use stage receives greater agronomic attention; this is a seasonal screening signal, not a forecast of exact dry-spell dates.</p><div class="seasonal-grid">${rows}</div><p class="text-xs text-cyan-200 mt-3">Peak-demand stage: ${peak ? peak.level : 'Not assessed'} · Crop: ${currentCropInfo.name || 'Selected crop'} · ${provider}</p></div>`;
}

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', async () => {
  initMobileNavigation();
  document.getElementById('load-seasonal-outlook')?.addEventListener('click', loadSeasonalOutlook);
  initMap();
  await loadMetadata();
  bindEvents();
  runAnalysis();
});

// 1. Initialize Leaflet Map with Multiple Layers (Satellite, Streets, Terrain)
function initMap() {
  // Tile Layers
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 19
  });

  const streetLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 18
  });

  const terrainLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, METI, Esri China',
    maxZoom: 18
  });

  map = L.map('map', {
    center: [12.0022, 8.5920], // Default Kano
    zoom: 7,
    layers: [satelliteLayer] // Default to satellite
  });

  const baseMaps = {
    "🛰️ Satellite Imagery": satelliteLayer,
    "🗺️ Default Streets": streetLayer,
    "🏔️ Terrain / Topo": terrainLayer
  };

  L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

  marker = L.marker([12.0022, 8.5920], { draggable: true }).addTo(map);
  marker.bindPopup("<b>Farm Pin</b><br>Kano State (Sudan Savanna)").openPopup();

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    marker.setLatLng([lat, lng]);
    updateCoordsDisplay(lat, lng);
    matchNearestZone(lat, lng);
    fetchLiveWeather(lat, lng);
    runAnalysis();
  });

  marker.on('dragend', () => {
    const pos = marker.getLatLng();
    updateCoordsDisplay(pos.lat, pos.lng);
    matchNearestZone(pos.lat, pos.lng);
    fetchLiveWeather(pos.lat, pos.lng);
    runAnalysis();
  });

  setupGpsLocator();
}

// GPS Geolocation Handler
function setupGpsLocator() {
  const gpsBtn = document.getElementById('btn-gps');
  if (!gpsBtn) return;

  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    gpsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-cyan-400"></i> <span>Acquiring GPS...</span>';
    gpsBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        marker.setLatLng([latitude, longitude]);
        map.setView([latitude, longitude], 12); // Zoom in close to actual farm
        marker.bindPopup(`<b>Your Current Farm Location</b><br>${latitude.toFixed(4)}°N, ${longitude.toFixed(4)}°E`).openPopup();
        updateCoordsDisplay(latitude, longitude);
        matchNearestZone(latitude, longitude);
        fetchLiveWeather(latitude, longitude);
        runAnalysis();

        gpsBtn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i> <span>GPS Located!</span>';
        setTimeout(() => {
          gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs text-cyan-400"></i> <span>Locate Me (GPS)</span>';
          gpsBtn.disabled = false;
        }, 3000);
      },
      (error) => {
        console.error("GPS Error:", error);
        alert(`GPS error: ${error.message}. Please enable location permissions in your browser.`);
        gpsBtn.innerHTML = '<i class="fa-solid fa-location-crosshairs text-cyan-400"></i> <span>Locate Me (GPS)</span>';
        gpsBtn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

function updateCoordsDisplay(lat, lng) {
  currentFarmCoords = { lat, lon: lng };
  if (latestSeasonalLocation && (Math.abs(lat - latestSeasonalLocation.lat) > 0.01 || Math.abs(lng - latestSeasonalLocation.lon) > 0.01)) {
    latestSeasonalMonthly = null; latestSeasonalLocation = null;
  }
  document.getElementById('disp-coords').innerText = `${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E`;
}

// 2. Load Crops & Zones
async function loadMetadata() {
  try {
    const [cropsRes, zonesRes] = await Promise.all([
      fetch('/api/crops').then(r => r.json()),
      fetch('/api/zones').then(r => r.json())
    ]);

    availableCrops = cropsRes.crops;
    availableZones = zonesRes.zones;

    populateDropdowns();
    renderSavedFarmsDropdown();

    // Probe live Meteomatics weather intelligence
    fetchLiveWeather();
  } catch (err) {
    console.error("Failed to load metadata:", err);
  }
}

async function fetchLiveWeather(lat = currentFarmCoords.lat, lon = currentFarmCoords.lon) {
  // Meteomatics is the primary source. Open-Meteo is used only as a fallback.
  const toNumbers = (items) => (Array.isArray(items) ? items.map(x => Number(x?.value ?? x)).filter(Number.isFinite) : []);
  const normalizeMeteomatics = (payload) => {
    // /api/meteomatics returns { status: HTTP status, data: Meteomatics payload }.
    const meteo = payload?.data;
    const rows = Array.isArray(meteo?.data) ? meteo.data : (Array.isArray(payload?.data?.data?.data) ? payload.data.data.data : null);
    if (!rows || (meteo?.status && meteo.status !== 'OK' && Number(meteo.status) !== 200)) throw new Error('Meteomatics returned an unexpected response structure');
    const series = (name) => rows.find(x => x.parameter === name)?.coordinates?.[0]?.dates || [];
    const maxRows = series('t_max_2m_24h:C');
    const minRows = series('t_min_2m_24h:C');
    if (!maxRows.length || !minRows.length) throw new Error('Meteomatics temperature series missing');
    // Keep dates and values aligned; do not silently shift dates when a value is missing.
    const minByDate = new Map(minRows.map(x => [x.date, Number(x.value)]));
    const valid = maxRows.map(x => ({ date: x.date, max: Number(x.value), min: minByDate.get(x.date) }))
      .filter(x => Number.isFinite(x.max) && Number.isFinite(x.min));
    if (!valid.length) throw new Error('Meteomatics returned no valid paired temperature values');
    const rainByDate = new Map(series('precip_24h:mm').map(x => [x.date, Number(x.value)]));
    const etByDate = new Map(series('evapotranspiration_24h:mm').map(x => [x.date, Number(x.value)]));
    const precipitation = valid.map(x => Number.isFinite(rainByDate.get(x.date)) ? rainByDate.get(x.date) : 0);
    const et0 = valid.map(x => etByDate.get(x.date)).filter(Number.isFinite);
    return {
      provider: 'Meteomatics', dates: valid.map(x => x.date),
      tempMax: valid.map(x => x.max), tempMin: valid.map(x => x.min),
      tempMean: valid.map(x => (x.max + x.min) / 2), precipitation,
      et0, et0Mean: et0.length ? et0.reduce((a,b) => a+b, 0) / et0.length : null
    };
  };

  let primaryError = null;
  try {
    const res = await fetch(`/api/meteomatics?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    const payload = await res.json();
    if (!res.ok || payload.status < 200 || payload.status >= 300) throw new Error(payload.data?.message || payload.error || `Meteomatics HTTP ${res.status}`);
    latestWeather = normalizeMeteomatics(payload);
  } catch (err) {
    primaryError = err;
    console.warn('Meteomatics unavailable; using Open-Meteo fallback:', err.message);
    try {
      const res = await fetch(`/api/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
      const payload = await res.json();
      if (!res.ok || !payload.data?.daily) throw new Error(payload.error || `Open-Meteo HTTP ${res.status}`);
      const d = payload.data.daily;
      latestWeather = {
        provider: 'Open-Meteo fallback', dates: d.time || [],
        tempMax: d.temperature_2m_max || [], tempMin: d.temperature_2m_min || [],
        tempMean: d.temperature_2m_mean || [], precipitation: d.precipitation_sum || [],
        et0: d.et0_fao_evapotranspiration || [],
        et0Mean: (d.et0_fao_evapotranspiration || []).filter(Number.isFinite).length
          ? d.et0_fao_evapotranspiration.filter(Number.isFinite).reduce((a,b) => a+b, 0) / d.et0_fao_evapotranspiration.filter(Number.isFinite).length : null
      };
    } catch (fallbackError) {
      latestWeather = null;
      console.error('Both weather providers failed:', { meteomatics: primaryError?.message, fallback: fallbackError.message });
    }
  }

  const label = document.getElementById('label-et0');
  const slider = document.getElementById('slider-et0');
  if (latestWeather?.et0Mean > 0) {
    if (slider) slider.value = latestWeather.et0Mean.toFixed(1);
    if (label) label.innerText = `${latestWeather.et0Mean.toFixed(1)} mm/day (${latestWeather.provider} forecast mean)`;
  }
  return latestWeather;
}

function populateDropdowns() {
  const zoneSelect = document.getElementById('select-zone');
  const cropSelect = document.getElementById('select-crop');
  const prevCropSelect = document.getElementById('select-prev-crop');

  zoneSelect.innerHTML = availableZones.map(z => 
    `<option value="${z.id}" ${z.id === 'sudan_savanna' ? 'selected' : ''}>${z.name} (${z.states.slice(0, 3).join(', ')})</option>`
  ).join('');

  cropSelect.innerHTML = availableCrops.map(c => 
    `<option value="${c.id}" ${c.id === 'maize_early' ? 'selected' : ''}>${c.name} [${c.category} • ${c.duration_days}d • Heat Limit: ${c.thermal.t_crit_max}°C]</option>`
  ).join('');

  prevCropSelect.innerHTML = availableCrops.map(c => 
    `<option value="${c.id}" ${c.id === 'maize_early' ? 'selected' : ''}>${c.name} [${c.category}]</option>`
  ).join('');
}

function matchNearestZone(lat, lon) {
  let nearest = availableZones[0];
  let minDistance = 9999;

  for (const zone of availableZones) {
    const dLat = lat - zone.representative_coords.lat;
    const dLon = lon - zone.representative_coords.lon;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = zone;
    }
  }

  const zoneSelect = document.getElementById('select-zone');
  if (zoneSelect && nearest) {
    zoneSelect.value = nearest.id;
  }
}

// 3. Bind UI Events
function bindEvents() {
  document.getElementById('select-zone').addEventListener('change', (e) => {
    const zone = availableZones.find(z => z.id === e.target.value);
    if (zone && marker && map) {
      marker.setLatLng([zone.representative_coords.lat, zone.representative_coords.lon]);
      map.setView([zone.representative_coords.lat, zone.representative_coords.lon], 7);
      updateCoordsDisplay(zone.representative_coords.lat, zone.representative_coords.lon);
    }
    runAnalysis();
  });

  document.getElementById('select-crop').addEventListener('change', runAnalysis);
  document.getElementById('select-prev-crop').addEventListener('change', runAnalysis);

  document.getElementById('input-date').addEventListener('change', (e) => {
    const doy = dateToDayOfYear(e.target.value);
    document.getElementById('disp-doy').innerText = `DOY ${doy}`;
    runAnalysis();
  });

  document.getElementById('slider-temp-scenario').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById('label-temp-scenario').innerText = `${val >= 0 ? '+' : ''}${val.toFixed(1)}°C`;
    runAnalysis();
  });

  document.getElementById('btn-run').addEventListener('click', runAnalysis);

  // Save Farm Profile
  document.getElementById('btn-save-farm').addEventListener('click', saveCurrentFarm);

  // Clear Saved Farms
  document.getElementById('btn-clear-farms').addEventListener('click', clearAllSavedFarms);

  // Load Saved Farm
  document.getElementById('select-saved-farm').addEventListener('change', loadSelectedFarm);

  // Print / PDF Export
  document.getElementById('btn-export-pdf').addEventListener('click', () => {
    window.print();
  });
}

function saveCurrentFarm() {
  const defaultName = `Farm Plot - ${document.getElementById('disp-coords').innerText}`;
  const name = prompt("Enter a name for this farm plot (e.g., North Field - Maize):", defaultName);
  if (!name) return;

  const latLng = marker.getLatLng();
  const farm = {
    id: 'farm_' + Date.now(),
    name: name.trim(),
    lat: latLng.lat,
    lon: latLng.lng,
    zoneId: document.getElementById('select-zone').value,
    cropId: document.getElementById('select-crop').value,
    prevCropId: document.getElementById('select-prev-crop').value,
    sowingDate: document.getElementById('input-date').value
  };

  const saved = JSON.parse(localStorage.getItem('fieldshift_saved_farms') || '[]');
  saved.push(farm);
  localStorage.setItem('fieldshift_saved_farms', JSON.stringify(saved));
  renderSavedFarmsDropdown();
  alert(`Farm plot "${farm.name}" saved successfully!`);
}

function renderSavedFarmsDropdown() {
  const saved = JSON.parse(localStorage.getItem('fieldshift_saved_farms') || '[]');
  const wrapper = document.getElementById('saved-farms-wrapper');
  const select = document.getElementById('select-saved-farm');

  if (saved.length === 0) {
    wrapper.classList.add('hidden');
    return;
  }

  wrapper.classList.remove('hidden');
  select.innerHTML = '<option value="">-- Load a saved plot (' + saved.length + ' saved) --</option>' +
    saved.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
}

function loadSelectedFarm(e) {
  const id = e.target.value;
  if (!id) return;

  const saved = JSON.parse(localStorage.getItem('fieldshift_saved_farms') || '[]');
  const farm = saved.find(f => f.id === id);
  if (!farm) return;

  marker.setLatLng([farm.lat, farm.lon]);
  map.setView([farm.lat, farm.lon], 11);
  updateCoordsDisplay(farm.lat, farm.lon);

  if (farm.zoneId) document.getElementById('select-zone').value = farm.zoneId;
  if (farm.cropId) document.getElementById('select-crop').value = farm.cropId;
  if (farm.prevCropId) document.getElementById('select-prev-crop').value = farm.prevCropId;
  if (farm.sowingDate) {
    document.getElementById('input-date').value = farm.sowingDate;
    document.getElementById('disp-doy').innerText = `DOY ${dateToDayOfYear(farm.sowingDate)}`;
  }

  fetchLiveWeather(farm.lat, farm.lon);
  runAnalysis();
}

function clearAllSavedFarms() {
  if (confirm("Are you sure you want to clear all saved farm plots?")) {
    localStorage.removeItem('fieldshift_saved_farms');
    renderSavedFarmsDropdown();
  }
}

function dateToDayOfYear(dateStr) {
  const d = new Date(dateStr);
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

function dayOfYearToDateStr(doy, year = 2026) {
  const date = new Date(year, 0, doy);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// 4. Run Analysis & Render Visuals
async function runAnalysis() {
  const weather = await fetchLiveWeather(currentFarmCoords.lat, currentFarmCoords.lon);
  const zoneId = document.getElementById('select-zone').value || 'sudan_savanna';
  const cropId = document.getElementById('select-crop').value || 'maize_early';
  const prevCropId = document.getElementById('select-prev-crop').value || 'maize_early';
  const sowingDateStr = document.getElementById('input-date').value || '2027-06-20';
  const sowingDOY = dateToDayOfYear(sowingDateStr);
  const tempAnomaly = parseFloat(document.getElementById('slider-temp-scenario').value) || 0;

  try {
    const response = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cropId,
        zoneId,
        sowingDOY,
        sowingDate: sowingDateStr,
        tempAnomaly,
        previousCropId: prevCropId,
        forecastTemps: weather ? { tempMax: weather.tempMax, tempMin: weather.tempMin, tempMean: weather.tempMean } : null,
        customET0: weather?.et0Mean || null,
        forecastDates: weather?.dates || [],
        forecastRainfall: weather?.precipitation || [],
        weatherProvider: weather?.provider || null
      })
    });

    const data = await response.json();
    renderDashboard(data);
  } catch (err) {
    console.error("Calculation request failed:", err);
  }
}

// 5. Render Dashboard Elements
function renderDashboard(data) {
  currentCropInfo = data.crop || null;
  latestRotationAnalysis = data.rotationAnalysis || null;
  const { zone, crop, et0, waterReq, soilWater, thermalAssessment, drySpellRisk, forecastDrySpell, optimalSowing, rotationAnalysis } = data;
  const weatherLabel = document.getElementById("weather-provenance");
  if (weatherLabel) weatherLabel.textContent = data.weather?.provider ? `Weather source: ${data.weather.provider} • ${data.weather.dates?.[0] || ""} to ${data.weather.dates?.[data.weather.dates.length-1] || ""}` : "Weather source: forecast unavailable • climatology fallback";

  // Overview top bar
  document.getElementById('disp-zone').innerText = zone.name;
  document.getElementById('disp-soil').innerText = zone.soil_profile.texture_class;
  document.getElementById('disp-dryspell').innerText = `${dayOfYearToDateStr(zone.dry_spell_risk.critical_window_doy[0])} – ${dayOfYearToDateStr(zone.dry_spell_risk.critical_window_doy[1])} (seasonal baseline)`;

  // Card 1: Water Demand
  document.getElementById('val-total-water').innerText = `${waterReq.totalSeasonalRequirement_mm} mm`;
  document.getElementById('val-peak-water').innerText = `${waterReq.dailyPeakRequirement_mm} mm/day`;
  document.getElementById('val-duration').innerText = `${waterReq.totalDays} Days`;

  // Card 2: Thermal Profile
  document.getElementById('val-crit-temp').innerText = `${thermalAssessment.t_crit_max}°C`;
  document.getElementById('val-opt-temp').innerText = `${thermalAssessment.t_opt_range[0]}°C – ${thermalAssessment.t_opt_range[1]}°C`;
  document.getElementById('val-base-temp').innerText = `${thermalAssessment.t_base}°C`;

  // Card 3: Soil Reservoir
  document.getElementById('val-raw').innerText = `${soilWater.raw_mm} mm`;
  document.getElementById('val-taw').innerText = `${soilWater.taw_mm} mm`;
  document.getElementById('val-root-depth').innerText = `${soilWater.rootDepth_m} m`;

  // Card 4: Sowing Window
  const optStart = dayOfYearToDateStr(optimalSowing.recommendedSowingDOYRange[0]);
  const optEnd = dayOfYearToDateStr(optimalSowing.recommendedSowingDOYRange[1]);
  document.getElementById('val-opt-window').innerText = `${optStart} – ${optEnd}`;
  document.getElementById('val-onset').innerText = zone.nimet_onset_window;
  document.getElementById('val-opt-overlap').innerText = `${optimalSowing.minOverlapDays} Days (Optimal)`;

  // Plain-language summary for farmers; detailed analysis remains below.
  renderFarmerOverview({ zone, crop, optimalSowing, forecastDrySpell, drySpellRisk, sowingDate: document.getElementById('input-date')?.value, weather: data.weather });

  // Alert 1: Dry Spell Collision
  renderDrySpellBanner(forecastDrySpell, drySpellRisk, zone, crop);

  // Alert 2: Thermal & Heat Stress
  renderThermalBanner(thermalAssessment);

  // Stage Water & Kc Chart
  renderStageChart(waterReq, drySpellRisk);

  // Multi-Strategy Rotation Comparison
  renderRotationStrategies(rotationAnalysis);
}

function renderFarmerOverview({ zone, crop, optimalSowing, forecastDrySpell, drySpellRisk, sowingDate, weather }) {
  const target = document.getElementById('farmer-overview-results');
  if (!target) return;
  const range = optimalSowing?.recommendedSowingDOYRange || [];
  const start = range.length === 2 ? dayOfYearToDateStr(range[0]) : 'Not available';
  const end = range.length === 2 ? dayOfYearToDateStr(range[1]) : '';
  const selectedDoy = sowingDate ? dateToDayOfYear(sowingDate) : NaN;
  const inWindow = Number.isFinite(selectedDoy) && range.length === 2 && selectedDoy >= range[0] && selectedDoy <= range[1];
  const plantingTitle = range.length === 2 ? `${start} – ${end}` : 'Window unavailable';
  const plantingNote = !Number.isFinite(selectedDoy) ? 'Choose a planting date to compare.' : inWindow ? 'Your selected date is within the suggested window.' : 'Your selected date is outside the suggested window. Consider adjusting it or seek local advice.';

  const immediate = forecastDrySpell || {};
  const outside = immediate.applicable === false || immediate.riskLevel === 'OUTSIDE FORECAST WINDOW';
  const hasForecast = Boolean(weather?.dates?.length);
  let immediateTitle = 'Forecast unavailable';
  let immediateNote = 'No short-range weather data was received.';
  if (outside) {
    immediateTitle = 'Not applicable to this date';
    immediateNote = 'Your planting date is outside the available short-range forecast. No immediate warning is applied.';
  } else if (hasForecast) {
    immediateTitle = immediate.riskLevel || 'Forecast checked';
    immediateNote = immediate.advisory || 'Short-range forecast received for the selected farm.';
  }

  let seasonalTitle = 'Not checked yet';
  let seasonalNote = 'Load the seasonal outlook to assess longer-term rainfall and heat signals.';
  if (latestSeasonalMonthly) {
    const peak = document.querySelector('#seasonal-stage-risk .seasonal-metric:nth-child(3) strong');
    seasonalTitle = peak?.textContent || 'Seasonal outlook loaded';
    seasonalNote = 'Seasonal guidance is compared with crop growth stages, especially peak water demand.';
  } else if (drySpellRisk) {
    seasonalNote = 'Historical seasonal dry-spell timing is shown in the detailed risk section; it is not a live forecast.';
  }

  target.innerHTML = `
    <div class="farmer-summary-card"><span>Suggested planting period</span><strong>${plantingTitle}</strong><small>${plantingNote}</small></div>
    <div class="farmer-summary-card"><span>Weather for planting</span><strong>${immediateTitle}</strong><small>${immediateNote}</small></div>
    <div class="farmer-summary-card"><span>Season outlook</span><strong>${seasonalTitle}</strong><small>${seasonalNote}</small></div>`;
}

function renderDrySpellBanner(forecastRisk, seasonalRisk, zone, crop) {
  const container = document.getElementById('alert-container');
  const risk = forecastRisk || { riskLevel: 'FORECAST UNAVAILABLE', advisory: 'No short-range rainfall forecast is available.', consecutiveDryDays: 0, assessmentAvailable: false };
  const isOutsideWindow = risk.riskLevel === 'OUTSIDE FORECAST WINDOW' || risk.applicable === false;
  const isCritical = !isOutsideWindow && risk.riskLevel.includes('HIGH');
  const isModerate = !isOutsideWindow && risk.riskLevel.includes('MODERATE');
  const isUnavailable = !isOutsideWindow && !risk.assessmentAvailable;
  let bgClass, borderClass, textClass, iconClass;
  if (isCritical) { bgClass='bg-red-950/80'; borderClass='border-red-700/80'; textClass='text-red-300'; iconClass='fa-triangle-exclamation text-red-400'; }
  else if (isModerate) { bgClass='bg-amber-950/80'; borderClass='border-amber-700/80'; textClass='text-amber-300'; iconClass='fa-circle-exclamation text-amber-400'; }
  else if (isOutsideWindow) { bgClass='bg-slate-900/80'; borderClass='border-slate-700/80'; textClass='text-slate-300'; iconClass='fa-calendar-xmark text-slate-400'; }
  else { bgClass='bg-emerald-950/80'; borderClass='border-emerald-700/80'; textClass='text-emerald-300'; iconClass='fa-cloud-sun text-emerald-400'; }
  const period = risk.drySpellStart && risk.drySpellEnd ? `${risk.drySpellStart} – ${risk.drySpellEnd}` : (risk.forecastHorizonStart && risk.forecastHorizonEnd ? `${risk.forecastHorizonStart} – ${risk.forecastHorizonEnd}` : 'Unavailable');
  const badge = isOutsideWindow ? 'Outside forecast window' : (isUnavailable ? 'No forecast' : `${risk.consecutiveDryDays || 0} consecutive dry days`);
  const baselineText = seasonalRisk
    ? `Seasonal climatology: ${dayOfYearToDateStr(seasonalRisk.drySpellWindowDOY[0])} – ${dayOfYearToDateStr(seasonalRisk.drySpellWindowDOY[1])}; estimated reproductive-stage overlap ${seasonalRisk.overlapDays} day(s).`
    : 'Seasonal climatology is not available.';
  container.className = `rounded-2xl p-5 border shadow-xl ${bgClass} ${borderClass}`;
  container.innerHTML = `
    <div class="flex items-start gap-4"><div class="text-3xl mt-0.5"><i class="fa-solid ${iconClass}"></i></div>
      <div class="space-y-1"><div class="flex items-center gap-2 flex-wrap">
        <h3 class="text-sm font-bold text-white uppercase tracking-wider">${isOutsideWindow ? 'Immediate Dry-Spell Forecast: Not Applicable' : `Immediate Dry-Spell Risk (short-range forecast): ${risk.riskLevel}`}</h3>
        <span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 font-mono text-slate-300">${badge}</span>
      </div>
      <p class="${textClass} text-xs leading-relaxed">${risk.advisory}</p>
      <div class="text-[11px] text-slate-400 pt-1">Forecast period: <span class="font-bold text-cyan-300 font-mono">${period}</span> · Detection rule: &lt;1 mm/day for at least 3 consecutive days.${risk.plantingDate ? ` Selected planting date: ${risk.plantingDate}.` : ''}</div>
      <div class="text-[11px] text-slate-400 pt-1">${baselineText} <span class="text-slate-500">Historical seasonal screening only; not a forecast.</span></div>
      </div></div>`;
}

function renderThermalBanner(thermal) {
  const container = document.getElementById('thermal-alert-container');
  const outsideForecast = thermal.forecastApplicable === false;
  const isCritical = !outsideForecast && thermal.heatStatus.includes('CRITICAL');
  const isModerate = !outsideForecast && thermal.heatStatus.includes('MODERATE');

  let bgClass, borderClass, textClass, iconClass;
  if (outsideForecast) {
    bgClass = 'bg-slate-900/80';
    borderClass = 'border-slate-700/80';
    textClass = 'text-slate-300';
    iconClass = 'fa-calendar-xmark text-slate-400';
  } else if (isCritical) {
    bgClass = 'bg-red-950/80';
    borderClass = 'border-red-700/80';
    textClass = 'text-red-300';
    iconClass = 'fa-fire-flame-curved text-red-400';
  } else if (isModerate) {
    bgClass = 'bg-amber-950/80';
    borderClass = 'border-amber-700/80';
    textClass = 'text-amber-300';
    iconClass = 'fa-sun text-amber-400';
  } else {
    bgClass = 'bg-emerald-950/80';
    borderClass = 'border-emerald-700/80';
    textClass = 'text-emerald-300';
    iconClass = 'fa-shield-heart text-emerald-400';
  }

  container.className = `rounded-2xl p-5 border shadow-xl ${bgClass} ${borderClass}`;
  container.innerHTML = `
    <div class="flex items-start gap-4">
      <div class="text-3xl mt-0.5"><i class="fa-solid ${iconClass}"></i></div>
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-bold text-white uppercase tracking-wider">Thermal & Heat Stress: ${thermal.heatStatus}</h3>
          <span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 font-mono text-slate-300">${thermal.heatStressDays} Days &gt; ${thermal.t_crit_max}°C</span>
        </div>
        <p class="${textClass} text-xs leading-relaxed">${thermal.heatAdvisory}</p>
        <div class="text-[11px] text-slate-400 pt-1">
          GDD Accumulated: <span class="font-bold text-amber-300 font-mono">${thermal.accumulatedGDD} °C·days</span> (Target: ${thermal.gddRequired})
        </div>
      </div>
    </div>
  `;
}

function renderStageChart(waterReq, drySpellRisk) {
  const ctx = document.getElementById('stageChart').getContext('2d');

  if (stageChartInstance) {
    stageChartInstance.destroy();
  }

  const stageLabels = waterReq.stages.map(s => `${s.name} (${s.days}d)`);
  const stageWater = waterReq.stages.map(s => s.water_mm);
  const stageKc = waterReq.stages.map(s => s.avgKc);

  stageChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stageLabels,
      datasets: [
        {
          label: 'Stage Water Demand (mm)',
          data: stageWater,
          backgroundColor: ['rgba(6, 182, 212, 0.7)', 'rgba(14, 165, 233, 0.7)', 'rgba(239, 68, 68, 0.8)', 'rgba(16, 185, 129, 0.7)'],
          borderColor: ['#06b6d4', '#0ea5e9', '#ef4444', '#10b981'],
          borderWidth: 1.5,
          yAxisID: 'y',
          borderRadius: 8
        },
        {
          label: 'Crop Coefficient (Kc)',
          data: stageKc,
          type: 'line',
          borderColor: '#f59e0b',
          backgroundColor: '#f59e0b',
          borderWidth: 3,
          pointRadius: 5,
          pointHoverRadius: 7,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          borderColor: '#334155',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(51, 65, 85, 0.4)' },
          ticks: { color: '#94a3b8', font: { size: 11 } }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'Stage Water Demand (mm)', color: '#06b6d4' },
          grid: { color: 'rgba(51, 65, 85, 0.4)' },
          ticks: { color: '#94a3b8' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: 'Kc Value', color: '#f59e0b' },
          grid: { drawOnChartArea: false },
          min: 0,
          max: 1.4,
          ticks: { color: '#f59e0b' }
        }
      }
    }
  });
}

// Apply seasonal climate guidance to each rotation candidate using its own crop calendar.
// This is a bounded screening adjustment, not a yield-loss or drought-probability model.
function applySeasonalRotationAdjustment(analysis) {
  if (!analysis || !Array.isArray(analysis.matrix)) return analysis;
  const adjusted = JSON.parse(JSON.stringify(analysis));
  const sowStr = document.getElementById('input-date')?.value;
  const sowDate = sowStr ? new Date(`${sowStr}T00:00:00`) : new Date();
  const locationMatches = latestSeasonalLocation && Math.abs(currentFarmCoords.lat - latestSeasonalLocation.lat) <= 0.01 && Math.abs(currentFarmCoords.lon - latestSeasonalLocation.lon) <= 0.01;
  const monthly = locationMatches ? latestSeasonalMonthly : null;
  const times = monthly?.time || [];
  const pMean = monthly?.precipitation_mean || [];
  const pAnom = monthly?.precipitation_anomaly || [];
  const tAnom = monthly?.temperature_2m_anomaly || [];
  const monthRows = times.map((key, i) => {
    const [year, month] = String(key).slice(0, 7).split('-').map(Number);
    if (!year || !month) return null;
    const mean = Number(pMean[i]), anomaly = Number(pAnom[i]), tempAnomaly = Number(tAnom[i]);
    const deficitPct = Number.isFinite(mean) && mean > 0 && Number.isFinite(anomaly)
      ? Math.max(0, -anomaly / mean * 100) : NaN;
    return { start: new Date(year, month - 1, 1), end: new Date(year, month, 0), deficitPct, tempAnomaly };
  }).filter(Boolean);

  const assessCandidate = cropId => {
    const crop = availableCrops.find(c => c.id === cropId);
    if (!crop || !monthRows.length || Number.isNaN(sowDate.getTime()))
      return { level: 'NOT ASSESSED', penalty: 0, coveredDays: 0, peakDeficitPct: null };
    const st = crop.stages || {};
    const stages = [
      { key: 'establishment', days: Number(st.ini_days || 0), kc: Number(crop.kc?.ini || 0.3), peak: false },
      { key: 'vegetative', days: Number(st.dev_days || 0), kc: (Number(crop.kc?.ini || 0.3) + Number(crop.kc?.mid || 1)) / 2, peak: false },
      { key: 'peak demand', days: Number(st.mid_days || 0), kc: Number(crop.kc?.mid || 1), peak: true },
      { key: 'maturation', days: Number(st.late_days || 0), kc: (Number(crop.kc?.mid || 1) + Number(crop.kc?.late || 0.3)) / 2, peak: false }
    ];
    let cursor = new Date(sowDate), weightedDeficit = 0, weightedDays = 0, coveredDays = 0, peakWeighted = 0, peakDays = 0, warmDays = 0;
    for (const stage of stages) {
      const start = new Date(cursor), end = new Date(cursor);
      end.setDate(end.getDate() + Math.max(0, stage.days) - 1);
      cursor.setDate(cursor.getDate() + Math.max(0, stage.days));
      for (const month of monthRows) {
        const lo = Math.max(start.getTime(), month.start.getTime());
        const hi = Math.min(end.getTime(), month.end.getTime());
        const overlap = Math.max(0, Math.floor((hi - lo) / 86400000) + 1);
        if (!overlap) continue;
        coveredDays += overlap;
        if (Number.isFinite(month.deficitPct)) {
          const weight = overlap * Math.max(0.3, stage.kc) * (stage.peak ? 1.5 : 1);
          weightedDeficit += month.deficitPct * weight;
          weightedDays += weight;
          if (stage.peak) { peakWeighted += month.deficitPct * overlap; peakDays += overlap; }
        }
        if (Number.isFinite(month.tempAnomaly) && month.tempAnomaly >= 1) warmDays += overlap;
      }
    }
    const signal = weightedDays ? weightedDeficit / weightedDays : null;
    const peakSignal = peakDays ? peakWeighted / peakDays : null;
    if (!coveredDays || signal === null) return { level: 'INSUFFICIENT COVERAGE', penalty: 0, coveredDays, peakDeficitPct: peakSignal };
    const level = signal >= 40 || (signal >= 25 && warmDays >= 7) ? 'HIGHER CONCERN' : signal >= 15 ? 'ELEVATED CONCERN' : 'LOWER SIGNAL';
    // Max 15 points deducted; stronger weight when the deficit overlaps peak crop demand.
    const peakFactor = peakSignal === null ? 1 : (peakSignal >= 30 ? 1.25 : 1);
    const penalty = Math.min(15, Math.round(Math.max(0, (signal - 10) * 0.25 * peakFactor) + (warmDays >= 7 ? 2 : 0)));
    return { level, penalty, coveredDays, peakDeficitPct: peakSignal, weightedDeficitPct: signal, warmDays };
  };

  adjusted.matrix = adjusted.matrix.map(row => {
    const seasonal = assessCandidate(row.cropId);
    const baseScore = Number(row.baseScore ?? row.score);
    return { ...row, baseScore, seasonalWaterRisk: seasonal, seasonalPenalty: seasonal.penalty,
      score: Math.max(0, baseScore - seasonal.penalty) };
  }).sort((a, b) => b.score - a.score);
  adjusted.strategies = (adjusted.strategies || []).map(strategy => {
    const candidate = adjusted.matrix.find(row => row.cropId === strategy.nextCrop?.id);
    if (!candidate) return strategy;
    return { ...strategy, baseScore: Number(strategy.baseScore ?? strategy.score), score: candidate.score,
      seasonalWaterRisk: candidate.seasonalWaterRisk,
      summary: `${strategy.nextCrop.name}: ${candidate.score}/100 climate-adjusted screening fit (base ${candidate.baseScore}/100; seasonal water-risk adjustment −${candidate.seasonalPenalty}).` };
  });
  adjusted.scoringNote = `${analysis.scoringNote || ''} Seasonal adjustment: up to 15 points deducted using monthly rainfall-deficit and warm-anomaly signals overlapping each candidate crop's own stages; peak-demand overlap is weighted more heavily. No adjustment is applied where seasonal coverage is insufficient. This is an exploratory heuristic, not a calibrated yield-loss model.`;
  adjusted.seasonalAdjustmentApplied = monthRows.length > 0;
  return adjusted;
}

function renderRotationStrategies(analysis) {
  analysis = applySeasonalRotationAdjustment(analysis);
  const { baseline, strategies } = analysis;

  // Render Baseline Card
  const baselineContainer = document.getElementById('baseline-container');
  baselineContainer.innerHTML = `
    <div class="bg-red-950/30 rounded-xl p-5 border border-red-800/40 space-y-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation text-red-400"></i>
          <h4 class="font-bold text-white text-sm sm:text-base">${baseline.name}</h4>
        </div>
        <span class="text-xs px-2.5 py-0.5 rounded-full ${baseline.badgeColor} border font-mono">
          Baseline comparator
        </span>
      </div>
      <p class="text-xs text-slate-300">${baseline.summary}</p>
      
      <div class="bg-slate-900/80 p-3 rounded-lg border border-slate-800 text-xs">
        <div class="font-semibold text-red-300 mb-1">Main things to watch</div>
        <ul class="list-disc list-inside text-slate-300 space-y-0.5">
          ${(baseline.risks || []).slice(0, 3).map(r => `<li>${r}</li>`).join('')}
        </ul>
      </div>
    </div>
  `;

  // Render 3 Strategies Grid
  const strategiesContainer = document.getElementById('strategies-container');
  strategiesContainer.innerHTML = strategies.map((s, idx) => `
    <div class="bg-slate-900/80 rounded-xl p-5 border border-slate-700/80 flex flex-col justify-between space-y-4 hover:border-cyan-500/50 transition">
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-bold text-slate-400 flex items-center gap-1.5">
            <i class="fa-solid ${s.icon} text-cyan-400"></i>
            Strategy ${idx + 1}
          </span>
          <span class="text-xs font-mono font-bold px-2 py-0.5 rounded-full ${s.badgeColor} border">
            ${s.score}/100 ${s.scoreLabel || 'Screening fit'}
          </span>
        </div>

        <h4 class="text-base font-bold text-white">${s.name}</h4>
        <div class="text-xs text-cyan-300 font-semibold mt-0.5">Recommended Crop: ${s.nextCrop.name}</div>
        <p class="text-xs text-slate-300 mt-2">${s.summary}</p>
        ${s.seasonalWaterRisk ? `<div class="mt-2 rounded-lg bg-slate-950/70 border border-slate-700 p-2 text-[11px] text-cyan-200">Seasonal water outlook: <strong>${s.seasonalWaterRisk.level}</strong> · penalty ${s.seasonalWaterRisk.penalty} points${s.seasonalWaterRisk.coveredDays ? ' · ' + s.seasonalWaterRisk.coveredDays + ' crop-days covered' : ''}</div>` : ''}

        <div class="mt-4 pt-3 border-t border-slate-800 space-y-2 text-xs">
          <div>
            <div class="font-semibold text-emerald-400">Why choose it:</div>
            <ul class="list-disc list-inside space-y-0.5 text-slate-300 mt-0.5">
              ${s.benefits.map(b => `<li>${b}</li>`).join('')}
            </ul>
          </div>
          <div>
            <div class="font-semibold text-amber-400">What to watch:</div>
            <ul class="list-disc list-inside space-y-0.5 text-slate-400 mt-0.5">
              ${s.risks.map(r => `<li>${r}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>


    </div>
  `).join('');

  const matrixContainer = document.getElementById('rotation-matrix-container');
  if (matrixContainer && Array.isArray(analysis.matrix)) {
    const weights = [
      ['Zone fit', 'zoneFit'], ['Crop-category break', 'cropCategoryBreak'],
      ['Nitrogen-fixing', 'nitrogenFixing'], ['Drought tolerance', 'droughtTolerance'],
      ['Duration', 'duration'], ['Mid-season Kc', 'midSeasonWaterDemand']
    ];
    matrixContainer.innerHTML = `
      <details class="rounded-xl border border-slate-700 bg-slate-900/70 overflow-hidden">
        <summary class="cursor-pointer select-none p-4 text-sm font-semibold text-cyan-200 hover:bg-slate-800/70">See how the crop recommendations are scored <span class="block text-xs font-normal text-slate-400 mt-1">Optional technical details for advisers and researchers</span></summary>
        <div class="border-t border-slate-700">
        <div class="p-4 border-b border-slate-700">
          <h4 class="font-bold text-white">Crop Rotation Score Breakdown</h4>
          <p class="text-xs text-slate-400 mt-1">Scores compare crop suitability for ${analysis.zoneName || 'the selected zone'}. ${analysis.seasonalAdjustmentApplied ? 'Seasonal outlook has been included.' : 'Load the seasonal outlook to include long-range climate guidance.'}</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs text-left min-w-[1120px]">
            <thead class="bg-slate-950 text-slate-300"><tr>
              <th class="p-3">Candidate crop</th><th class="p-3">Category</th>
              ${weights.map(([label]) => `<th class="p-3 text-center">${label}</th>`).join('')}
              <th class="p-3 text-center">Seasonal water risk</th><th class="p-3 text-center">Climate-adjusted total</th>
            </tr></thead>
            <tbody>${analysis.matrix.map(row => `
              <tr class="border-t border-slate-800 hover:bg-slate-800/50">
                <td class="p-3 font-semibold text-white">${row.cropName}</td>
                <td class="p-3 text-slate-400">${row.category}</td>
                ${weights.map(([, key]) => `<td class="p-3 text-center text-slate-300">${row.scoreBreakdown[key]}</td>`).join('')}
                <td class="p-3 text-center ${row.seasonalPenalty >= 8 ? 'text-rose-300' : row.seasonalPenalty >= 4 ? 'text-amber-300' : 'text-emerald-300'}">${row.seasonalWaterRisk?.level || 'NOT ASSESSED'}${row.seasonalWaterRisk?.peakDeficitPct != null ? `<br><span class="text-[10px]">Peak-stage deficit signal ${row.seasonalWaterRisk.peakDeficitPct.toFixed(0)}%</span>` : ''}<br><span class="text-[10px]">−${row.seasonalPenalty || 0} points</span></td>
                <td class="p-3 text-center font-bold text-emerald-300">${row.score}/100</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="p-4 border-t border-slate-700 text-[11px] text-slate-400">${analysis.scoringNote || ''}</div>
        </div>
      </details>`;
  }
}
