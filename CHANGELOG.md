# aicodeman

## 0.4.3

### Patch Changes

- Refactor case routes: extract readLinkedCases() and resolveCasePath() helpers to eliminate 6x duplicated linked-cases.json path construction and 5x duplicated file read/parse logic. Replace O(n) .some() duplicate check with O(1) Set.has() in case listing. Un-export unused isError() type guard. Standardize reply.status() to reply.code() in system routes. Update CLAUDE.md frontend module listing and SSE event count.

## 0.4.2

### Patch Changes

- Extract monolithic app.js (~12.5K lines) into 6 focused domain modules that extend CodemanApp.prototype via Object.assign: terminal-ui.js (terminal setup, rendering pipeline, controls), respawn-ui.js (respawn banner, countdown, presets, run summary), ralph-panel.js (Ralph state panel, fix_plan, plan versioning), settings-ui.js (app settings, visibility, web push, tunnel/QR, help), panels-ui.js (subagent panel, teams, insights, file browser, log viewer), session-ui.js (quick start, session options, case settings). Fix critical deferred script init ordering bug: wrap CodemanApp instantiation in DOMContentLoaded so all defer'd mixin modules execute their Object.assign before the constructor runs. Guard missing cleanupWizardDragging() call in subagent-windows.js. Update build.mjs to minify/hash all new modules.

## 0.4.1

### Patch Changes

- Performance optimizations: V8 compile cache for 10-20% faster cold starts, lazy-load WebGL addon (244KB saved on mobile), preload hints for critical scripts, batch tmux reconciliation (N subprocess calls → 1). Also: WebSocket session lifecycle fixes, CJK IME input support, CI upgrade to Node 24/actions v6, install.sh fork support, and CLAUDE.md/README documentation refresh.

## 0.4.0

### Minor Changes

- Add CJK IME input textarea for xterm.js terminal (env toggle INPUT_CJK_FORM=ON). Always-visible textarea below terminal handles native browser IME composition, forwarding completed text to PTY on Enter. Supports arrow keys, Ctrl combos, backspace passthrough, and Escape to clear.

  Add fork installation support to install.sh with CODEMAN_REPO_URL and CODEMAN_BRANCH env vars, allowing custom repository and branch for git clone/update operations. README updated with fork installation instructions.

  Fix WebSocket session lifecycle: close WS connections when session exits (prevents orphaned listeners and stale writes to dead PTY), add readyState guard in onTerminal to stop buffering after socket closes, simplify heartbeat by removing redundant alive flag.

  Add WebSocket reconnection with exponential backoff (1s-10s) on unexpected close, skipping server rejection codes (4004/4008/4009). Falls back gracefully to SSE+POST during reconnection.

  Clear CJK textarea on session switch to prevent sending stale text to wrong session.

## 0.3.12

### Patch Changes

- Add WebSocket terminal I/O with server-side DEC 2026 synchronized update markers. Replaces per-keystroke HTTP POST + SSE terminal output with a single bidirectional WebSocket connection for dramatically lower input latency. Server-side 8ms micro-batching with 16KB flush threshold groups rapid PTY events into single WS frames wrapped in DEC 2026 markers for flicker-free atomic rendering. Includes 30s ping/pong heartbeat with 10s timeout for stale connection detection through tunnels. Existing SSE + HTTP POST paths remain fully functional as transparent fallback. Resize messages validated to match HTTP route bounds (cols 1-500, rows 1-200, integers only). 16 automated route tests added for WS endpoint. Also patches 5 dependency vulnerabilities (basic-ftp, fastify, minimatch, serialize-javascript).

## 0.3.11

### Patch Changes

- ### Session Resume & History
  - Add `resumeSessionId` support for conversation resume after reboot
  - Add history session resume UI and API with route shell sessions routing fix
  - Improve session resume reliability and persist user settings across refresh
  - Correct `claudeSessionId` for resumed sessions

  ### Terminal & Frontend
  - Upgrade xterm.js 5.3 → 6.0 with native DEC 2026 synchronized output
  - Increase terminal scrollback from 5,000 to 20,000 lines
  - Reduce default font size and persist tab state across refresh
  - Resolve terminal resize scrollback ghost renders
  - Hide subagent monitor panel by default

  ### Installer
  - Auto-detect existing install and run update instead of fresh install
  - Auto-restart codeman-web service after update if running
  - Show restart command when codeman-web is not a systemd service
  - Fix one-liner restart command for background processes

  ### Codebase Quality
  - Remove dead code, consolidate imports, extract constants
  - Repair 15 pre-existing subagent-watcher test failures
  - Clean up DEC sync dead code

## 0.3.10

### Patch Changes

- - feat: upgrade xterm.js from 5.3 to 6.0 with native DEC 2026 synchronized output support
  - feat: add history session resume UI and API — resume Claude conversations after reboot
  - feat: add resumeSessionId support for conversation resume across session restarts
  - feat: persist active tabs across page refresh
  - feat: improve session resume reliability and persist user settings
  - perf: increase terminal scrollback from 5,000 to 20,000 lines
  - fix: resolve terminal resize scrollback ghost renders
  - fix: route shell sessions to correct endpoint on tab click
  - fix: correct claudeSessionId for resumed sessions (use original Claude conversation ID)
  - fix: increase default desktop font size from 12 to 14
  - refactor: extract shared \_fetchHistorySessions() method to eliminate duplication
  - refactor: remove dead DEC 2026 sync code (extractSyncSegments, DEC_SYNC_START/END constants)

