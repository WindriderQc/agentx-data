# Janitor Dashboard — Design Spec

> **AI-powered disk janitor command center** — storage analysis, deduplication, cleanup suggestions, file triage, and a conversational AI assistant.

## Overview

A standalone page (`janitor.html`) in the agentx-core frontend, following the same vanilla JS + HTML pattern as the existing storage, network, and database pages. The dashboard is a vertically scrolling "command center" with a collapsible AI chat panel on the right side.

**Key principle:** The AI layer is purely advisory. It consumes data from existing janitor/storage endpoints, reasons about it via qwen2.5:7b on UGFrank (`192.168.2.99:11434`), and presents recommendations. The user always approves before anything destructive happens.

---

## Architecture

### Frontend

- **File:** `core/public/janitor.html` — page shell, CSS (prefixed `jn-`), nav injection
- **File:** `core/public/js/janitor.js` — all page logic (polling, rendering, AI chat, interactions)
- **Nav entry:** Added to `nav.js` under "More > Data" section as "Janitor" with `fa-broom` icon
- **Design system:** Dark theme matching existing pages (Space Grotesk, `--panel-bg`, `--accent`, glassmorphism panels). Uses `jn-` CSS prefix to avoid collisions.

### Backend (agentx-data, port 3083)

All data comes from existing endpoints already built in the janitor overhaul:

| What | Endpoint | Purpose |
|------|----------|---------|
| Storage summary | `GET /api/v1/storage/summary` | Total files, total size, duplicates, last scan |
| Storage breakdown | `GET /api/v1/storage/files/stats` | Per-extension and per-directory stats |
| Directory tree | `GET /api/v1/storage/files/tree` | Top-level directory sizes for storage breakdown |
| Duplicate groups | `GET /api/v1/storage/files/duplicates` | Hash-based duplicate groups from nas_files |
| Dedup report | `GET /api/v1/janitor/dedup-report` | Latest NAS-wide dedup analysis |
| Run dedup scan | `POST /api/v1/janitor/dedup-scan` | Trigger new dedup analysis |
| Analyze directory | `POST /api/v1/janitor/analyze` | Live directory hash analysis |
| Cleanup suggestions | `POST /api/v1/janitor/suggest` | Policy-based suggestions |
| Execute cleanup | `POST /api/v1/janitor/execute` | Apply cleanup (requires confirmation_token) |
| Approve dedup | `POST /api/v1/janitor/dedup-approve` | Apply dedup deletions (requires confirmation_token) |
| Policies | `GET /api/v1/janitor/policies` | List cleanup policies |

**New endpoint needed:**

| What | Endpoint | Purpose |
|------|----------|---------|
| AI inference | `POST /api/v1/janitor/ai` | Proxy prompt to Ollama on UGFrank, return structured response |

### AI Backend

A single new route handler in agentx-data that:
1. Accepts `{ action, context }` where action is one of: `triage`, `resolve_duplicates`, `analyze_path`, `chat`
2. Builds a system prompt specific to the action (e.g., file triage expects JSON classification output)
3. Calls UGFrank Ollama at `http://192.168.2.99:11434/api/generate` with model `qwen2.5:7b`
4. Parses the response and returns structured JSON to the frontend

The AI route is a thin wrapper — no persistent state, no conversation memory beyond what the frontend sends in context.

---

## Page Sections (Top to Bottom)

### 1. Header

- Title: "Disk Janitor" with broom icon
- Subtitle: "AI-powered storage analysis, deduplication & cleanup"
- Right side: "Last scan: Xh ago" badge, "Analyze Directory" button (opens path input modal), "Run Dedup Scan" button
- Loaded from: storage summary endpoint (last scan timestamp)

### 2. Health Metrics (5 clickable cards)

Cards are interactive — clicking opens a detail popover or scrolls to the relevant section.

| Card | Value | Subtext | Click Action |
|------|-------|---------|--------------|
| Total Files | count from summary | trend indicator (+N since last scan) | Scroll to storage breakdown |
| Total Size | formatted size | capacity bar (% of disk used) | Scroll to storage breakdown |
| Duplicate Groups | count | "X redundant files across Y groups" | Scroll to duplicate groups |
| Reclaimable | total reclaimable space | breakdown: "Dupes: X · Temp: Y · Large: Z" | Scroll to cleanup suggestions |
| Policies Active | count / total | policy names listed | Open policies config popover |

