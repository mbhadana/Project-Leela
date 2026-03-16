# SYSTEM_DIAGNOSTIC.md — LeelaV1 Full Architecture Audit

> **Audit Date:** 2026-03-10  
> **Codebase Version:** 1.0.1  
> **Framework:** Electron 26 + Node.js (CommonJS)  
> **Total Source Files Audited:** 19 files across 4 directories  
> **Total Lines of Code:** ~5,200 (excluding HTML/CSS, `node_modules`, build scripts)

---

> **Update (2026-03-10): Fail-Safe Termination Fixes Applied**
> - The "Fast Release" regression is resolved. Taps under 100ms trigger an immediate FSM abort (`TAP_DISCARD`).
> - A structural defect causing `Ctrl` and `Space` to become permanently stuck during rapid Dictation starts has been fortified. The `HotkeyEngine` now forces a manual flush of physical key state whenever a tap is swallowed by the selection capture window, preventing complete application freeze.
> - Zalgo eradicated in `VoicePipeline`: all paths (success, error, timeout) funnel through a unified `finally` block that guarantees locks are released and HotkeyEngine returns to `IDLE`.
> - A structural Watchdog Kill Switch (`HOTKEY_STOP_WATCHDOG_MS`) guarantees recovery from any stalled UI states.
> - Empty try-catch blocks in the pipeline and worker threads replaced with structural logging.

---

### 1.1 — Bad Smells Identified

#### 🔴 God Object: `main.js` (1,758 lines)

This is the single most critical structural problem. `main.js` performs **at least 12 distinct responsibilities**:

| # | Responsibility | Lines |
|---|---|---|
| 1 | Environment loading & dotenv parsing | 28–53 |
| 2 | Console interception & logging | 55–85 |
| 3 | Crash-loop guard & auto-restart | 87–119 |
| 4 | Hotkey FSM orchestration (20+ mutable globals) | 121–282 |
| 5 | Recorder start/stop session management | 284–368 |
| 6 | Window creation (Status, Dashboard, Notification, Tray) | 372–564 |
| 7 | Clipboard capture & selection detection | 579–641 |
| 8 | AI output sanitization (regex chains) | 643–677 |
| 9 | Voice language directive parsing | 679–726 |
| 10 | AI polishing (system prompts + API calls) | 731–855 |
| 11 | Hotkey keydown/keyup handlers (nested inside `app.whenReady`) | 880–1181 |
| 12 | IPC handler registration (~30 handlers) | 1197–1757 |

**Verdict:** This is a textbook "Large Class" smell. Each responsibility operates at a different abstraction level, making the file impossible to reason about locally.

#### 🔴 Long Methods

| Function | Lines | Issue |
|---|---|---|
| `ipcMain.handle('process-recording', ...)` | 1342–1515 (173 lines) | Mixes file validation, transcription, language parsing, AI polishing, clipboard pasting, history logging, and error fallback — at least 7 levels of abstraction. |
| `handleHotkeyTrigger()` | 903–998 (95 lines) | Combines selection capture, mode determination, sound triggering, and recorder start. |
| `polishText()` | 731–855 (124 lines) | Embeds two enormous system prompt templates (multi-paragraph string literals) and API call logic. |
| `sanitizeAiOutput()` | 643–677 (34 lines) | A regex chain with 15+ patterns — domain logic buried in implementation. |

#### 🟡 Feature Envy

- `notification_panel.js` (769 lines) directly reads/writes to the filesystem (`fs.readFileSync`, `fs.writeFileSync`) for n8n config persistence instead of going through a proper settings/config manager.
- `main.js` directly constructs VBScript files and executes `wscript` for clipboard operations — scattered across `runSelectionScript`, `runInstantPolish`, and `process-recording`.

#### 🟡 Duplicated Paste Logic

The "write-to-clipboard → create-script → exec-paste → cleanup-script" sequence appears **4 separate times** in `main.js` (lines 1062–1074, 1197–1218, 1440–1471, 1474–1499). This is a prime candidate for a `pasteToFocusedApp(text)` helper.