## 0.3.9

### Patch Changes

- Add content-hash cache busting for static assets — build step now renames JS/CSS files with MD5 content hashes (e.g. app.js → app.94b71235.js) and rewrites index.html references. HTML served with Cache-Control: no-cache so browsers always revalidate and pick up new hashed filenames after deploys. Hashed assets keep immutable 1-year cache. Eliminates the need for manual hard refresh (Ctrl+Shift+R) after deployments.

  Refactor path traversal validation into shared validatePathWithinBase() helper in route-helpers.ts, replacing 6 duplicate inline checks across case-routes, plan-routes, and session-routes.

  Deduplicate stripAnsi in bash-tool-parser.ts — use shared utility from utils/index.ts instead of private method.

## 0.3.8

### Patch Changes

- Add tunnel status indicator with control panel — green pulsing dot in header when Cloudflare tunnel is active, dropdown with URL, remote clients, auth sessions, and start/stop/QR/revoke controls

## 0.3.7

### Patch Changes

- Operation Lightspeed: 5 parallel performance optimizations — multi-layer backpressure to prevent terminal write freezes, TERMINAL_TAIL_SIZE constant with client-drop recovery, tab switching SSE gating, and local echo improvements
- Codebase cleanup: remove dead code (unused token validation exports, PlanPhase alias), add execPattern() regex helper to eliminate repetitive .lastIndex resets, centralize 11 magic number constants into config files, fix CLAUDE.md inaccuracies, and add 316 new tests for utilities, respawn helpers, and system-routes

## 0.3.6

### Patch Changes

- Re-enable WebGL renderer with 48KB/frame flush cap protection against GPU stalls

## 0.3.5

### Patch Changes

- Fix Chrome "page unresponsive" crashes caused by xterm.js WebGL renderer GPU stalls during heavy terminal output. Disable WebGL by default (canvas renderer used instead), gate SSE terminal writes during tab switches, and add crash diagnostics with server-side breadcrumb collection.

## 0.3.4

### Patch Changes

- Fix Chrome tab freeze from flicker filter buffer accumulation during active sessions, and fix shell mode feedback delay by excluding shell sessions from cursor-up filter

## 0.3.3

### Patch Changes

- fix: eliminate WebGL re-render flicker during tab switch by keeping renderer active instead of toggling it off/on around large buffer writes

## 0.3.2

### Patch Changes

- Make file browser panel draggable by its header

## 0.3.1

### Patch Changes

- LLM context optimization and performance improvements: compress CLAUDE.md 21%, MEMORY.md 61%; SSE broadcast early return, cached tunnel state, cache invalidation fix, ralph todo cleanup timer; frontend SSE listener leak fix, short ID caching, subagent window handle cleanup; 100% @fileoverview coverage

## 0.3.0

### Minor Changes

- QR code authentication for tunnel access, 7-phase codebase refactor (route extraction, type domain modules, frontend module split, config consolidation, managed timers, test infrastructure), overlay rendering fixes, and security hardening

## 0.2.9

### Patch Changes

- System-level performance optimizations (Phase 4): stream parent transcripts instead of full reads, consolidate subagent file watchers from 500 to ~50 using directory-level inotify, incremental state persistence with per-session JSON caching, and replace team watcher polling with chokidar fs events

## 0.2.8

### Patch Changes

- Remove 159 lines of dead code: unused interfaces, functions, config constants, legacy no-op timer, and stale barrel re-exports

## 0.2.7

### Patch Changes

- Fix race condition in StateStore where dirty flag was overwritten after async write, silently discarding mutations
- Fix PlanOrchestrator session leak by adding session.stop() in finally blocks and centralizing cleanup
- Fix symlink path traversal in file-content and file-raw endpoints by adding realpathSync validation
- Fix PTY exit handler to clean up sessionListenerRefs, transcriptWatchers, runSummaryTrackers, and terminal batching state
- Fix sendInput() fire-and-forget by propagating runPrompt errors to task queue via taskError event
- Fix Ralph Loop tick() race condition by running checkTimeouts/assignTasks sequentially with per-iteration error handling
- Fix shell injection in hook scripts by piping HOOK_DATA via printf to curl stdin instead of inline embedding
- Narrow tail-file allowlist to remove ~/.cache and ~/.local/share paths that exposed credentials
- Fix stored XSS in quick-start dropdown by escaping case names with escapeHtml()

## 0.2.6

### Patch Changes

- Disable tunnel auto-start on boot; tunnel now only starts when user clicks the UI toggle

## 0.2.5

### Patch Changes

- Fix 3 minor memory leaks: clear respawn timers in stop(), clean up persistDebounceTimers on session cleanup, reset \_parentNameCache on SSE reconnect

## 0.2.4

### Patch Changes

- Fix tunnel button not working: settings PUT was rejected by strict Zod validation when sending full settings blob; now sends only `{tunnelEnabled}`. Added polling fallback for tunnel status in case SSE events are missed.

## 0.2.3

### Patch Changes

- Fix tunnel button stuck on "Connecting..." when tunnel is already running on the server

## 0.2.2

### Patch Changes

- Update CLAUDE.md app.js line count references

## 0.2.1

### Patch Changes

- Integrate @changesets/cli for automated releases with changelogs, GitHub Releases, and npm publishing

## 0.2.0

### Minor Changes

- Initial public release with changesets-based versioning
