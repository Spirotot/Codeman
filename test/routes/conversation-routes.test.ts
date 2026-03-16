/**
 * @fileoverview Tests for the conversation API endpoint (GET /api/sessions/:id/conversation).
 *
 * Tests JSONL parsing, message extraction, pagination, and type filtering.
 * Uses a temp JSONL file to simulate Claude Code output.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// Sample JSONL entries matching Claude Code output format
const sampleJsonl = [
  { type: 'user', message: { role: 'user', content: 'Hello, how are you?' }, timestamp: '2026-01-01T00:00:01Z' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'The user is greeting me.' },
        { type: 'text', text: 'I am doing well, thank you!' },
      ],
    },
    timestamp: '2026-01-01T00:00:02Z',
  },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'echo hello' },
        },
      ],
    },
    timestamp: '2026-01-01T00:00:03Z',
  },
  { type: 'tool_result', tool_use_id: 'tool-1', content: 'hello\n', timestamp: '2026-01-01T00:00:04Z' },
  {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'The command output "hello".' }],
    },
    timestamp: '2026-01-01T00:00:05Z',
  },
  { type: 'user', message: { role: 'user', content: 'Thanks!' }, timestamp: '2026-01-01T00:00:06Z' },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'Agent',
          input: { description: 'Research task', prompt: 'Do research' },
        },
      ],
    },
    timestamp: '2026-01-01T00:00:07Z',
  },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'All done!' }] },
    timestamp: '2026-01-01T00:00:08Z',
  },
];

describe('GET /api/sessions/:id/conversation', () => {
  let harness: RouteTestHarness;
  let jsonlDir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);

    // Create a temp JSONL file in the expected location
    // The conversation endpoint searches ~/.claude/projects/*/<sessionId>.jsonl
    const projectsDir = join(homedir(), '.claude', 'projects');
    jsonlDir = join(tmpdir(), 'codeman-test-projects', 'test-project');
    mkdirSync(jsonlDir, { recursive: true });

    const sessionId = harness.ctx._sessionId;
    jsonlPath = join(jsonlDir, `${sessionId}.jsonl`);

    // Write sample JSONL
    const content = sampleJsonl.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    writeFileSync(jsonlPath, content);

    // Patch the session to have a claudeSessionId that matches
    const session = harness.ctx.sessions.get(sessionId);
    if (session) {
      (session as Record<string, unknown>).claudeSessionId = sessionId;
    }
  });

  afterEach(async () => {
    await harness.app.close();
    try {
      rmSync(jsonlDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns 200 with empty messages when JSONL not found', async () => {
    // Use a session ID that has no JSONL file
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent-session/conversation',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it('extracts user, assistant, thinking, tool_use, and tool_result messages', async () => {
    // Symlink our temp JSONL into the projects dir so the endpoint finds it
    const projectsDir = join(homedir(), '.claude', 'projects');
    const testProjectDir = join(projectsDir, '-codeman-test');
    mkdirSync(testProjectDir, { recursive: true });
    const linkedPath = join(testProjectDir, `${harness.ctx._sessionId}.jsonl`);
    writeFileSync(linkedPath, sampleJsonl.map((e) => JSON.stringify(e)).join('\n') + '\n');

    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/conversation?limit=50`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Should have: 2 user + 2 assistant text + 1 thinking + 2 tool_use + 1 tool_result = 9
      expect(body.total).toBe(9);
      expect(body.messages).toHaveLength(9);

      // Messages come newest-first
      const types = body.messages.map((m: { type: string }) => m.type);
      expect(types).toContain('user');
      expect(types).toContain('assistant');
      expect(types).toContain('thinking');
      expect(types).toContain('tool_use');
      expect(types).toContain('tool_result');

      // Check Agent tool_use has agentDescription
      const agentMsg = body.messages.find(
        (m: { type: string; toolName?: string }) => m.type === 'tool_use' && m.toolName === 'Agent'
      );
      expect(agentMsg).toBeDefined();
      expect(agentMsg.agentDescription).toBe('Research task');
    } finally {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  it('respects limit parameter for pagination', async () => {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const testProjectDir = join(projectsDir, '-codeman-test-limit');
    mkdirSync(testProjectDir, { recursive: true });
    const linkedPath = join(testProjectDir, `${harness.ctx._sessionId}.jsonl`);
    writeFileSync(linkedPath, sampleJsonl.map((e) => JSON.stringify(e)).join('\n') + '\n');

    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/conversation?limit=3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.messages).toHaveLength(3);
      expect(body.total).toBe(9);
      expect(body.hasMore).toBe(true);

      // Newest-first: last 3 messages
      const lastMsg = body.messages[0];
      expect(lastMsg.type).toBe('assistant');
      expect(lastMsg.content).toBe('All done!');
    } finally {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });

  it('supports before cursor for loading older messages', async () => {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const testProjectDir = join(projectsDir, '-codeman-test-cursor');
    mkdirSync(testProjectDir, { recursive: true });
    const linkedPath = join(testProjectDir, `${harness.ctx._sessionId}.jsonl`);
    writeFileSync(linkedPath, sampleJsonl.map((e) => JSON.stringify(e)).join('\n') + '\n');

    try {
      // First page
      const res1 = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/conversation?limit=3`,
      });
      const page1 = JSON.parse(res1.body);
      expect(page1.messages).toHaveLength(3);

      // Get the oldest index from page 1
      const oldestIndex = Math.min(...page1.messages.map((m: { index: number }) => m.index));

      // Second page using before cursor
      const res2 = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/conversation?limit=3&before=${oldestIndex}`,
      });
      const page2 = JSON.parse(res2.body);

      // Should get different messages
      expect(page2.messages).toHaveLength(3);
      const page2Indices = page2.messages.map((m: { index: number }) => m.index);
      page2Indices.forEach((idx: number) => expect(idx).toBeLessThan(oldestIndex));
    } finally {
      rmSync(testProjectDir, { recursive: true, force: true });
    }
  });
});
