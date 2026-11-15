/**
 * FAO-56 Agro-Meteorological, Thermal & Crop Rotation Engine
 * NASA Space Apps Challenge 2026: Field Shift (Nigeria)
 */

const fs = require('fs');
const path = require('path');

// Load databases
const cropsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/nigeria_crops.json'), 'utf8'));
const zonesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/nigeria_zones.json'), 'utf8'));

/**
 * 1. Calculate FAO-56 Penman-Monteith Reference Evapotranspiration (ET0)
 */
function calculateFAO56_ET0({ tempMean, tempMax, tempMin, solarRad, windSpeed, rhMean, elevation = 400 }) {
  const P = 101.3 * Math.pow((293 - 0.0065 * elevation) / 293, 5.26);
  const gamma = 0.000665 * P;
  const delta = (4098 * (0.6108 * Math.exp((17.27 * tempMean) / (tempMean + 237.3)))) / Math.pow(tempMean + 237.3, 2);

  const e_Tmax = 0.6108 * Math.exp((17.27 * tempMax) / (tempMax + 237.3));
  const e_Tmin = 0.6108 * Math.exp((17.27 * tempMin) / (tempMin + 237.3));
  const es = (e_Tmax + e_Tmin) / 2;
  const ea = es * (rhMean / 100);

  const Rns = 0.77 * solarRad;
  const Rnl = 0.15 * solarRad * (1.35 * (ea / es) - 0.35);
  const Rn = Math.max(0.1, Rns - Rnl);
  const G = 0;

  const numerator = 0.408 * delta * (Rn - G) + gamma * (900 / (tempMean + 273)) * windSpeed * (es - ea);
  const denominator = delta + gamma * (1 + 0.34 * windSpeed);

  const et0 = Math.max(0.5, numerator / denominator);
  return Number(et0.toFixed(2));
}

/**
 * 2. Calculate Stage-by-Stage Crop Evapotranspiration (ETc)
 */
function calculateCropWaterRequirements(crop, et0) {
  const { stages, kc } = crop;
  const { ini_days, dev_days, mid_days, late_days } = stages;
  const totalDays = ini_days + dev_days + mid_days + late_days;

  const kc_dev_avg = (kc.ini + kc.mid) / 2;
  const kc_late_avg = (kc.mid + kc.late) / 2;

  const water_ini = ini_days * (kc.ini * et0);
  const water_dev = dev_days * (kc_dev_avg * et0);
  const water_mid = mid_days * (kc.mid * et0);
  const water_late = late_days * (kc_late_avg * et0);

  const totalWaterRequirement_mm = water_ini + water_dev + water_mid + water_late;

  return {
    cropId: crop.id,
    cropName: crop.name,
    totalDays,
    dailyPeakRequirement_mm: Number((kc.mid * et0).toFixed(2)),
    totalSeasonalRequirement_mm: Number(totalWaterRequirement_mm.toFixed(1)),
    stages: [
      { name: "Initial (Establishment)", days: ini_days, avgKc: kc.ini, water_mm: Number(water_ini.toFixed(1)) },
      { name: "Development (Vegetative)", days: dev_days, avgKc: Number(kc_dev_avg.toFixed(2)), water_mm: Number(water_dev.toFixed(1)) },
      { name: "Mid-Season (Reproductive/Flowering)", days: mid_days, avgKc: kc.mid, water_mm: Number(water_mid.toFixed(1)), isPeak: true },
      { name: "Late Season (Ripening/Harvest)", days: late_days, avgKc: Number(kc_late_avg.toFixed(2)), water_mm: Number(water_late.toFixed(1)) }
    ]
  };
}

/**
 * 3. Soil Water Capacity & Depletion
 */
function calculateSoilWaterLimits(soilProfile, rootDepth_m, depletion_p = 0.5) {
  const awc_mm_m = soilProfile.awc_mm_per_m || (soilProfile.fc_vol_pct - soilProfile.pwp_vol_pct) * 10;
  const taw = awc_mm_m * rootDepth_m;
  const raw = taw * depletion_p;

  return {
    texture: soilProfile.texture_class,
    awc_mm_per_m: awc_mm_m,
    rootDepth_m,
    taw_mm: Number(taw.toFixed(1)),
    raw_mm: Number(raw.toFixed(1))
  };
}

