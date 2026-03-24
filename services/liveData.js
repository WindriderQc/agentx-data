const mqttClient = require('./mqttClient');
const { fetchWithTimeoutAndRetry } = require('../utils/fetch-utils');
const { log } = require('../utils/logger');

let db;
let intervalIds = [];
let initialized = false;

// Service config — toggled via API or DB
let state = {
  liveDataEnabled: false,
  iss: false,
  quakes: false,
  weather: false
};

// Defaults (overridable via env)
const config = {
  iss: {
    url: process.env.ISS_API_URL || 'http://api.open-notify.org/iss-now.json',
    interval: parseInt(process.env.ISS_INTERVAL_MS, 10) || 10000,
    timeout: 10000, retries: 2, maxLogs: 8000,
    topic: process.env.MQTT_ISS_TOPIC || 'liveData/iss'
  },
  quakes: {
    url: process.env.QUAKES_API_URL || 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv',
    interval: parseInt(process.env.QUAKES_INTERVAL_MS, 10) || 86400000,
    timeout: 15000, retries: 2,
    path: process.env.QUAKES_DATA_PATH || './data/quakes.csv'
  },
  weather: {
    url: 'https://api.openweathermap.org/data/2.5/weather',
    apiKey: process.env.WEATHER_API_KEY,
    interval: 60000, timeout: 10000, retries: 2,
    topic: process.env.MQTT_PRESSURE_TOPIC || 'liveData/pressure'
  }
};

// --- Data fetchers ---

async function getISS() {
  if (!state.iss || !db) return;
  try {
    const res = await fetchWithTimeoutAndRetry(config.iss.url, { timeout: config.iss.timeout, retries: config.iss.retries, name: 'ISS' });
    const data = await res.json();
    if (data.message !== 'success') return;

    const lat = Number(data.iss_position?.latitude ?? data.iss_position?.lat);
    const lon = Number(data.iss_position?.longitude ?? data.iss_position?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const ts = data.timestamp ? (Number(data.timestamp) > 1e12 ? new Date(Number(data.timestamp)) : new Date(Number(data.timestamp) * 1000)) : new Date();
    const doc = { latitude: lat, longitude: lon, timeStamp: ts };

    mqttClient.publish(config.iss.topic, doc);

    const col = db.collection('isses');
    const count = await col.countDocuments();
    if (count >= config.iss.maxLogs) {
      const oldest = await col.findOne({}, { sort: { timeStamp: 1 } });
      if (oldest) await col.deleteOne({ _id: oldest._id });
    }
    await col.insertOne(doc);
  } catch (err) { log(`[liveData] ISS error: ${err.message}`, 'error'); }
}

async function getQuakes() {
  if (!state.quakes || !db) return;
  try {
    const res = await fetchWithTimeoutAndRetry(config.quakes.url, { timeout: config.quakes.timeout, retries: config.quakes.retries, name: 'Quakes' });
    const csv = await res.text();

    // Lazy-load csvtojson only when needed
    const CSVToJSON = require('csvtojson');
    const quakes = await CSVToJSON().fromString(csv);

    const col = db.collection('quakes');
    await col.deleteMany({});
    if (quakes.length > 0) {
      await col.insertMany(quakes, { ordered: false }).catch(e => {
        if (e.code !== 11000) log(`[liveData] Quakes write error: ${e.message}`, 'error');
      });
    }
    log(`[liveData] Quakes refreshed: ${quakes.length} records`);
  } catch (err) { log(`[liveData] Quakes error: ${err.message}`, 'error'); }
}

async function getPressure() {
  if (!state.weather || !db || !config.weather.apiKey) return;
  try {
    const locations = await db.collection('weatherLocations').find({}).toArray();
    for (const loc of locations) {
      const url = `${config.weather.url}?lat=${loc.lat}&lon=${loc.lon}&units=metric&appid=${config.weather.apiKey}`;
      const res = await fetchWithTimeoutAndRetry(url, { timeout: config.weather.timeout, retries: config.weather.retries, name: 'Weather' });
      const data = await res.json();
      const doc = { pressure: data.main.pressure, timeStamp: new Date(), lat: loc.lat, lon: loc.lon };
      mqttClient.publish(`${config.weather.topic}/${loc.lat},${loc.lon}`, JSON.stringify(doc));
      await db.collection('pressures').insertOne(doc);
    }
  } catch (err) { log(`[liveData] Pressure error: ${err.message}`, 'error'); }
}

// --- Lifecycle ---

function clearIntervals() {
  intervalIds.forEach(clearInterval);
  intervalIds = [];
}

function startIntervals(immediate = false) {
  if (!state.liveDataEnabled) {
    log('[liveData] Master switch OFF — no intervals');
    return;
  }

  if (immediate) {
    const tasks = [];
    if (state.iss) tasks.push(getISS());
    if (state.quakes) tasks.push(getQuakes());
    if (state.weather) tasks.push(getPressure());
    Promise.all(tasks).catch(() => {});
  }

  if (state.iss) intervalIds.push(setInterval(getISS, config.iss.interval));
  if (state.quakes) intervalIds.push(setInterval(getQuakes, config.quakes.interval));
  if (state.weather) intervalIds.push(setInterval(getPressure, config.weather.interval));

  log(`[liveData] Intervals set — ISS=${state.iss} Quakes=${state.quakes} Weather=${state.weather}`);
}

async function reloadConfig() {
  try {
    const configs = await db.collection('livedataconfigs').find({}).toArray();
    configs.forEach(cfg => {
      if (state.hasOwnProperty(cfg.service)) state[cfg.service] = cfg.enabled;
    });
    log(`[liveData] Config reloaded: ${JSON.stringify(state)}`);
    clearIntervals();
    startIntervals(false);
  } catch (e) { log(`[liveData] Reload error: ${e.message}`, 'error'); }
}

async function init(dbConnection) {
  if (initialized) return;
  db = dbConnection;

  // Ensure default configs exist
  const services = [
    { service: 'liveDataEnabled', enabled: false },
    { service: 'iss', enabled: false },
    { service: 'quakes', enabled: false },
    { service: 'weather', enabled: false }
  ];
  for (const svc of services) {
    await db.collection('livedataconfigs').updateOne(
      { service: svc.service },
      { $setOnInsert: { service: svc.service, enabled: svc.enabled, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // reloadConfig already calls startIntervals(false) — don't duplicate
  await reloadConfig();

  if (state.liveDataEnabled && state.iss && process.env.MQTT_BROKER_URL) {
    mqttClient.init();
  }

  initialized = true;
  log('[liveData] Initialized');
}

async function close() {
  clearIntervals();
  await mqttClient.close();
  initialized = false;
}

module.exports = {
  init, close, reloadConfig,
  getState: () => ({ ...state }),
  getConfig: () => config
};
