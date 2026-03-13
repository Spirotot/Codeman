#!/usr/bin/env node
/**
 * Codeman MCP Server — exposes tools for Claude to manage its own Codeman session.
 *
 * Spawned by Claude Code as a stdio MCP server. Reads CODEMAN_API_URL and
 * CODEMAN_SESSION_ID from the environment (set automatically by Codeman).
 *
 * Tools:
 *   - set_tab_title: Rename this session's tab in the Codeman UI
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport, newline-delimited)
 */

const API_URL = process.env.CODEMAN_API_URL;
const SESSION_ID = process.env.CODEMAN_SESSION_ID;

// Codeman often runs HTTPS with a self-signed cert on localhost
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- stdio JSON-RPC transport ---

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // Malformed JSON — skip
      }
    }
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// --- MCP protocol handlers ---

function handleMessage(msg) {
  // Notifications (no id) — acknowledge silently
  if (msg.id === undefined) return;

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'codeman', version: '1.0.0' },
        },
      });
      break;

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'set_tab_title',
              description:
                "Set the title of this session's tab in the Codeman web UI. " +
                'Use this to give the tab a meaningful name that reflects what you are working on.',
              inputSchema: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    description: 'The new tab title (max 128 characters)',
                  },
                },
                required: ['title'],
              },
            },
          ],
        },
      });
      break;

    case 'tools/call':
      handleToolCall(msg);
      break;

    default:
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

async function handleToolCall(msg) {
  const { name, arguments: args } = msg.params;

  if (name !== 'set_tab_title') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      },
    });
    return;
  }

  if (!API_URL || !SESSION_ID) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          {
            type: 'text',
            text: 'Error: CODEMAN_API_URL or CODEMAN_SESSION_ID env vars not set. Is this running inside a Codeman session?',
          },
        ],
        isError: true,
      },
    });
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/sessions/${SESSION_ID}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.title }),
    });
    const data = await res.json();
    if (data.success) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Tab title set to: ${data.name}` }],
        },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Error: ${data.error || 'Unknown error'}` }],
          isError: true,
        },
      });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      },
    });
  }
}