/**
 * 4. Thermal & Heat Stress Assessment
 * Evaluates temperature forecast / climate against crop temperature thresholds and GDD
 */
function evaluateThermalSuitability(crop, forecastOrSeasonTemps) {
  const { thermal, stages } = crop;
  const temps = forecastOrSeasonTemps || {
    tempMax: [32, 33, 34, 35, 36, 34, 33],
    tempMin: [22, 23, 23, 24, 24, 23, 22],
    tempMean: [27, 28, 28.5, 29.5, 30, 28.5, 27.5]
  };

  const daysCount = temps.tempMax.length;
  let heatStressDays = 0;
  let accumulatedGDD = 0;
  let withinOptCount = 0;

  for (let i = 0; i < daysCount; i++) {
    const tMax = temps.tempMax[i];
    const tMin = temps.tempMin[i];
    const tMean = temps.tempMean ? temps.tempMean[i] : (tMax + tMin) / 2;

    // Check Heat Stress Threshold
    if (tMax >= thermal.t_crit_max) {
      heatStressDays++;
    }

    // Optimum growth temperature check
    if (tMean >= thermal.t_opt_min && tMean <= thermal.t_opt_max) {
      withinOptCount++;
    }

    // Growing Degree Days (GDD)
    const effectiveT = Math.max(thermal.t_base, Math.min(tMean, thermal.t_opt_max));
    accumulatedGDD += Math.max(0, effectiveT - thermal.t_base);
  }

  // Thermal suitability score (0-100)
  const heatStressPenalty = (heatStressDays / daysCount) * 40;
  const optBonus = (withinOptCount / daysCount) * 60;
  const thermalScore = Math.max(10, Math.min(100, Math.round(40 + optBonus - heatStressPenalty)));

  let heatStatus = "OPTIMAL";
  let heatAlertBadge = "badge-success";
  let heatAdvisory = `Temperatures remain within the optimal range (${thermal.t_opt_min}°C – ${thermal.t_opt_max}°C) for ${crop.name}. Zero heat stress days detected.`;

  if (heatStressDays > 0) {
    if (heatStressDays >= 3 || thermal.heat_tolerance === "Moderate") {
      heatStatus = "CRITICAL HEAT RISK";
      heatAlertBadge = "badge-danger";
      heatAdvisory = `Forecast indicates ${heatStressDays} day(s) exceeding ${thermal.t_crit_max}°C. If this coincides with flowering/silking, pollen abortion and significant yield reduction will occur. Consider heat-tolerant varieties or shade intercropping.`;
    } else {
      heatStatus = "MODERATE HEAT STRESS";
      heatAlertBadge = "badge-warning";
      heatAdvisory = `Forecast indicates ${heatStressDays} day(s) near the critical threshold (${thermal.t_crit_max}°C). Ensure adequate soil moisture to maintain evaporative leaf cooling.`;
    }
  }

  return {
    cropId: crop.id,
    cropName: crop.name,
    t_base: thermal.t_base,
    t_opt_range: [thermal.t_opt_min, thermal.t_opt_max],
    t_crit_max: thermal.t_crit_max,
    heat_tolerance: thermal.heat_tolerance,
    heatStressDays,
    accumulatedGDD: Number(accumulatedGDD.toFixed(1)),
    gddRequired: thermal.gdd_required,
    thermalScore,
    heatStatus,
    heatAlertBadge,
    heatAdvisory
  };
}

/**
 * 5. Dry Spell Collision Detection & Risk Assessment
 */
