# AgentX Data — Toolkit Service

> Extracted from [DataAPI](https://github.com/WindriderQc/DataAPI). Each feature area is a self-contained **toolkit** with clear API endpoints that other AgentX services can consume.

See parent `../CLAUDE.md` for shared infrastructure (MongoDB, Ollama hosts, conventions).

## Service Info

- **Port:** 3083
- **Entry:** `server.js`
- **Database:** shared `agentx` (collection-level ownership)

## Toolkits

### Storage Scanner
**Status:** Active
**Consumer:** RAG (document discovery), Core (admin)

Indexes files across NAS/disk with SHA256 hashing for deduplication.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/scans` | GET | List recent scans |
| `/api/v1/storage/scan` | POST | Start a new scan |
| `/api/v1/storage/status/:scan_id` | GET | Get scan progress |
| `/api/v1/storage/stop/:scan_id` | POST | Stop a running scan |
| `/api/v1/storage/summary` | GET | Storage overview (totals, dupes, last scan) |
| `/api/v1/storage/directory-count` | GET | Count indexed directories |
| `/api/v1/storage/scan/:scan_id/batch` | POST | Insert file batch (n8n workflow) |
| `/api/v1/storage/scan/:scan_id` | PATCH | Update scan status |

### File Browser
**Status:** Active
**Consumer:** RAG, Core

Browse, search, and analyze indexed files.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/files/browse` | GET | Browse files with filtering and pagination |
| `/api/v1/storage/files/stats` | GET | File statistics (by extension, size distribution) |
| `/api/v1/storage/files/tree` | GET | Directory tree structure |
| `/api/v1/storage/files/duplicates` | GET | Find duplicate files (hash or fuzzy) |
| `/api/v1/storage/files/cleanup-recommendations` | GET | Cleanup suggestions (large, old, duplicate) |
| `/api/v1/storage/files/:id` | PATCH | Update file metadata |

### Datalake Janitor
**Status:** Active
**Consumer:** Admin tooling

Deduplication workflow: suggest, mark, confirm deletions.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/storage/janitor/suggest-deletions` | POST | Suggest files for deletion |
| `/api/v1/storage/janitor/mark-for-deletion` | POST | Mark files as pending deletion |
| `/api/v1/storage/janitor/pending-deletions` | GET | List pending deletions |
| `/api/v1/storage/janitor/confirm-deletion/:id` | DELETE | Execute deletion (destructive) |

### System Resources
**Status:** Active
**Consumer:** Core (host monitoring)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/system/resources` | GET | CPU, memory, load, uptime |

### Network Discovery
**Status:** Planned (Phase 2)
**Consumer:** Core cluster ops (auto-discover Ollama hosts)

### Live Data Ingestion
**Status:** Planned (Phase 3)
**Consumer:** Any service needing autonomous background data collection

### Event Sink
**Status:** Planned (Phase 3)
**Consumer:** Benchmark (completion triggers), Core (alert workflows)

### Database Browser
**Status:** Planned (Phase 4)
**Consumer:** Admin/debug utility

## Collection Ownership

| Collection | Purpose |
|-----------|---------|
| `nas_files` | Indexed file metadata (path, size, hash, extension) |
| `nas_scans` | Scan history and progress tracking |
| `nas_directories` | Directory-level aggregations |
| `nas_pending_deletions` | Soft-delete queue for janitor workflow |

## Directory Structure

```
data/
├── server.js                  # Express app entry point
├── package.json
├── .env.example
├── CLAUDE.md                  # This file
├── routes/
│   ├── storage.routes.js      # Scanner + file browser + janitor
│   └── system.routes.js       # System resources
├── controllers/
│   ├── storageController.js   # Scan lifecycle management
│   ├── fileBrowserController.js # File search, stats, dedup, janitor
│   └── systemController.js    # CPU/memory/load
├── services/
│   └── scanner.js             # Scanner class (EventEmitter, SHA256)
├── middleware/
│   └── errorHandler.js
└── utils/
    ├── errors.js              # GeneralError hierarchy
    ├── file-operations.js     # formatFileSize, validateFilename, etc.
    └── logger.js              # Winston logger
```