---

### 1.2 — Narrative Flow (Stepdown Rule)

**Current Structure of `main.js`:**

```
Low-level: loadEnv() parsing
Low-level: addLog() / console intercepts
Mid-level: safeRestart() + crash handlers
Low-level: 30+ mutable state variables
Mid-level: hotkey FSM helpers
High-level: Window creation functions
Low-level: Clipboard script execution
Mid-level: AI sanitization + language detection
High-level: polishText() with embedded prompts
High-level: app.whenReady() with nested handlers
Low-level: uIOhook keydown/keyup handlers inside whenReady
Low-level: 30+ IPC handlers as flat list
```

**Problem:** The file does not read top-to-bottom. A reader encounters low-level env parsing, then jumps to mid-level crash handling, then drops into 30 mutable globals, then sees high-level window functions, then reads low-level regex chains, then finds high-level AI prompts, then encounters deeply nested event handlers.

**Desired Narrative:**

```
1. Bootstrap (env, crash guard, single-instance lock)
2. App Lifecycle (window creation, tray, activation)
3. Hotkey System (trigger → capture → decide mode → start/stop recorder)
4. Voice Processing Pipeline (transcribe → polish → paste)
5. IPC API Registration (thin delegation layer)
```

---

### 1.3 — Semantic Integrity: Magic Strings & Numbers

| Location | Magic Value | Suggested Constant |
|---|---|---|
| `main.js:56` | `1000` | `MAX_LOG_BUFFER_SIZE` |
| `main.js:89` | `60000` | Already named ✅ `RESTART_WINDOW_MS` |
| `main.js:90` | `3` | Already named ✅ `MAX_RESTARTS` |
| `main.js:151` | `100` | Already named ✅ `HOTKEY_DEBOUNCE` |
| `main.js:382` | `20` | `STATUS_BAR_HEIGHT_PX` |
| `main.js:423` | `400` | `STATUS_HIDE_ANIMATION_MS` |
| `main.js:436` | `1500` | `STATUS_AUTO_HIDE_MS` |
| `main.js:500` | Close handler logic | N/A but undocumented |
| `main.js:642` | `500` | `CLIPBOARD_RESTORE_DELAY_MS` |
| `main.js:840` | `0.1` | `AI_TEMPERATURE` |
| `main.js:843` | `30000` | `AI_API_TIMEOUT_MS` |
| `main.js:1251` | `10 * 1024 * 1024` | `FFMPEG_MAX_BUFFER_BYTES` |
| `main.js:1285` | `45000` | `TRANSCRIPTION_CHUNK_TIMEOUT_MS` |
| `main.js:1387–1406` | Hardcoded language array | `SUPPORTED_VOICE_LANGUAGES` (should be a shared constant or config) |
| `main.js:1433` | `7` | `MIN_QUALITY_SCORE_THRESHOLD` |
| `main.js:1618` | `5000` | `API_KEY_TEST_TIMEOUT_MS` |
| `main.js:1642` | `500` | `ONBOARDING_TRIGGER_DELAY_MS` |
| `cleanup.js:32` | `30 * 60 * 1000` | `CLEANUP_INTERVAL_MS` |
| `optimizer/engine.js:21` | `50 * 1024 * 1024` | Already named ✅ `CHUNK_THRESHOLD` |
| `optimizer/engine.js:22` | `60000` | Already named ✅ `TIMEOUT_MS` |
| `activity_logger.js:65` | `200` | `MAX_HISTORY_ENTRIES` |
| `notification_panel.js:33` | `2000` | Already named ✅ `VOICE_STOP_WATCHDOG_MS` |

**Magic Strings:**