function assessDrySpellCollision(crop, sowingDOY, zone) {
  const { stages } = crop;
  const peakStartDOY = sowingDOY + stages.ini_days + stages.dev_days;
  const peakEndDOY = peakStartDOY + stages.mid_days;

  const [dryStartDOY, dryEndDOY] = zone.dry_spell_risk.critical_window_doy;

  const overlapStart = Math.max(peakStartDOY, dryStartDOY);
  const overlapEnd = Math.min(peakEndDOY, dryEndDOY);
  const overlapDays = Math.max(0, overlapEnd - overlapStart + 1);

  let riskLevel = "LOW / SAFE";
  let alertBadge = "badge-success";
  let advisory = "No significant overlap between the peak consumptive stage and the zone seasonal dry-spell baseline.";

  if (overlapDays > 0) {
    if (crop.ky_mid >= 1.0 || overlapDays >= 8) {
      riskLevel = "CRITICAL / HIGH RISK";
      alertBadge = "badge-danger";
      advisory = `Peak reproductive stage falls squarely within the ${zone.name} dry spell window (${overlapDays} days of seasonal dry-spell baseline). This is a climatological screening signal, not a live rainfall forecast. High risk if a comparable dry spell occurs during flowering; consider a sowing-date shift or variety substitution.`;
    } else {
      riskLevel = "MODERATE RISK";
      alertBadge = "badge-warning";
      advisory = `Moderate overlap (${overlapDays} days) with the seasonal dry-spell baseline. This is not a live forecast; monitor actual rainfall and soil moisture during flowering.`;
    }
  }

  return {
    cropName: crop.name,
    sowingDOY,
    peakStageDOY: [peakStartDOY, peakEndDOY],
    drySpellWindowDOY: [dryStartDOY, dryEndDOY],
    overlapDays,
    riskLevel,
    alertBadge,
    advisory
  };
}

/**
 * 6. Short-range forecast dry-spell detection.
 * A forecast dry day is defined here as <1.0 mm daily precipitation.
 * A candidate dry spell requires >=3 consecutive forecast dry days.
 * This is a short-range weather forecast signal, not a seasonal prediction.
 */
function assessForecastDrySpell(crop, sowingDOY, forecastDates = [], forecastRainfall = [], plantingDate = null) {
  const peakStart = sowingDOY + crop.stages.ini_days + crop.stages.dev_days;
  const peakEnd = peakStart + crop.stages.mid_days - 1;
  const n = Math.min(forecastDates.length, forecastRainfall.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const date = String(forecastDates[i] || '').slice(0, 10);
    const rain = Number(forecastRainfall[i]);
    if (!date || !Number.isFinite(rain)) continue;
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    rows.push({ date, rain, doy, dry: rain < 1.0, peakStage: doy >= peakStart && doy <= peakEnd });
  }
  // A short-range weather forecast is only relevant to planting decisions when
  // the selected planting date falls inside the actual forecast date window.
  // Do not interpret weather in the next 7–14 days as a warning for a crop
  // planned weeks or months later.
  const normalizedPlantingDate = plantingDate ? String(plantingDate).slice(0, 10) : null;
  const horizonStart = rows[0]?.date || null;
  const horizonEnd = rows[rows.length - 1]?.date || null;
  const plantingWithinForecast = Boolean(
    normalizedPlantingDate && horizonStart && horizonEnd &&
    normalizedPlantingDate >= horizonStart && normalizedPlantingDate <= horizonEnd
  );
  if (normalizedPlantingDate && rows.length && !plantingWithinForecast) {
    return {
      provider: 'short-range weather forecast', threshold_mm_day: 1,
      minimum_consecutive_days: 3, forecastDays: rows.length,
      riskLevel: 'OUTSIDE FORECAST WINDOW',
      advisory: `The selected planting date (${normalizedPlantingDate}) is outside the available short-range forecast (${horizonStart} to ${horizonEnd}). Immediate dry-spell warnings are therefore not applied to this planting plan. Use the seasonal crop-stage assessment for longer-term planning.`,
      drySpellStart: null, drySpellEnd: null, consecutiveDryDays: 0,
      reproductiveStageOverlapDays: 0, peakStageDOY: [peakStart, peakEnd],
      forecastHorizonStart: horizonStart, forecastHorizonEnd: horizonEnd,
      plantingDate: normalizedPlantingDate, plantingWithinForecast: false,
      assessmentAvailable: false, applicable: false
    };
  }
  let runs = [], run = [];
  for (const row of rows) {
    if (row.dry) run.push(row);
    else { if (run.length >= 3) runs.push(run); run = []; }
  }
  if (run.length >= 3) runs.push(run);
  const longest = runs.sort((a,b) => b.length-a.length)[0] || [];
  const stageOverlap = longest.filter(x => x.peakStage);
  const hasHorizon = rows.length > 0;
  let riskLevel = 'NO DRY SPELL PREDICTED';
  let advisory = hasHorizon
    ? 'No run of 3 or more consecutive forecast days below 1 mm/day was detected in the available forecast period.'
    : 'A short-range rainfall forecast is unavailable; no forecast-based dry-spell conclusion can be made.';
  if (longest.length >= 3) {
    riskLevel = longest.length >= 5 ? 'HIGH FORECAST RISK' : 'MODERATE FORECAST RISK';
    const start = longest[0].date, end = longest[longest.length-1].date;
    advisory = `${longest.length} consecutive forecast days with less than 1 mm/day rainfall are indicated (${start} to ${end}).`;
    if (stageOverlap.length) advisory += ` ${stageOverlap.length} forecast dry day(s) overlap the crop's estimated reproductive stage.`;
    else advisory += ' This forecast dry spell does not overlap the estimated reproductive stage within the available forecast horizon.';
  }
  return {
    provider: 'short-range weather forecast', threshold_mm_day: 1,
    minimum_consecutive_days: 3, forecastDays: rows.length,
    riskLevel, advisory,
    drySpellStart: longest[0]?.date || null,
    drySpellEnd: longest[longest.length-1]?.date || null,
    consecutiveDryDays: longest.length,
    reproductiveStageOverlapDays: stageOverlap.length,
    peakStageDOY: [peakStart, peakEnd],
    forecastHorizonStart: rows[0]?.date || null,
    forecastHorizonEnd: rows[rows.length-1]?.date || null,
    assessmentAvailable: hasHorizon,
    plantingDate: normalizedPlantingDate,
    plantingWithinForecast: normalizedPlantingDate ? plantingWithinForecast : null,
    applicable: hasHorizon
  };
}

