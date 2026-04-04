# agentx-data Peer Review Report

**Date:** 2026-04-02
**Scope:** Full codebase review (3,073 lines across 30 files)
**Reviewers:** 6 parallel review agents covering all toolkits + architecture

---

## Executive Summary

The agentx-data service is a well-structured Node/Express microservice with clean toolkit boundaries, reasonable file sizes, and thoughtful safety defaults (dry-run, confirmation tokens, path blocklists). The dedup pipeline in particular shows careful design. However, the review uncovered **10 critical issues** (mostly injection vectors and secrets exposure), **25 important issues**, and numerous minor/nitpick items. The most urgent cluster involves NoSQL injection through the database browser and generic CRUD factory, leaked confirmation tokens that defeat the safety workflow, and symlink-based traversal that bypasses all path protections.

### Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 10 |
| Important | 25 |
| Minor | 20 |
| Nitpick | 12 |

---

## Critical Issues

### C1. NoSQL Injection via Database Browser `?q=` Filter
**File:** `controllers/databasesController.js:53-57`

The `?q=` parameter is parsed as arbitrary JSON and passed directly to `collection.find(filter)`. An attacker can supply:
- `?q={"$where":"sleep(10000)"}` -- server-side JS execution (DoS or RCE)
- `?q={"$expr":{"$function":{"body":"...","args":[],"lang":"js"}}}` -- arbitrary JS on MongoDB 4.4+
- `?q={"password":{"$regex":"^a"}}` -- blind data extraction via timing

Since this endpoint operates on **any** collection via `:name`, it can probe or exfiltrate data from all services' collections (conversations, benchmark results, etc.).

**Fix:** Implement a filter sanitizer with an operator allowlist (`$eq`, `$gt`, `$lt`, `$in`, `$regex` with length limits). Block `$where`, `$function`, `$accumulator`, `$expr`.

---

### C2. NoSQL Injection via Generic CRUD Factory Query Parameters
**File:** `utils/genericCrud.js:16-17`

The `getAll` handler copies all query parameters directly into a MongoDB `find()` filter:
```js
const query = { ...req.query };
delete query.skip; delete query.limit; delete query.sort;
```
An attacker can inject MongoDB operators via query strings: `?field[$gt]=&field[$regex]=.*`

**Fix:** Strip keys starting with `$`, or require an explicit allowlist of filterable fields per factory instance.

---

### C3. Confirmation Token Leaked in Error Response
**Files:** `routes/janitor.routes.js:217`, `services/dedupScanner.js:167`

When the confirmation token is wrong, the response body includes the **correct** `expected_token`. This completely defeats the safety mechanism -- an attacker sends any token, reads the correct one from the 403 response, then replays with the valid token to delete files.

**Fix:** Remove `expected_token` from both the service return value and HTTP response. The token should only be available through the dedup report itself.

---

### C4. Symlink Following Enables Traversal and Infinite Loops in Scanner
**File:** `services/scanner.js:80-90`

The scanner uses `fs.readdir` with `withFileTypes` and `ent.isDirectory()`/`ent.isFile()`, both of which resolve symlinks transparently. A symlink pointing to `/` or a parent directory causes the scanner to escape its root or loop indefinitely. No cycle detection (visited set) or `lstat` check exists.

**Fix:** Use `fs.lstat` instead of `fs.stat`, add a `visitedDirs` Set keyed on device+inode, and optionally skip symlinks entirely.

---

### C5. Path Traversal via Blocklist Gaps in Janitor
**File:** `routes/janitor.routes.js:20-26`

The blocklist is incomplete (`/opt`, `/srv`, `/root`, `/boot`, `/dev`, `/run`, `/mnt` are unblocked) and uses a fundamentally weak deny-approach. More critically, the dedup-approve pipeline (`dedupScanner.js:180`) **bypasses the blocklist entirely** -- it only checks for `/keys/` patterns.

**Fix:** Switch to an allowlist approach. Define allowed root paths (e.g., `/mnt/datalake/`) and reject everything else. Apply consistently across both janitor and dedup pipelines.

---

### C6. No Path Validation on Dedup-Scan `root_path`
**File:** `routes/janitor.routes.js:162-163`

The `root_path` from the request body is passed directly to `buildDedupReport` with no blocklist or allowlist validation. A user can trigger scans of the entire filesystem index by passing `root_path: "/"`.

