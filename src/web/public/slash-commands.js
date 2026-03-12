/**
 * @fileoverview Shared slash command registry and autocomplete matching.
 * Provides the command list and fuzzy-prefix matching used by both the
 * conversation view input and the terminal zero-lag overlay.
 *
 * Command sources:
 *   1. Built-in Claude Code commands (/clear, /model, etc.)
 *   2. Global skills (~/.claude/skills/<name>/SKILL.md)
 *   3. User commands (~/.claude/commands/<name>.md)
 *   4. Project commands (<workingDir>/.claude/commands/<name>.md -> /project:name)
 *
 * @loadorder 5.5 — loaded after keyboard-accessory.js, before app.js
 */

// eslint-disable-next-line no-unused-vars
const SlashCommands = (() => {
  // ── Built-in Claude Code commands ────────────────────────────
  const BUILTIN = [
    { name: '/bug', desc: 'Report a bug' },
    { name: '/clear', desc: 'Clear conversation history' },
    { name: '/compact', desc: 'Compact conversation to save context' },
    { name: '/config', desc: 'Open configuration' },
    { name: '/cost', desc: 'Show token and cost usage' },
    { name: '/doctor', desc: 'Health check' },
    { name: '/help', desc: 'Show available commands' },
    { name: '/init', desc: 'Initialize CLAUDE.md' },
    { name: '/login', desc: 'Switch authentication' },
    { name: '/logout', desc: 'Log out' },
    { name: '/memory', desc: 'Edit CLAUDE.md' },
    { name: '/model', desc: 'Switch model' },
    { name: '/permissions', desc: 'Edit permissions' },
    { name: '/resume', desc: 'Resume a previous session' },
    { name: '/review', desc: 'Request code review' },
    { name: '/status', desc: 'Show session status' },
    { name: '/terminal-setup', desc: 'Configure terminal integration' },
    { name: '/vim', desc: 'Toggle vim keybindings' },
  ];

  /** @type {Array<{name: string, desc: string, type: string}>} */
  let customCommands = [];
  /** @type {string|null} Session ID used for last load (project commands are session-specific) */
  let loadedForSession = null;

  /**
   * Fetch custom commands from the API. Reloads when session changes
   * (project commands depend on the session's workingDir).
   * @param {string} [sessionId] - Current session ID for project command discovery
   */
  async function loadCustomCommands(sessionId) {
    // Reload if session changed (project commands may differ)
    if (customCommands.length > 0 && loadedForSession === (sessionId || null)) return;
    loadedForSession = sessionId || null;
    try {
      const url = sessionId
        ? '/api/slash-commands?session=' + encodeURIComponent(sessionId)
        : '/api/slash-commands';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const cmds = [];
      if (Array.isArray(data.skills)) {
        for (const s of data.skills) {
          cmds.push({ name: '/' + s.name, desc: s.description || '', type: 'skill' });
        }
      }
      if (Array.isArray(data.userCommands)) {
        for (const c of data.userCommands) {
          cmds.push({ name: '/' + c.name, desc: c.description || '', type: 'user' });
        }
      }
      if (Array.isArray(data.projectCommands)) {
        for (const c of data.projectCommands) {
          cmds.push({ name: '/' + c.name, desc: c.description || '', type: 'project' });
        }
      }
      customCommands = cmds;
    } catch {
      // Skills unavailable — proceed with builtins only
    }
  }

  /** All known commands (builtins + custom) */
  function allCommands() {
    return [...BUILTIN, ...customCommands];
  }

  /**
   * Match commands by prefix. Input should include the leading `/`.
   * @param {string} prefix - e.g. "/mo" or "/project:d"
   * @param {number} [limit=10]
   * @returns {Array<{name: string, desc: string, type?: string}>}
   */
  function match(prefix, limit = 10) {
    if (!prefix || prefix === '/') return allCommands().slice(0, limit);
    const lowerPrefix = prefix.toLowerCase();
    return allCommands()
      .filter(c => c.name.toLowerCase().startsWith(lowerPrefix))
      .sort((a, b) => {
        if (a.name.toLowerCase() === lowerPrefix) return -1;
        if (b.name.toLowerCase() === lowerPrefix) return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit);
  }

  /** Force reload on next call (e.g., after session switch) */
  function invalidate() {
    loadedForSession = null;
  }

  return { loadCustomCommands, match, allCommands, invalidate };
})();