/**
 * 6. Optimal Sowing Window Finder
 */
function findOptimalSowingWindow(crop, zone, searchWindowDOY = [160, 200]) {
  const results = [];
  const [minDOY, maxDOY] = searchWindowDOY;

  for (let doy = minDOY; doy <= maxDOY; doy += 2) {
    const assessment = assessDrySpellCollision(crop, doy, zone);
    results.push({
      sowingDOY: doy,
      overlapDays: assessment.overlapDays,
      riskLevel: assessment.riskLevel
    });
  }

  results.sort((a, b) => a.overlapDays - b.overlapDays);
  const bestOptions = results.filter(r => r.overlapDays === results[0].overlapDays);

  return {
    cropName: crop.name,
    zoneName: zone.name,
    minOverlapDays: results[0].overlapDays,
    recommendedSowingDOYRange: [bestOptions[0].sowingDOY, bestOptions[bestOptions.length - 1].sowingDOY]
  };
}

/**
 * 7. Transparent, data-driven crop rotation screening.
 * Scores are heuristic screening indices from the crop database, not calibrated
 * yield predictions or measured field outcomes.
 */
function generateRotationStrategies(currentCropId, zoneId, sowingDOY = 175) {
  const zone = zonesData.zones.find(z => z.id === zoneId) || zonesData.zones[1];
  const currentCrop = cropsData.crops.find(c => c.id === currentCropId) || cropsData.crops[2];
  const candidates = cropsData.crops.filter(c => c.id !== currentCrop.id);

  const rankCrop = (candidate) => {
    const zoneFit = candidate.optimal_zones.includes(zone.name) ? 30 : 0;
    const familyBreak = candidate.category !== currentCrop.category ? 20 : 5;
    const nitrogenBenefit = candidate.n_fixing ? 20 : 0;
    const drought = ({ 'Very High': 15, 'High': 12, 'Moderate': 7, 'Low': 2 })[candidate.drought_tolerance] || 0;
    const durationFit = candidate.duration_days <= 120 ? 10 : candidate.duration_days <= 180 ? 6 : 2;
    const moderateWaterDemand = candidate.kc.mid <= 1.1 ? 5 : candidate.kc.mid <= 1.2 ? 3 : 1;
    const score = zoneFit + familyBreak + nitrogenBenefit + drought + durationFit + moderateWaterDemand;
    const reasons = [];
    if (zoneFit) reasons.push(`Listed as suitable for ${zone.name}`);
    if (familyBreak === 20) reasons.push('Provides a crop-category break from the current crop');
    if (candidate.n_fixing) reasons.push(`Legume with a database N-fixation estimate of ${candidate.n_fixation_kg_ha || 'unspecified'} kg/ha`);
    reasons.push(`${candidate.drought_tolerance} drought-tolerance rating`);
    reasons.push(`${candidate.duration_days}-day crop duration`);
    return {
      crop: candidate, score, zoneFit, familyBreak, nitrogenBenefit, drought,
      durationFit, moderateWaterDemand, reasons,
      waterDemandIndex: Number((candidate.kc.mid * candidate.duration_days).toFixed(1))
    };
  };

  const ranked = candidates.map(rankCrop).sort((a, b) => b.score - a.score);
  const choose = (predicate, fallbackIndex = 0) => ranked.find(predicate) || ranked[fallbackIndex] || ranked[0];
  const legume = choose(x => x.crop.n_fixing && x.zoneFit > 0);
  const resilient = [...ranked].sort((a, b) => {
    const resilienceScore = x => ({ 'Very High': 4, 'High': 3, 'Moderate': 2, 'Low': 1 }[x.crop.drought_tolerance] || 0) * 3
      + ({ 'Very High': 4, 'High': 3, 'Moderate': 2, 'Low': 1 }[x.crop.thermal.heat_tolerance] || 0) * 2
      + (x.zoneFit ? 5 : 0) + x.durationFit;
    return resilienceScore(b) - resilienceScore(a);
  })[0] || ranked[0];
  const marketPool = ranked.filter(x => x.crop.id !== resilient.crop.id && x.crop.id !== legume.crop.id);
  const market = [...(marketPool.length ? marketPool : ranked)].sort((a, b) => {
    const marketScore = x => (x.crop.market_value.includes('Extremely High') ? 4 : x.crop.market_value.includes('Very High') ? 3 : x.crop.market_value.includes('High') ? 2 : 1)
      * 5 + (x.zoneFit ? 10 : 0) + (x.crop.category === 'Oilseed' ? 4 : 0) + x.durationFit;
    return marketScore(b) - marketScore(a);
  })[0] || ranked[0];
  const balanced = ranked[0];

  const baseline = {
    strategyId: 'baseline', name: 'Continuous Cropping (Baseline)', nextCrop: currentCrop,
    theme: 'No crop-category break', icon: 'fa-repeat',
    badgeColor: 'bg-red-500/20 text-red-300 border-red-500/40',
    summary: `Planting ${currentCrop.name} again maintains the same crop category rather than introducing a planned rotation break.`,
    benefits: ['May preserve familiar seed, market and production arrangements.'],
    risks: ['Does not deliberately interrupt crop-specific pest, disease or weed cycles.', 'Repeats the current crop nutrient-demand pattern.', 'Does not provide the potential nitrogen contribution of a legume break crop.'],
    evidence: 'Baseline comparator only. Actual pest, soil fertility and yield effects depend on field history and management.',
    informationGaps: 'Field history, disease and Striga pressure, soil fertility and residue management are not yet supplied.',
    score: 0
  };

  const makeStrategy = (id, name, theme, icon, selected, focus, benefits, risks) => ({
    strategyId: id, name, theme, icon,
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    nextCrop: selected.crop,
    summary: `${selected.crop.name} is the strongest database match for this objective in ${zone.name} (${selected.score}/100 screening fit).`,
    benefits: benefits(selected),
    risks: risks(selected),
    evidence: `Screening uses the project's crop database: zone fit, crop-category break, nitrogen-fixing status, drought-tolerance class, duration and mid-season Kc. ${focus}`,
    informationGaps: 'The score is a transparent heuristic, not a validated yield or profit forecast. Confirm variety availability, soil pH/fertility, field disease history, market access and planting-window rainfall locally.',
    score: selected.score,
    scoreLabel: 'Screening fit',
    scoreBreakdown: {
      zoneFit: selected.zoneFit, cropCategoryBreak: selected.familyBreak,
      nitrogenFixing: selected.nitrogenBenefit, droughtTolerance: selected.drought,
      duration: selected.durationFit, midSeasonWaterDemand: selected.moderateWaterDemand
    },
    reasons: selected.reasons
  });

  const strategy1 = makeStrategy(
    'strategy_nitrogen', 'Soil Fertility & Crop-Category Break', 'Legume-based soil fertility option', 'fa-seedling', legume,
    'Priority is given to a suitable legume after a non-legume crop.',
    x => [x.crop.n_fixing ? `Legume; database N-fixation estimate: ${x.crop.n_fixation_kg_ha || 'not specified'} kg/ha (not equivalent to guaranteed residual soil N).` : 'No suitable legume candidate was identified; review local rotation options.', 'Changes crop category relative to the current crop.', `Zone suitability: ${x.zoneFit ? 'listed' : 'not listed'}.`],
    x => ['N fixation depends on effective nodulation, compatible rhizobia, phosphorus and soil conditions.', 'Avoid assuming all fixed nitrogen remains available to the following crop.', 'Check shared pests and diseases before selecting a legume sequence.']
  );
  const strategy2 = makeStrategy(
    'strategy_climate', 'Drought-Resilience Option', 'Prioritises drought-tolerance and zone fit', 'fa-shield-halved', resilient,
    'Drought tolerance and zone fit receive priority; this is not a seasonal forecast.',
    x => [`Drought-tolerance class: ${x.crop.drought_tolerance}.`, `Crop duration: ${x.crop.duration_days} days.`, `Mid-season Kc: ${x.crop.kc.mid}.`],
    x => ['A drought-tolerant rating does not guarantee performance under severe or prolonged water deficit.', 'Confirm sowing-window length, soil depth and local variety performance.']
  );
  const strategy3 = makeStrategy(
    'strategy_market', 'Market & Enterprise Diversification', 'Prioritises market-value class and zone fit', 'fa-sack-dollar', market,
    'Market-value class and zone fit are used as preliminary filters; local buyer access and farmgate price are not known.',
    x => [`Market-value class in crop database: ${x.crop.market_value}.`, `Crop duration: ${x.crop.duration_days} days.`, `Zone suitability: ${x.zoneFit ? 'listed' : 'not listed'}.`],
    x => ['Market-value class is not a live price or profit estimate.', 'Verify buyer demand, quality standards, transport, input costs and storage before choosing a commercial crop.']
  );

  const matrix = ranked.map(x => ({
    cropId: x.crop.id, cropName: x.crop.name, category: x.crop.category,
    score: x.score, scoreBreakdown: {
      zoneFit: x.zoneFit, cropCategoryBreak: x.familyBreak,
      nitrogenFixing: x.nitrogenBenefit, droughtTolerance: x.drought,
      duration: x.durationFit, midSeasonWaterDemand: x.moderateWaterDemand
    },
    reasons: x.reasons, droughtTolerance: x.crop.drought_tolerance,
    durationDays: x.crop.duration_days, midSeasonKc: x.crop.kc.mid,
    nFixing: x.crop.n_fixing
  }));

  return {
    baseline, strategies: [strategy1, strategy2, strategy3], matrix,
    scoringNote: 'Heuristic screening index (0–100), not a calibrated probability, yield prediction or economic return. Weights: zone fit 30; crop-category break 20 (5 if same category); nitrogen-fixing 20; drought tolerance up to 15; duration up to 10; mid-season Kc up to 5.',
    currentCrop: { id: currentCrop.id, name: currentCrop.name, category: currentCrop.category },
    zoneName: zone.name
  };
}

module.exports = {
  cropsData,
  zonesData,
  calculateFAO56_ET0,
  calculateCropWaterRequirements,
  calculateSoilWaterLimits,
  evaluateThermalSuitability,
  assessDrySpellCollision,
  assessForecastDrySpell,
  findOptimalSowingWindow,
  generateRotationStrategies
};