**Fix:** Apply the same path allowlist to `root_path` before passing it to the scanner.

---

### C7. `updateScan` Accepts Arbitrary Status and Stats Fields
**File:** `controllers/storageController.js:213-248`

The endpoint accepts any `status` string and spreads `stats` keys directly into MongoDB update fields. A crafted `stats` key containing a dot (e.g., `"a.b"`) writes to nested MongoDB fields outside `counts`, enabling arbitrary field injection.

**Fix:** Allowlist `status` to `['running', 'complete', 'stopped', 'error']`. Validate `stats` keys match `/^[a-z_]+$/`.

---

### C8. `updateFile` Allows Arbitrary Field Injection
**File:** `controllers/fileBrowserController.js:327-349`

The endpoint deletes `_id`, `path`, and `created_at` from the request body, then spreads the remainder into `$set`. An attacker can inject `sha256`, `scan_id`, `size`, `dirname` -- falsifying dedup results and potentially causing the janitor to delete wrong files.

**Fix:** Allowlist updatable fields (e.g., `tags`, `notes`, `category`, `metadata`).

---

### C9. Secrets Committed in `.env` File
**File:** `.env`

The `.env` file contains live production credentials: MongoDB Atlas URI, OpenAI API key (`sk-proj-...`), MQTT credentials, weather API keys, session secrets, and more. While `.gitignore` lists `.env`, the file exists in the working tree with sensitive data.

**Fix:** Rotate all exposed secrets immediately. Verify `.env` has never been committed to git history. Remove unused legacy keys.

---

### C10. Database Name Mismatch Between `.env` and Documentation
**File:** `.env:9`

`.env` sets `MONGODB_URI=mongodb://192.168.2.33:27017/datas` but CLAUDE.md and `.env.example` document the database as `agentx`. This means the service may be using the wrong database, with collection ownership across services potentially broken.

**Fix:** Align `.env` to use `agentx` or update documentation if `datas` is intentional.

---

## Important Issues

### Security

#### I1. No IP Validation in `enrichDevice`
**File:** `services/networkScanner.js:68`, `controllers/networkController.js:105`

`enrichDevice` takes `device.ip` from MongoDB and passes it to `spawn('nmap', [..., ip])` with no validation. A corrupted database record with a value like `--script=exploit` could be interpreted as nmap flags.

**Fix:** Validate with `net.isIP(ip)` before passing to spawn.

#### I2. No Timeout on nmap Child Processes
**File:** `services/networkScanner.js:43-66, 68-102`

Both `scanNetwork` and `enrichDevice` spawn nmap with no timeout. A scan of an unresponsive target hangs indefinitely, permanently setting `isScanning = true`.

**Fix:** Use `spawn`'s `timeout` option or implement a manual kill timer (e.g., 120s).

#### I3. Weather API Key Exposed in Logs
**File:** `services/liveData.js:93`

The URL with `appid=` query parameter can appear in error messages logged by `fetch-utils.js:23`.

**Fix:** Mask the API key in error output or strip sensitive query params before logging.

#### I4. Database Browser Has No Collection Access Control
**File:** `controllers/databasesController.js:43, 59`

The `:name` parameter accesses any collection with no restriction -- including `conversations`, `benchmarkresults`, `system.profile`, and other services' data.

**Fix:** Add a denylist for `system.*` collections. Consider a read-only allowlist of data-service-owned collections.

#### I5. Webhook Source Parameter Unsanitized
**File:** `routes/integrations.routes.js:52`

`req.params.source` is stored directly -- no length limit, no format validation.

**Fix:** Validate against `/^[a-zA-Z0-9_-]{1,64}$/`.

#### I6. No Rate Limiting on Destructive/Expensive Endpoints
No rate limiting exists anywhere. Particularly concerning for: `POST /janitor/execute`, `POST /janitor/dedup-scan`, `POST /janitor/analyze`, `POST /network/scan`, `POST /storage/scan`.

**Fix:** Add `express-rate-limit` on destructive and compute-heavy endpoints.

#### I7. Symlink Following Bypasses Blocklist in Janitor
**File:** `routes/janitor.routes.js:22-26, :39`

`path.resolve()` resolves `..` but not symlinks. A symlink at `/mnt/datalake/link -> /etc` passes the blocklist but `fs.unlink` follows into `/etc`.