| Location | String | Issue |
|---|---|---|
| `main.js:834` | `'https://api.sarvam.ai/v1/chat/completions'` | API endpoint — should be `SARVAM_CHAT_ENDPOINT` |
| `main.js:1280` | `'https://api.sarvam.ai/speech-to-text'` | Should be `SARVAM_STT_ENDPOINT` |
| `main.js:1274` | `'saaras:v3'` | Model name — should be `SARVAM_STT_MODEL` |
| `main.js:835` | `'sarvam-m'` | Model name — should be `SARVAM_CHAT_MODEL` |
| `main.js:1361` | `'TAP_DISCARD'` | Mode string — should use the enum pattern from `HotkeyCommandContext` |
| Various | `'C:\\ProgramData'` fallback | Should be `FALLBACK_PROGRAMDATA_DIR` |

---

## 2. Type-Safe Contract Specification

### 2.1 — Data Model Interfaces (TypeScript)

```typescript
// ─── Core Application State ─────────────────────────────────────

interface AppConfig {
  readonly overlayEnabled: boolean;
  readonly hotkey: string;
  readonly historyEnabled: boolean;
  readonly historyRetentionLimit: number;
  readonly startWithWindows: boolean;
  readonly targetLanguage: string;
  readonly targetLanguageName: string;
  readonly onboarding_completed: boolean;
  readonly optimizerEnabled: boolean;
  readonly optimizerQualityThreshold: number;
  readonly optimizerMaxFileSizeMB: number;
  readonly optimizerAutoLearn: boolean;
  readonly micDeviceId: string;
}

// ─── Hotkey State Machine ───────────────────────────────────────

type RecorderLifecycle =
  | 'IDLE'
  | 'START_REQUESTED'
  | 'LISTENING'
  | 'STOP_REQUESTED'
  | 'PROCESSING';

type HotkeyContext =
  | 'NONE'
  | 'SELECTION_TAP'
  | 'SELECTION_HOLD'
  | 'DICTATION';

interface HotkeyState {
  readonly lifecycle: RecorderLifecycle;
  readonly context: HotkeyContext;
  readonly deferredStop: boolean;
}

// ─── Discriminated Union for HotkeyEvents ───────────────────────

type HotkeyEvent =
  | { readonly type: 'START_REQUEST'; readonly context: HotkeyContext }
  | { readonly type: 'STOP_REQUEST'; readonly deferred: boolean }
  | { readonly type: 'LISTENING_CONFIRMED' }
  | { readonly type: 'PROCESSING_CONFIRMED' }
  | { readonly type: 'RESET' }
  | { readonly type: 'CONTEXT_UPDATE'; readonly context: HotkeyContext };

// ─── Voice Processing Pipeline ──────────────────────────────────

type TranscriptionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

type PolishResult = {
  readonly text: string;
  readonly qualityScores: QualityScores;
};

interface QualityScores {
  readonly meaning: number;
  readonly grammar: number;
  readonly tone: number;
}

// ─── Selection Capture ──────────────────────────────────────────

interface SelectionCaptureResult {
  readonly selection: string;
  readonly oldClipboard: string;
  readonly isEditable: boolean;
}

// ─── IPC Contracts ──────────────────────────────────────────────

type IpcResult<T = void> =
  | { readonly ok: true; readonly data?: T }
  | { readonly ok: false; readonly error: string };

// ─── Activity History ───────────────────────────────────────────

type ActionType = 'Smart Polish' | 'Context Command' | 'Voice Dictation';

interface ActivityEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly type: ActionType;
  readonly input: string;
  readonly output: string;
  readonly status: 'SUCCESS' | 'ERROR';
  readonly qualityScores: QualityScores | null;
}

// ─── Optimizer ──────────────────────────────────────────────────

type FileCategory = 'image' | 'audio' | 'video' | 'document' | 'compressed' | 'archive' | 'unknown';
type CompressionLevel = 'none' | 'low' | 'medium' | 'high' | 'maximum';
type StrategyName = 'lossless' | 'structural' | 'format_convert' | 'perceptual' | 'skip';

interface AnalysisReport {
  readonly filePath: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly fileType: FileCategory;
  readonly format: string;
  readonly mime: string;
  readonly entropy: number;
  readonly compressionLevel: CompressionLevel;
  readonly optimizationPotential: number;
  readonly recommendedStrategy: StrategyName;
  readonly metadata: { readonly estimatedSize: number };
}

type OptimizationResult =
  | { readonly success: true; readonly originalPath: string; readonly outputPath: string; /* ... */ }
  | { readonly success: false; readonly error: string; readonly rolledBack?: boolean };

// ─── Discriminated Union: App Processing State ──────────────────

type AppProcessingState =
  | { readonly state: 'IDLE' }
  | { readonly state: 'LISTENING'; readonly sessionId: number }
  | { readonly state: 'PROCESSING'; readonly inputText: string }
  | { readonly state: 'SUCCESS_PASTE'; readonly outputText: string }
  | { readonly state: 'SUCCESS_POLISH'; readonly outputText: string }
  | { readonly state: 'ERROR'; readonly message: string }
  | { readonly state: 'WARNING'; readonly message: string };
```

