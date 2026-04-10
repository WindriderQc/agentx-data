const { log } = require('./logger');

const INDEX_SPECS = [
  { collection: 'nas_files', key: { path: 1 }, options: { name: 'path_unique', unique: true } },
  { collection: 'nas_files', key: { sha256: 1 }, options: { name: 'sha256_lookup' } },
  { collection: 'network_devices', key: { mac: 1 }, options: { name: 'mac_unique', unique: true } },
  { collection: 'network_devices', key: { lastSeen: -1 }, options: { name: 'last_seen_desc' } },
  { collection: 'nas_scans', key: { started_at: -1 }, options: { name: 'started_at_desc' } },
  { collection: 'appevents', key: { timestamp: -1 }, options: { name: 'timestamp_desc' } },
  { collection: 'dedup_reports', key: { created_at: -1 }, options: { name: 'created_at_desc' } },
  { collection: 'nas_pending_deletions', key: { status: 1, marked_at: -1 }, options: { name: 'status_marked_at' } },

  // TTL indexes — automatic retention for high-growth collections
  { collection: 'appevents', key: { timestamp: 1 }, options: { name: 'ttl_30d', expireAfterSeconds: 2592000 } },
  { collection: 'pressures', key: { timeStamp: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 7776000 } },
  { collection: 'integration_events', key: { at: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 7776000 } }
];

async function ensureIndexes(db) {
  for (const spec of INDEX_SPECS) {
    try {
      await db.collection(spec.collection).createIndex(spec.key, spec.options);
    } catch (error) {
      log(
        `[indexes] Failed to create ${spec.collection}.${spec.options?.name || JSON.stringify(spec.key)}: ${error.message}`,
        'warn'
      );
    }
  }
}

module.exports = { ensureIndexes };
