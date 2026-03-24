# AgentX Data — Toolkit Service

> Extracted from [DataAPI](https://github.com/WindriderQc/DataAPI). Each feature area is a self-contained **toolkit** with clear API endpoints that other AgentX services can consume.

See parent `../CLAUDE.md` for shared infrastructure (MongoDB, Ollama hosts, conventions).

## Service Info

- **Port:** 3083
- **Entry:** `server.js`
- **Database:** shared `agentx` (collection-level ownership)

---

## Toolkits

### Storage Scanner
Indexes files across NAS/disk with SHA256 hashing for deduplication.
**Consumer:** RAG (document discovery), Core (admin)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/scans` | GET | List recent scans |
| `/api/v1/storage/scan` | POST | Start a new scan |
| `/api/v1/storage/status/:scan_id` | GET | Get scan progress |
| `/api/v1/storage/stop/:scan_id` | POST | Stop a running scan |
| `/api/v1/storage/summary` | GET | Storage overview (totals, dupes, last scan) |
| `/api/v1/storage/scan/:scan_id/batch` | POST | Insert file batch (n8n workflow) |
| `/api/v1/storage/scan/:scan_id` | PATCH | Update scan status |

### File Browser
Browse, search, and analyze indexed files.
**Consumer:** RAG, Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/files/browse` | GET | Browse with filtering + pagination |
| `/api/v1/storage/files/stats` | GET | Stats by extension, size distribution |
| `/api/v1/storage/files/tree` | GET | Directory tree |
| `/api/v1/storage/files/duplicates` | GET | Find duplicates (hash or fuzzy) |
| `/api/v1/storage/files/cleanup-recommendations` | GET | Cleanup suggestions |
| `/api/v1/storage/files/:id` | PATCH | Update file metadata |

### Datalake Janitor
Deduplication workflow: suggest, mark, confirm deletions.
**Consumer:** Admin tooling, n8n

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/janitor/suggest-deletions` | POST | Suggest files for deletion |
| `/api/v1/storage/janitor/mark-for-deletion` | POST | Soft-mark files |
| `/api/v1/storage/janitor/pending-deletions` | GET | List pending deletions |
| `/api/v1/storage/janitor/confirm-deletion/:id` | DELETE | Execute deletion (destructive!) |

### Network Discovery
ARP/nmap-based LAN device scanning with enrichment.
**Consumer:** Core cluster ops (auto-discover Ollama hosts)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/network/devices` | GET | List all discovered devices |
| `/api/v1/network/scan` | POST | Scan network (default: `192.168.2.0/24`) |
| `/api/v1/network/devices/:id` | PATCH | Update device metadata (alias, notes, type) |
| `/api/v1/network/devices/:id/enrich` | POST | Deep-scan: OS detection + open ports |

Requires `nmap` installed on the host. OS detection (`-O`) needs root.

### Live Data Ingestion
Autonomous background data collection with configurable intervals.
**Consumer:** Any service needing real-time data feeds

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/livedata/state` | GET | Current service states |
| `/api/v1/livedata/config` | GET | Get config from DB |
| `/api/v1/livedata/config` | POST | Toggle service `{ service, enabled }` |
| `/api/v1/livedata/iss` | GET | Recent ISS positions |
| `/api/v1/livedata/quakes` | GET | Today's earthquakes |

Services: ISS tracker, earthquake monitor, weather/pressure. MQTT publishing optional.

### Event Feed
Application event logging with real-time SSE streaming.
**Consumer:** All services, dashboards, n8n

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/events` | GET | Recent events (filterable by `?type=`) |
| `/api/v1/events` | POST | Log an event `{ message, type, meta }` |
| `/api/v1/events/stream` | GET | SSE stream (filterable by `?type=`) |

### System Resources
Host health monitoring.
**Consumer:** Core (host monitoring)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/system/resources` | GET | CPU, memory, load, uptime |

### Database Browser
**Status:** Planned (Phase 4) — inspect any MongoDB collection via API.

---

## Collection Ownership

| Collection | Purpose |
|-----------|---------|
| `nas_files` | Indexed file metadata (path, size, hash, extension) |
| `nas_scans` | Scan history and progress tracking |
| `nas_directories` | Directory-level aggregations |
| `nas_pending_deletions` | Soft-delete queue for janitor workflow |
| `network_devices` | Discovered LAN devices (MAC, IP, vendor, ports) |
| `appevents` | Application event log |
| `livedataconfigs` | Live data service toggle states |
| `isses` | ISS position history |
| `quakes` | Daily earthquake data |
| `pressures` | Weather pressure readings |
| `weatherLocations` | Registered weather tracking locations |

## Directory Structure

```
data/
├── server.js
├── package.json
├── .env.example
├── CLAUDE.md
├── routes/
│   ├── storage.routes.js       # Scanner + file browser + janitor
│   ├── network.routes.js       # Network discovery
│   ├── livedata.routes.js      # Live data ingestion
│   ├── events.routes.js        # Event feed + SSE
│   └── system.routes.js        # System resources
├── controllers/
│   ├── storageController.js    # Scan lifecycle
│   ├── fileBrowserController.js # File search, stats, dedup, janitor
│   ├── networkController.js    # Device CRUD + scan + enrich
│   ├── liveDataController.js   # Config + data access
│   ├── eventController.js      # Event CRUD + SSE stream
│   └── systemController.js     # CPU/memory/load
├── services/
│   ├── scanner.js              # File scanner (EventEmitter, SHA256)
│   ├── networkScanner.js       # nmap wrapper
│   ├── liveData.js             # Background fetcher orchestrator
│   └── mqttClient.js           # MQTT pub/sub (optional)
├── middleware/
│   └── errorHandler.js
└── utils/
    ├── errors.js
    ├── eventEmitter.js         # Shared pub/sub bus
    ├── fetch-utils.js          # HTTP fetch with timeout + retry
    ├── file-operations.js
    └── logger.js
```