### 2.2 — Safety Audit: "One Bug Away" Risks

| # | Risk | Location | Impact |
|---|---|---|---|
| 1 | **30+ mutable module-level globals** control the hotkey FSM, recording state, capture state, and session IDs. Any race condition between async capture and keyup events can corrupt state. | `main.js:121–175` | Stuck recording, phantom sessions, or missed recordings. |
| 2 | **`recordingType`** is a loose `null \| string` that accepts `'CLICK'`, `'HOLD'`, `'TAP_DISCARD'`. There is no exhaustiveness check. A typo like `'CLICK_HOLD'` would silently pass. | `main.js:145, 1015, 1025, 1033, 1039, 1361` | Wrong audio processing path or silent data loss. |
| 3 | **`qualityScores` always returns `{ meaning: 10, grammar: 10, tone: 10 }`** in `polishText()`. The quality guard at line 1432 checks for `< 7` but can never trigger. This is dead code masquerading as a safety net. | `main.js:853, 1431–1437` | False reliability signal; low-quality output silently passes. |
| 4 | **Unchecked optional chaining**: `response.data?.choices?.[0]?.message?.content` falls back to the raw input `text` on any API structure change. This silently degrades without alerting. | `main.js:846` | Users receive raw transcriptions instead of polished text without any error notification. |
| 5 | **`settings.targetLanguage` defaults to `'en'`** but the languages array in `process-recording` hardcodes 15 languages with no validation against settings. A user could set `targetLanguage: 'ar'` (Arabic) which isn't in the list. | `main.js:1387–1406` | Language directive detection fails silently. |
| 6 | **`contextIsolation: false`** on all BrowserWindows. | `main.js:394, 488, 529` | Any XSS in renderer HTML gives full Node.js access — a critical security hole for an app that processes external API responses. |

---

## 3. Reliability & Persistence Architecture

### 3.1 — Persistence Layer Analysis

**Current Data Storage:**

| Data | File | Format | Access Pattern |
|---|---|---|---|
| Activity history | `activity_history.json` | JSON array | Read-all → mutate → write-all (full serialization on every action) |
| Settings | `settings.json` | JSON object | Read-all → merge → write-all |
| API key | `config.json` | JSON + Electron SafeStorage | Read-all → mutate → write-all |
| Optimizer metrics | `optimizer_metrics.json` | JSON array (max 500) | Read-all → prepend → write-all |
| Optimizer learning DB | `optimizer_learning.json` | Nested JSON (per-type, per-format) | Read-all → deep mutate → write-all |
| n8n webhook config | `n8n_config.json` (renderer-local) | JSON | Direct `fs` in renderer process |

**Problems:**

1. **Full-file serialization on every write.** Every `logAction()` call reads the entire history file, parses it, prepends an entry, and rewrites the entire file. Under high usage, this is an O(n) operation on every voice action.

2. **No write locking or atomicity.** Two concurrent `logAction()` calls (e.g., rapid dictation) will read the same file, both append independently, and the last write wins — causing data loss.

3. **No data validation on read.** If `activity_history.json` becomes corrupted (e.g., partial write during crash), `JSON.parse()` throws, and the catch block logs the error but returns `[]` — silently wiping visible history.