**Fix:** Use `fs.realpath()` and re-validate the resolved path.

#### I8. `/execute` Endpoint Lacks Confirmation Mechanism
**File:** `routes/janitor.routes.js:125-143`

Unlike dedup-approve (which requires a token), the simpler `/execute` endpoint permanently deletes files with no confirmation token, no rate limiting, and no audit trail.

**Fix:** Add a confirmation mechanism or at minimum log all non-dry-run deletions to an audit collection.

#### I9. `markForDeletion` Accepts Arbitrary Paths
**File:** `controllers/fileBrowserController.js:275-292`

The `files` array from the request body is inserted with `f.path` stored as-is. No check that the path corresponds to an actual `nas_files` record. Combined with `confirmDeletion` having no blocklist, this creates a path from user input to arbitrary file deletion.

**Fix:** Look up each `f.fileId` in `nas_files` and use the database path instead of trusting client input.

#### I10. `confirmDeletion` Has No Path Validation (TOCTOU)
**File:** `controllers/fileBrowserController.js:302-325`

Reads `record.path` from the DB and calls `fs.unlink` with no blocklist check, unlike the janitor routes.

**Fix:** Apply path blocklist/allowlist before calling `unlink`.

### Architecture & Quality

#### I11. No MongoDB Indexes -- All Queries Are Full Collection Scans

No `createIndex` calls exist anywhere. Key missing indexes:

| Collection | Field(s) | Reason |
|-----------|----------|--------|
| `nas_files` | `path` (unique) | Upsert key in scanner |
| `nas_files` | `sha256` | Dedup aggregation |
| `nas_files` | `ext, size, dirname` | Browse filters |
| `network_devices` | `mac` (unique) | Upsert key |
| `appevents` | `timestamp` | Sort |
| `dedup_reports` | `created_at` | Sort |

**Fix:** Add an index initialization function called during `start()`.

#### I12. Inconsistent Error Handling Patterns
- `storageController.js`: catches inline with `res.status(500).json()`
- `networkController.js`: mixed -- some inline, some `next(error)`
- `systemController.js`: inline
- `janitor.routes.js`: inline
- All other controllers: properly use `next(error)`

Inline catches bypass the centralized error handler, producing inconsistent response formats and missing stack trace logging.

**Fix:** Standardize on `next(error)` everywhere.

#### I13. Janitor Routes Contain Business Logic (231 Lines)
**File:** `routes/janitor.routes.js`

The only route file with significant inline business logic (`analyzeDirectory`, `validatePath`, `POLICIES`, `BLOCKLIST`). All other toolkits follow routes -> controllers -> services.

**Fix:** Extract to `services/janitorService.js` + `controllers/janitorController.js`.

#### I14. Mixed Logging (`console.*` vs `logger.log()`)
`storageController.js` (8 occurrences), `mqttClient.js` (5), `networkScanner.js` (2), `fetch-utils.js` (1), `systemController.js` (1) all bypass the Winston logger.

**Fix:** Replace all `console.*` in non-test code with `log()`.

#### I15. Full Export Loads Entire Collection Into Memory
**File:** `controllers/exportController.js:21-28`

The `full` export type accumulates all `nas_files` documents into an array before serializing. For a large NAS index, this exhausts memory.

**Fix:** Stream directly to file instead of accumulating.

#### I16. `/execute` Lacks Per-File Error Handling
**File:** `routes/janitor.routes.js:137-139`

If `fs.unlink` throws, the error propagates for the entire batch. Files already deleted are unreported. The file is also added to `results.deleted` before unlink confirms.

**Fix:** Wrap each unlink in try/catch, only push to `results.deleted` after success.

#### I17. Pagination Not Clamped on Several Endpoints
- `controllers/storageController.js:109-114` -- `listScans` has no upper bound
- `controllers/fileBrowserController.js:14,31` -- `browseFiles` not clamped
- `controllers/eventController.js:24` -- `getEvents` no upper bound
- `routes/integrations.routes.js:31` -- n8n GET no upper bound

**Fix:** Apply `Math.min(500, ...)` consistently, matching the pattern in `databasesController.js`.

#### I18. `sortBy` Allows Arbitrary MongoDB Field Names
**File:** `controllers/fileBrowserController.js:12,32`

`sortBy` from query params is used directly as a MongoDB sort field with no validation.

