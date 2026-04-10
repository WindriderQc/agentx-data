let mqtt;
try { mqtt = require('mqtt'); } catch { mqtt = null; }

const { log } = require('../utils/logger');

let client;

function init(options = {}) {
  if (process.env.NODE_ENV === 'test') return;

  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    log('[MQTT] No MQTT_BROKER_URL configured — skipping');
    return;
  }
  if (!mqtt) {
    log('[MQTT] mqtt package not installed — skipping');
    return;
  }

  client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    ...options
  });

  client.on('connect', () => log('[MQTT] Connected'));
  client.on('error', (err) => log(`[MQTT] Error: ${err.message}`, 'error'));
  client.on('reconnect', () => log('[MQTT] Reconnecting...'));
  return client;
}

function publish(topic, message) {
  if (!client?.connected) return;
  const payload = typeof message === 'object' ? JSON.stringify(message) : message;
  client.publish(topic, payload, (err) => {
    if (err) log(`[MQTT] Publish error: ${err.message}`, 'error');
  });
}

function close() {
  return new Promise((resolve) => {
    if (client) { client.end(true, () => { client = null; resolve(); }); }
    else resolve();
  });
}

module.exports = { init, publish, close };