**Proposed: Repository Pattern**

```
┌──────────────────────────────────────────────────────┐
│                    Business Logic                     │
│  (polishText, process-recording, handleHotkey, etc.)  │
└────────┬───────────────────────────────┬──────────────┘
         │                               │
    ┌────▼────┐                    ┌─────▼─────┐
    │ IHistoryRepo │              │ ISettingsRepo │
    │ .log(entry)  │              │ .get()       │
    │ .getAll()    │              │ .update()    │
    │ .clear()     │              │ .subscribe() │
    └────┬────┘                    └──────┬─────┘
         │                                │
    ┌────▼────────────────────────────────▼──┐
    │       JsonFileAdapter (current)         │
    │  → Atomic writes (write-tmp → rename)  │
    │  → Read-through cache                  │
    │  → Mutex for concurrent writes         │
    └────────────────────────────────────────┘
```

### 3.2 — Error Strategy Audit

| Location | Current Handling | Problem |
|---|---|---|
| `main.js:1200` | `return { ok: false, error: 'empty' }` | Error codes instead of typed exceptions; caller must check `.ok` manually. |
| `main.js:1346` | `return { ok: false, error: 'file_missing' }` | Same — no structured error type. Caller and renderer must string-match. |
| `main.js:1354` | `return { ok: false, error: 'no_api_key' }` | Same untyped error string. |
| `main.js:1077` | `console.error(...); updateState(AppStates.ERROR)` | Error silently swallowed in `runInstantPolish` — no user-facing message beyond a red overlay for 1.5s. |
| `optimizer/index.js` | Structured `{ success, error }` patterns | ✅ Better, but still uses untyped strings. |
| `notification_panel.js` | `try/catch` → `addMessage('error', ...)` | ✅ Shows error to user in chat UI. |

**Recommendation:** Define an `AppError` hierarchy:

```typescript
abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly userMessage: string;
  abstract readonly recoverable: boolean;
}

class ApiKeyMissingError extends AppError { code = 'API_KEY_MISSING'; /* ... */ }
class TranscriptionFailedError extends AppError { code = 'TRANSCRIPTION_FAILED'; /* ... */ }
class NetworkTimeoutError extends AppError { code = 'NETWORK_TIMEOUT'; /* ... */ }
```

### 3.3 — Async Safety ("Zalgo" Check)

| # | Location | Issue |
|---|---|---|
| 1 | `exec()` callbacks inside `runInstantPolish` and `process-recording` | The paste operation uses `exec(cmd, cb)` (callback) while the enclosing function is `async`. The function returns before the paste completes, creating mixed async behavior. |
| 2 | `activityLogger.logAction()` | Synchronous `fs.readFileSync` + `fs.writeFileSync` inside an async pipeline. This blocks the event loop during file I/O. |
| 3 | `settingsManager.getSettings()` | Synchronous everywhere ✅, but `loadSettings()` uses sync FS on startup — acceptable for init. |
| 4 | `optimizer/engine.js: execute()` | Uses `execAsync` properly ✅. |
| 5 | `transcribeSynchronous()` at line 1259 | Uses `fs.readdirSync` inside an `async` function. Should use `fs.promises.readdir`. |
| 6 | `cleanup.js: runCleanup()` | `fs.readdirSync` + `fs.unlinkSync` — synchronous I/O in a timer. On a directory with many files, this blocks the event loop. |

**Most Critical Zalgo:** The `exec()` callback in `process-recording` (line 1447) fires the activity log and clipboard restore **inside a callback**, after the IPC handler has already returned `{ ok: true }`. This means the renderer receives "success" before the paste has actually happened.

---

## 4. Scalability & Production Hardening

### 4.1 — Load Bottlenecks (100x Requests Scenario)