**Fix:** Allowlist sortable fields: `['mtime', 'size', 'filename', 'ext', 'path']`.

#### I19. Scanner `roots` Not Validated
**File:** `controllers/storageController.js:29-61`

A client sending `roots: ["/"]` will traverse the entire filesystem. The janitor has a blocklist but the scanner does not.

**Fix:** Apply path validation blocklist/allowlist.

#### I20. ISS Log Capping Is O(n) Per Tick
**File:** `services/liveData.js:58-62`

`countDocuments()` + `findOne` + `deleteOne` + `insertOne` = 4 DB operations every 10 seconds.

**Fix:** Use a capped collection or TTL index.

#### I21. Quakes Refresh Is Non-Atomic
**File:** `services/liveData.js:78-83`

`deleteMany({})` followed by `insertMany` -- readers see empty results during the gap. If `insertMany` fails, all data is lost until the next daily refresh.

**Fix:** Use a swap pattern (write to temp collection, then rename) or upserts.

#### I22. No MongoDB Reconnection Handling
**File:** `server.js:49`

No event listeners for connection drops. The `/health` endpoint doesn't check connection state.

**Fix:** Add `client.on('close'/'error')` handlers. Check connectivity in health endpoint.

#### I23. Graceful Shutdown Doesn't Drain SSE Connections
**File:** `server.js:81-86`

`server.close()` waits for existing connections, but SSE connections are long-lived and will block shutdown indefinitely. No shutdown timeout exists.

**Fix:** Add a 5-second shutdown timeout and forcefully destroy remaining connections.

#### I24. SSE Has No Connection Limit / MaxListeners
**File:** `utils/eventEmitter.js`, `controllers/eventController.js:67`

No `maxListeners` configured (default 10 produces warnings). No cap on concurrent SSE connections -- a slowloris attack can open thousands.

**Fix:** Set `maxListeners(200)`, add a connection counter that rejects with 503 at threshold.

#### I25. Unhandled Promise Rejection in Shutdown Handlers
**File:** `server.js:88-89`

If `shutdown()` throws, the async callback produces an unhandled rejection that crashes the process unhelpfully.

**Fix:** Wrap in try/catch.

---

## Minor Issues

| # | File | Issue |
|---|------|-------|
| M1 | `services/dedupScanner.js:139` | Inline `require('mongodb')` inside function body |
| M2 | `controllers/storageController.js:284` | Inline `require('../utils/file-operations')` |
| M3 | `controllers/fileBrowserController.js:305` | Inline `require('mongodb')` + `require('fs/promises')` |
| M4 | `controllers/networkController.js:74,98` | Inline `require('mongodb')` + duplicated ObjectId filter logic |
| M5 | `controllers/databasesController.js:77` | Inline `require('mongodb')` |
| M6 | `services/dedupScanner.js:139-140` | Missing ObjectId validation -- invalid ID throws BSON error as 500 |
| M7 | `controllers/exportController.js:90-101` | CSV conversion doesn't handle newlines or unquoted double-quotes |
| M8 | `controllers/storageController.js:166-167` | Scanner stores `ext`, batch stores both `ext` and `extension` |
| M9 | `controllers/fileBrowserController.js:43` | `mtime` format assumes Unix seconds; batch insert uses Date objects |
| M10 | `services/liveData.js:164-167` | MQTT init only called when ISS enabled, but weather also uses MQTT |
| M11 | `services/networkScanner.js:3` | Shared `xml2js.Parser` singleton may not be reentrant |
| M12 | `services/networkScanner.js:76` | `enrichDevice` silently swallows nmap errors |
| M13 | `controllers/eventController.js:41` | `createEvent` allows arbitrary `type` values |
| M14 | `controllers/eventController.js:14-16` | `logEvent` silently swallows DB failures |
| M15 | `routes/integrations.routes.js` | Inconsistent response envelope (`ok: true` vs `status: success`) |
| M16 | `controllers/networkController.js:12` | Response uses `results` + `data`, unlike other endpoints |
| M17 | `.gitignore` | Missing `exports/` directory |
| M18 | `package.json` | Missing `engines` field (needs Node >= 18) |
| M19 | `controllers/liveDataController.js:3-5` | `getState` has no try/catch (async handler) |
| M20 | `controllers/liveDataController.js:19` | `updateConfig` doesn't validate `enabled` is boolean |