**Data sources:** Storage summary for totals. Dedup report summary for duplicate counts. Cleanup suggestions for reclaimable breakdown. Policies endpoint for active count.

### 3. Storage Breakdown

Shows where storage is consumed, broken down by top-level directories under the scanned root.

**Visual:** Color-coded horizontal stacked bar showing proportional size per directory, followed by a sortable table.

**Table columns:** Color dot, Path, Files count, Size, Duplicate count, Usage bar (proportional)

**Interaction:** Click a row to drill down (re-fetches stats for that subdirectory). Breadcrumb trail shows current drill-down path.

**Data source:** `GET /api/v1/storage/files/tree` for directory-level aggregations, falling back to `GET /api/v1/storage/files/stats` if tree data isn't available.

### 4. Duplicate Groups

Paginated table of duplicate hash groups, sorted by wasted space descending.

**Collapsed row:** Sample filename, parent path, copy count, file size, wasted space, action buttons (AI Resolve, Keep 1)

**Expanded row (click to toggle):** Shows all copies with full paths, timestamps, and which is marked KEEP (oldest by default). Each copy has a checkbox. Inline AI recommendation box (purple accent) explains why it suggests keeping a specific copy.

**Batch actions:** "AI Resolve All" sends top N groups to AI for bulk recommendations. "Export CSV" downloads the duplicate report.

**Data source:** Dedup report groups, paginated client-side (load 20 at a time, "Load more" button).

### 5. Cleanup Suggestions

List of actionable cleanup items from the policy engine.

**Each row:** Checkbox, action badge (DELETE red / REVIEW amber), file path or glob pattern, reclaimable space, file count, originating policy name.

**Batch actions:** "Preview (Dry Run)" executes with `dry_run: true` and shows results in a confirmation modal. "Apply Selected" generates a confirmation token for checked items and executes.

**Confirmation flow:**
1. User checks items and clicks "Apply Selected"
2. Frontend already has the `confirmation_token` from the initial `/suggest` response that populated this section
3. Modal shows summary: N files, X space, with a "Confirm Delete" button
4. On confirm, calls `POST /execute` with `{ files: [checked paths], confirmation_token, dry_run: false }`
5. Results shown: deleted count, freed space, any failures

**Data source:** `POST /api/v1/janitor/suggest` with the current scan path.

### 6. AI Triage

AI-generated file classifications displayed as 3 side-by-side cards.

| Card | Color | Content |
|------|-------|---------|
| KEEP | Green border | Files that should be retained, with reason (active project, recently modified, etc.) |
| ARCHIVE | Amber border | Files that are stale but potentially valuable, with recommendation (cold storage, compress) |
| JUNK | Red border | Files safe to delete, with reason (temp, cache, orphaned) |

Each card shows: category label, file count, total size, AI explanation text.

**Interaction:** "Run Triage" button sends the current directory context to `POST /api/v1/janitor/ai` with `action: 'triage'`. The AI receives the file tree/stats and returns structured classifications. Cards link to a filtered file list view (future enhancement).

**Data source:** AI endpoint. Context assembled from storage stats and file tree data.

### 7. AI Chat Panel (Right Side)

Persistent collapsible panel (~300px wide) for conversational interaction with the janitor AI.

**Header:** "Janitor AI" label, model badge (qwen2.5:7b), collapse toggle button.

**Message area:** Scrolling chat with AI messages (purple-tinted bubbles) and user messages (neutral bubbles). AI can reference dashboard sections and include inline data (file counts, paths, sizes).

**Input:** Text input with send button. Supports natural language queries like:
- "Show me all video files that look like duplicates but have different names"
- "What's eating the most space in /backups/?"
- "Delete all screen recordings older than 6 months"
- "Why is /photos/ so large?"

**How it works:** Frontend sends `{ action: 'chat', context: { message, storageStats, recentTriage } }` to the AI endpoint. The AI gets the user's question plus relevant dashboard context so it can give informed answers. Responses can include action suggestions that the user can click to execute (e.g., "Run cleanup on /tmp/" becomes a clickable action chip).

**Collapsed state:** Panel shrinks to a thin bar with the AI icon. Click to expand. Chat state is preserved.

---

## AI Endpoint Design

### Route: `POST /api/v1/janitor/ai`

**Request:**
```json
{
  "action": "triage | resolve_duplicates | analyze_path | chat",
  "context": {
    "message": "user's chat message (for chat action)",
    "files": [...],
    "stats": {...},
    "duplicates": [...],
    "path": "/mnt/datalake/some/path"
  }
}
```

