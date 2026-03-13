/**
 * @fileoverview WebSocket terminal I/O route.
 *
 * Provides a low-latency bidirectional channel for terminal input/output,
 * bypassing the HTTP POST + SSE path that adds per-request middleware overhead.
 * Auth is checked once on the WebSocket upgrade handshake (cookies are included
 * automatically by the browser). After upgrade, the connection is raw — no
 * per-message middleware processing.
 *
 * Additive: the existing HTTP POST /api/sessions/:id/input and SSE session:terminal
 * paths remain fully functional. The frontend opts into WS when available and
 * falls back transparently.
 *
 * Terminal output is micro-batched at 8ms to group Ink's rapid cursor-up redraws
 * into single frames, preventing flicker from split ANSI sequences. This matches
 * the SSE path's server-side batching (16-50ms) but at a shorter interval since
 * WS has no Traefik buffering overhead.
 *
 * Protocol (all JSON text frames):
 *   Server -> Client:
 *     {"t":"o","d":"..."} — terminal output
 *     {"t":"c"}           — clear terminal
 *     {"t":"r"}           — needs refresh (reload buffer)
 *   Client -> Server:
 *     {"t":"i","d":"..."} — input (keystroke or paste)
 *     {"t":"z","c":N,"r":N} — resize terminal
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionPort } from '../ports/session-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';

/** Micro-batch interval for terminal output (ms). Short enough for low latency,
 *  long enough to group Ink's rapid cursor-up redraw sequences into single frames. */
const WS_BATCH_INTERVAL_MS = 8;

/** Flush immediately when batch exceeds this size (bytes) for responsiveness. */
const WS_BATCH_FLUSH_THRESHOLD = 16384;

/** DEC 2026 synchronized update markers. Wrapping output in these tells xterm.js
 *  to buffer all content and render atomically in a single frame — eliminates
 *  flicker from cursor-up redraws that Ink sends without its own sync markers
 *  (DA capability negotiation fails through the PTY→server→WS proxy chain). */
const DEC_2026_START = '\x1b[?2026h';
const DEC_2026_END = '\x1b[?2026l';

export function registerWsRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.get<{ Params: { id: string } }>('/ws/sessions/:id/terminal', { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params;
    const session = ctx.sessions.get(id);

    if (!session) {
      socket.close(4004, 'Session not found');
      return;
    }

    // Per-connection micro-batch state
    let batchChunks: string[] = [];
    let batchSize = 0;
    let batchTimer: ReturnType<typeof setTimeout> | null = null;

    const flushBatch = () => {
      batchTimer = null;
      if (batchChunks.length === 0 || socket.readyState !== 1) {
        batchChunks = [];
        batchSize = 0;
        return;
      }
      const data = batchChunks.join('');
      batchChunks = [];
      batchSize = 0;
      socket.send(`{"t":"o","d":${JSON.stringify(DEC_2026_START + data + DEC_2026_END)}}`);
    };

    // Attach message handler synchronously BEFORE any async work
    // (@fastify/websocket requirement to avoid dropped messages).
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.t === 'i' && typeof msg.d === 'string') {
          if (msg.d.length > MAX_INPUT_LENGTH) return;
          session.write(msg.d);
        } else if (msg.t === 'z' && typeof msg.c === 'number' && typeof msg.r === 'number') {
          session.resize(msg.c, msg.r);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Terminal output -> micro-batched WS send
    const onTerminal = (data: string) => {
      batchChunks.push(data);
      batchSize += data.length;

      // Flush immediately for large batches (responsiveness during bulk output)
      if (batchSize > WS_BATCH_FLUSH_THRESHOLD) {
        if (batchTimer) {
          clearTimeout(batchTimer);
        }
        flushBatch();
        return;
      }

      // Start timer if not already running
      if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, WS_BATCH_INTERVAL_MS);
      }
    };

    const onClearTerminal = () => {
      if (socket.readyState === 1) {
        socket.send('{"t":"c"}');
      }
    };

    const onNeedsRefresh = () => {
      if (socket.readyState === 1) {
        socket.send('{"t":"r"}');
      }
    };

    session.on('terminal', onTerminal);
    session.on('clearTerminal', onClearTerminal);
    session.on('needsRefresh', onNeedsRefresh);

    socket.on('close', () => {
      if (batchTimer) clearTimeout(batchTimer);
      batchChunks = [];
      session.off('terminal', onTerminal);
      session.off('clearTerminal', onClearTerminal);
      session.off('needsRefresh', onNeedsRefresh);
    });
  });
}