---

## Nitpick Issues

| # | File | Issue |
|---|------|-------|
| N1 | `routes/janitor.routes.js:58-59` | Silent catch blocks suppress diagnostics |
| N2 | `routes/janitor.routes.js:31,45` | Magic numbers (MAX_FILES=2000, 100MB hash threshold) |
| N3 | `controllers/exportController.js:111` | Hand-rolled timestamp formatting |
| N4 | `utils/file-operations.js:31` | `existsSync` used in otherwise async codebase |
| N5 | `services/liveData.js:135` | `hasOwnProperty` called directly on object |
| N6 | `services/mqttClient.js:41` | `client.end(true)` -- force-close drops in-flight messages |
| N7 | `services/mqttClient.js` | No `offline`/`close` event handlers |
| N8 | `routes/integrations.routes.js:6-12` | `normalizeData` has no depth limit |
| N9 | `controllers/storageController.js:139,205` | Dead `meta` parameter in `insertBatch` |
| N10 | `controllers/storageController.js:33` | Scan IDs are strings, not ObjectIds (inconsistent) |
| N11 | `utils/logger.js:20` | Parameter `level` shadows module-scoped `level` |
| N12 | `CLAUDE.md` | Directory structure tree doesn't list `dedupScanner.js` or `tests/` |

---

## Test Coverage

Only `services/dedupScanner.js` and `routes/janitor.routes.js` (dedup endpoints) have tests. **No other toolkit has any test coverage.** Priority areas:

1. **`utils/genericCrud.js`** -- security-sensitive (C2)
2. **`controllers/databasesController.js`** -- security-sensitive (C1)
3. **`middleware/errorHandler.js`** -- affects all error responses
4. **`controllers/fileBrowserController.js`** -- deletion workflows (I9, I10)
5. **`controllers/storageController.js`** -- scan lifecycle
6. **`services/networkScanner.js`** -- nmap parsing, error handling
7. **`controllers/exportController.js`** -- report generation, CSV conversion

---

## What Was Done Well

- **Dry-run defaults** throughout (`dry_run !== false`) -- excellent defensive design
- **Streaming SHA256 hashing** in `scanner.js` -- no memory explosion on large files
- **Regex escaping** via `escRe()` in file browser before MongoDB `$regex` operators
- **Scan lifecycle management** with `cleanupStaleScans`, `runningScans` Map, and EventEmitter
- **Batch upserts with `ordered: false`** -- correct for high-throughput ingestion
- **`spawn` over `exec`** for nmap -- prevents shell injection via argument arrays
- **SSE implementation** with heartbeats, `X-Accel-Buffering: no`, proper listener cleanup
- **Optional MQTT dependency** with graceful `try { require('mqtt') } catch` pattern
- **Graceful shutdown** with proper SIGINT/SIGTERM handlers
- **Confirmation token concept** in dedup pipeline (design is sound, just needs the leak fixed)
- **File size discipline respected** across the board (largest: 365 lines vs 700 max)
- **`fetch-utils.js`** with timeout + retry + exponential backoff + abort controller
- **Protected path guards** exist (just need to be unified and strengthened)

---

## Recommended Fix Priority

### Immediate (security)
1. **C9** -- Rotate all secrets in `.env`
2. **C1 + C2** -- Sanitize MongoDB query filters (database browser + generic CRUD)
3. **C3** -- Remove `expected_token` from error responses
4. **C5 + C6** -- Switch janitor/dedup to path allowlist

### Short-term (stability + correctness)
5. **C4** -- Add symlink detection + cycle prevention in scanner
6. **C7 + C8** -- Allowlist fields in `updateScan` and `updateFile`
7. **I11** -- Create MongoDB indexes
8. **I1 + I2** -- Validate nmap inputs, add timeouts
9. **I9 + I10** -- Fix deletion path validation in file browser
10. **I12** -- Standardize error handling on `next(error)`

### Medium-term (architecture + quality)
11. **I13** -- Extract janitor business logic to service/controller
12. **I17** -- Clamp pagination across all endpoints
13. **I15** -- Stream large exports instead of buffering
14. **I20 + I21** -- Fix ISS capping and quakes refresh patterns
15. **I24** -- Add SSE connection limits
16. Expand test coverage to all toolkits

---

*Generated by 6 parallel review agents, consolidated 2026-04-02.*