| # | Bottleneck | Current Behavior | At 100x Load |
|---|---|---|---|
| 1 | **Full-file JSON serialization** in `activity_logger.js` | Read + parse + prepend + stringify + write on every action | 100 concurrent writes = massive I/O contention + data corruption |
| 2 | **Sequential chunk transcription** in `transcribeSynchronous()` | `for (const chunk of chunkFiles)` — sequential API calls per chunk | Long audio → N sequential HTTP calls. No parallelism. At 100x, Sarvam API rate limits will block. |
| 3 | **`fs.readdirSync` in cleanup** | Blocks event loop while scanning directory | With 100x temp files accumulating, the 30-min cleanup scan becomes expensive. |
| 4 | **Single-process architecture** | All hotkey handling, API calls, and file processing in one Electron main process | CPU-bound FFmpeg operations block hotkey responsiveness. At 100x, the app becomes unresponsive. |
| 5 | **In-memory log buffer** (`logs[]` in `main.js`) | Array grows to `logLimit = 1000` entries | Memory pressure at 100x with large log entries (each log line includes full JSON payloads). |
| 6 | **Optimizer: Sharp image operations** in main process | CPU-intensive image manipulation runs on the same thread as UI | Large images will freeze the entire app for seconds. |

### 4.2 — Dependency Audit

| Package | Version | Purpose | DI Candidate? |
|---|---|---|---|
| `electron` | ^26.0.0 | Runtime framework | No (foundational) |
| `axios` | ^1.13.6 | HTTP client for API calls | ✅ Yes — abstract behind `IHttpClient` |
| `dotenv` | ^17.3.1 | Env loading | No (replaced by custom `loadEnv`) |
| `express` | ^5.2.1 | **⚠️ Unused** — not imported anywhere in source | ❌ Remove |
| `ffmpeg-static` | ^5.3.0 | Audio/video conversion | ✅ Yes — abstract behind `IMediaConverter` |
| `form-data` | ^4.0.5 | Multipart upload | Coupled to axios — abstract together |
| `sarvamai` | ^1.0.0 | **⚠️ Unused** — not imported anywhere | ❌ Remove |
| `uiohook-napi` | ^1.5.4 | Global hotkey monitoring | ✅ Yes — abstract behind `IGlobalInputMonitor` |
| `bytenode` | ^1.5.7 | Source code protection (build only) | No |
| `sharp` | ^0.34.5 | Image processing | ✅ Yes — abstract behind `IImageProcessor` |

**Unused Dependencies:** `express` and `sarvamai` are listed in `package.json` but never imported. They add ~10MB to the bundle unnecessarily.

**Dependency Injection Pattern:**

```javascript
// services/container.js
module.exports = {
  httpClient: require('axios'),          // Swappable with got, fetch, etc.
  imageProcessor: require('sharp'),      // Swappable with jimp, canvas
  mediaConverter: { path: require('ffmpeg-static') },
  inputMonitor: require('uiohook-napi'), // Swappable with iohook, etc.
};
```

### 4.3 — Statelessness Check

| State | Storage | Problem |
|---|---|---|
| `logs[]` (in-memory array) | Process memory | Lost on crash/restart. Not shared across instances. |
| `recentCrashes[]` | Process memory | Intentionally ephemeral ✅ |
| 30+ hotkey state variables | Process memory | Intrinsically tied to this process — acceptable for desktop app. |
| `isRecordingActive` | Process memory | Could desync with renderer state on crash. |
| `pendingSelection` | Process memory | Lost if process crashes during selection capture. |
| Session data (n8n webhook URL) | Renderer-local `n8n_config.json` | Written from renderer process — not accessible from main process. |

**For Horizontal Scaling (Future Server Component):**
- Move `logs[]` to a file-backed ring buffer or structured logger (e.g., `winston`).
- Move session-like state (n8n config) to the shared settings manager.
- If adding a server component: use Redis/SQLite for shared state instead of JSON files.

---

## 5. Executable Definition of "Done"

### 5.1 — Test Suite Skeleton (Arrange-Act-Assert)

The codebase currently has **1 test file** (`tests/hotkey_state_machine.test.js`) with **5 scenarios** covering only the hotkey FSM. Below is the minimum test skeleton needed:

```javascript
// tests/text_processing.test.js
const assert = require('assert');

function run(name, fn) {
  try { fn(); process.stdout.write(`PASS ${name}\n`); }
  catch (e) { process.stderr.write(`FAIL ${name}: ${e.message}\n`); process.exitCode = 1; }
}

// ─── sanitizeAiOutput ──────────────────────────────────────────

run('sanitizeAiOutput: strips markdown code fences', () => {
  // Arrange
  const { sanitizeAiOutput } = require('../text_processing');
  const input = '```json\n{"key": "value"}\n```';
  const fallback = 'fallback';
  // Act
  const result = sanitizeAiOutput(input, fallback);
  // Assert
  assert.ok(!result.includes('```'), 'Should strip code fences');
});

run('sanitizeAiOutput: strips think/analysis tags', () => {
  // Arrange
  const { sanitizeAiOutput } = require('../text_processing');
  const input = '<think>Internal reasoning</think>The actual output';
  // Act
  const result = sanitizeAiOutput(input, 'fallback');
  // Assert
  assert.equal(result, 'The actual output');
});

run('sanitizeAiOutput: strips preamble phrases', () => {
  // Arrange
  const { sanitizeAiOutput } = require('../text_processing');
  const input = 'Certainly! Here is the polished version:\nThe actual text.';
  // Act
  const result = sanitizeAiOutput(input, 'fallback');
  // Assert
  assert.ok(!result.startsWith('Certainly'), 'Should strip conversational preamble');
});

run('sanitizeAiOutput: returns fallback on empty', () => {
  // Arrange
  const { sanitizeAiOutput } = require('../text_processing');
  // Act
  const result = sanitizeAiOutput('', 'My Fallback');
  // Assert
  assert.equal(result, 'My Fallback');
});

// ─── detectVoiceLanguageDirective ──────────────────────────────

run('detectVoiceLanguageDirective: detects "translate to Hindi" at start', () => {
  // Arrange
  const { detectVoiceLanguageDirective } = require('../text_processing');
  const languages = [{ code: 'hi', name: 'Hindi' }];
  const transcript = 'translate to Hindi hello world';
  // Act
  const result = detectVoiceLanguageDirective(transcript, languages);
  // Assert
  assert.equal(result.overrideLang, 'hi');
  assert.equal(result.cleanTranscript, 'hello world');
});

run('detectVoiceLanguageDirective: detects "in French" at end', () => {
  // Arrange
  const { detectVoiceLanguageDirective } = require('../text_processing');
  const languages = [{ code: 'fr', name: 'French' }];
  const transcript = 'good morning, write in French';
  // Act
  const result = detectVoiceLanguageDirective(transcript, languages);
  // Assert
  assert.equal(result.overrideLang, 'fr');
});

run('detectVoiceLanguageDirective: returns null for no match', () => {
  // Arrange
  const { detectVoiceLanguageDirective } = require('../text_processing');
  const languages = [{ code: 'hi', name: 'Hindi' }];
  // Act
  const result = detectVoiceLanguageDirective('just some text', languages);
  // Assert
  assert.equal(result.overrideLang, null);
});

if (process.exitCode) process.exit(process.exitCode);
```

```javascript
// tests/settings_manager.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run(name, fn) {
  try { fn(); process.stdout.write(`PASS ${name}\n`); }
  catch (e) { process.stderr.write(`FAIL ${name}: ${e.message}\n`); process.exitCode = 1; }
}

// NOTE: Requires mocking app.getPath('userData') to a temp directory

run('getSettings: returns defaults when no file exists', () => {
  // Arrange — ensure settings file doesn't exist
  // Act
  const settings = require('../settings_manager').getSettings();
  // Assert
  assert.equal(settings.overlayEnabled, true);
  assert.equal(settings.targetLanguage, 'en');
});

run('updateSettings: merges partial updates', () => {
  // Arrange
  const mgr = require('../settings_manager');
  // Act
  mgr.updateSettings({ overlayEnabled: false });
  const settings = mgr.getSettings();
  // Assert
  assert.equal(settings.overlayEnabled, false);
  assert.equal(settings.targetLanguage, 'en'); // Other defaults preserved
});