**System prompts per action:**

- **triage:** "You are a storage analyst. Given file metadata (paths, sizes, ages, extensions), classify files into KEEP, ARCHIVE, or JUNK. Respond with JSON: `{ categories: [{ label, reason, files_count, total_size, paths: [...] }] }`"
- **resolve_duplicates:** "You are a deduplication advisor. Given a set of duplicate file paths with timestamps, recommend which copy to keep and why. Respond with JSON: `{ keep: path, delete: [paths], reason: string }`"
- **analyze_path:** "You are a storage analyst. Given directory stats, identify anomalies, waste, and recommendations. Respond with JSON: `{ findings: [{ type, severity, description, recommendation }] }`"
- **chat:** "You are a disk janitor AI assistant. You have access to storage stats and file metadata. Answer questions about the filesystem, suggest cleanups, and help the user understand their storage. Be concise and actionable."

**Response:**
```json
{
  "status": "success",
  "data": {
    "action": "triage",
    "result": { ... },
    "model": "qwen2.5:7b",
    "duration_ms": 1234
  }
}
```

**Error handling:** If Ollama is unreachable, return `503` with a clear message. The frontend shows an inline error in the chat panel ("AI unavailable — UGFrank may be offline") and gracefully degrades — all non-AI features continue working.

---

## File Structure

### New files

```
core/public/
├── janitor.html              # Page shell + CSS
└── js/
    └── janitor.js            # Page logic (polling, render, AI chat)

data/
├── routes/
│   └── janitor.routes.js     # (update) Add POST /ai route
├── controllers/
│   └── janitorController.js  # (update) Add aiChat handler
└── services/
    └── janitorAI.js          # (new) Ollama integration, prompt templates
```

### Modified files

- `core/public/js/components/nav.js` — Add "Janitor" nav entry under "More > Data"
- `data/routes/janitor.routes.js` — Add `router.post('/ai', janitorController.aiChat)`
- `data/controllers/janitorController.js` — Add `aiChat` handler
- `core/routes/data-proxy.js` — Already proxies `/api/data/*` to port 3083, no changes needed

---

## Data Flow

```
User opens janitor.html
  → JS loads, calls multiple endpoints in parallel:
    GET /api/data/storage/summary        → health metrics
    GET /api/data/storage/files/tree     → storage breakdown
    GET /api/data/janitor/dedup-report   → duplicate groups
    GET /api/data/janitor/policies       → active policies

User clicks "Run Dedup Scan"
  → POST /api/data/janitor/dedup-scan
  → Poll GET /api/data/janitor/dedup-report until complete
  → Refresh duplicate groups + health metrics

User clicks "AI Resolve" on a duplicate group
  → POST /api/data/janitor/ai { action: "resolve_duplicates", context: { duplicates: [...] } }
  → AI returns recommendation
  → Inline display in expanded row

User clicks "Apply Selected" on cleanup suggestions
  → POST /api/data/janitor/suggest (get confirmation_token)
  → Show confirmation modal
  → POST /api/data/janitor/execute { files, confirmation_token, dry_run: false }
  → Show results, refresh metrics

User types in AI chat
  → POST /api/data/janitor/ai { action: "chat", context: { message, stats } }
  → AI responds
  → Display in chat panel
```

---

## Polling & Performance

- **On load:** Parallel fetch of summary, tree, dedup report, policies (4 requests)
- **Periodic refresh:** Summary + dedup report every 30s (only when tab is visible, using existing PollingController pattern)
- **Lazy sections:** Duplicate groups load first 20 rows, "Load more" fetches next batch
- **AI calls:** On-demand only (user clicks). No background AI polling.
- **Chat context:** Frontend sends only the relevant slice of data for the current question, not the entire dashboard state.

---

## Graceful Degradation

The dashboard works fully without AI. If UGFrank is offline:
- Health metrics, storage breakdown, duplicate groups, cleanup suggestions all work normally
- AI Triage section shows "AI unavailable" placeholder
- AI chat panel shows connection error with retry button
- "AI Resolve" buttons are disabled with tooltip "AI offline"

---

## Non-Goals (Explicitly Out of Scope)

- No auth/permissions layer on the janitor page
- No background/scheduled AI analysis (all on-demand)
- No conversation persistence for the AI chat (ephemeral per page load)
- No file preview/content viewer
- No integration with external storage APIs (S3, etc.)
- No mobile-optimized layout (desktop-first, responsive is nice-to-have)
