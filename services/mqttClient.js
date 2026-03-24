let mqtt;
try { mqtt = require('mqtt'); } catch { mqtt = null; }

let client;

function init(options = {}) {
  if (process.env.NODE_ENV === 'test') return;

  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    console.log('[MQTT] No MQTT_BROKER_URL configured — skipping');
    return;
  }
  if (!mqtt) {
    console.log('[MQTT] mqtt package not installed — skipping');
    return;
  }

  client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    ...options
  });

  client.on('connect', () => console.log('[MQTT] Connected'));
  client.on('error', (err) => console.error('[MQTT] Error:', err));
  client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
  return client;
}

function publish(topic, message) {
  if (!client?.connected) return;
  const payload = typeof message === 'object' ? JSON.stringify(message) : message;
  client.publish(topic, payload, (err) => {
    if (err) console.error('[MQTT] Publish error:', err);
  });
}

function close() {
  return new Promise((resolve) => {
    if (client) { client.end(true, () => { client = null; resolve(); }); }
    else resolve();
  });
}

module.exports = { init, publish, close, getClient: () => client };