if (process.exitCode) process.exit(process.exitCode);
```

```javascript
// tests/optimizer_strategy.test.js
const assert = require('assert');
const { selectStrategy } = require('../optimizer/strategy');

function run(name, fn) {
  try { fn(); process.stdout.write(`PASS ${name}\n`); }
  catch (e) { process.stderr.write(`FAIL ${name}: ${e.message}\n`); process.exitCode = 1; }
}

run('selectStrategy: skips already-compressed archives', () => {
  // Arrange
  const report = {
    fileType: 'compressed', format: 'gzip',
    compressionLevel: 'maximum', optimizationPotential: 0,
    entropy: 7.9, fileSize: 10000, recommendedStrategy: 'lossless'
  };
  // Act
  const plan = selectStrategy(report, null, {});
  // Assert
  assert.equal(plan.strategy, 'skip');
});

run('selectStrategy: skips trivially small files', () => {
  // Arrange
  const report = {
    fileType: 'image', format: 'png',
    compressionLevel: 'low', optimizationPotential: 50,
    entropy: 5, fileSize: 500, recommendedStrategy: 'lossless'
  };
  // Act
  const plan = selectStrategy(report, null, {});
  // Assert
  assert.equal(plan.strategy, 'skip');
});

run('selectStrategy: respects learner hints with sufficient samples', () => {
  // Arrange
  const report = {
    fileType: 'image', format: 'png',
    compressionLevel: 'low', optimizationPotential: 50,
    entropy: 5, fileSize: 100000, recommendedStrategy: 'lossless'
  };
  const hints = { bestStrategy: 'structural', bestPreset: 'balanced', sampleCount: 5 };
  // Act
  const plan = selectStrategy(report, hints, { optimizerQualityThreshold: 95 });
  // Assert
  assert.equal(plan.strategy, 'structural');
  assert.equal(plan.confidence, 'learned');
});

if (process.exitCode) process.exit(process.exitCode);
```

### 5.2 — Green Bar Minimum

To achieve a green bar, the following **prerequisite refactoring** is needed:

1. **Extract `sanitizeAiOutput()` and `detectVoiceLanguageDirective()`** from `main.js` into a standalone `text_processing.js` module (pure functions, no Electron dependency — immediately testable).

2. **Add `test:all` script** to `package.json`:
   ```json
   "test:all": "node tests/hotkey_state_machine.test.js && node tests/text_processing.test.js && node tests/optimizer_strategy.test.js"
   ```

3. The `settings_manager.test.js` requires decoupling `app.getPath()` from `settings_manager.js` via dependency injection of the data directory path.

---

## Summary: Priority Heat Map

| Priority | Area | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Decompose `main.js` into 5–6 focused modules | High | Unlocks testability, readability, and all downstream improvements |
| 🔴 P0 | Enable `contextIsolation: true` + preload scripts | Medium | Closes critical security vulnerability |
| 🟠 P1 | Extract constants for all magic numbers/strings | Low | Immediate readability improvement |
| 🟠 P1 | Remove unused deps (`express`, `sarvamai`) | Trivial | Smaller bundle, fewer attack surface |
| 🟠 P1 | DRY the 4× duplicated paste logic | Low | Eliminates maintenance hazard |
| 🟡 P2 | Atomic file writes for JSON persistence | Medium | Prevents data corruption |
| 🟡 P2 | Convert sync FS calls in async paths to `fs.promises` | Low | Eliminates event loop blocking |
| 🟡 P2 | Implement Repository Pattern for data access | Medium | Decouples business logic from storage |
| 🟢 P3 | Move FFmpeg operations to worker thread | Medium | Prevents UI freezes on large files |
| 🟢 P3 | Add structured error hierarchy | Medium | Better debugging and user-facing error messages |
| 🟢 P3 | Implement dependency injection container | Medium | Enables swappable backends and easier testing |
| 🟢 P3 | Build comprehensive test suite | High | Regression safety net for all future changes |
