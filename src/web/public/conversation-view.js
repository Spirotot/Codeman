/**
 * @fileoverview Conversation history view — renders Claude session history from JSONL transcripts
 * as a mobile-friendly scrollable panel with native touch scrolling.
 *
 * @dependency constants.js (SSE_EVENTS)
 * @dependency app.js (app.activeSessionId, app.fetchApi)
 * @loadorder 7.5 (after app.js, before api-client.js)
 */

// eslint-disable-next-line no-unused-vars
const ConversationView = (() => {
  /** @type {HTMLElement|null} */
  let panel = null;
  /** @type {HTMLElement|null} */
  let messagesContainer = null;
  /** @type {string|null} */
  let currentSessionId = null;
  /** @type {boolean} */
  let isOpen = false;
  /** @type {boolean} */
  let isLoading = false;
  /** @type {boolean} */
  let hasMore = false;
  /** @type {number|null} Oldest message index loaded (for pagination cursor) */
  let oldestIndex = null;
  /** @type {number} */
  let totalMessages = 0;
  /** @type {Set<string>} Expanded tool call IDs */
  const expandedTools = new Set();
  /** @type {Set<number>} Expanded thinking block indices */
  const expandedThinking = new Set();
  /** @type {Map<string, object>} Message data keyed by tool-use ID or index, for expand rendering */
  const msgDataStore = new Map();
  /** @type {number|null} Auto-refresh interval ID */
  let refreshTimer = null;

  const PAGE_SIZE = 80;

  // ─── Minimal Markdown Renderer ───────────────────────────────

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Check if a line is a markdown table separator (e.g. |---|:---:|---:| ) */
  function isTableSeparator(line) {
    return /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|?\s*$/.test(line.trim());
  }

  /** Parse a table row into cells (splits on | and trims) */
  function parseTableRow(line) {
    // Remove leading/trailing pipes, split on |
    const trimmed = line.trim().replace(/^\||\|$/g, '');
    return trimmed.split('|').map((c) => c.trim());
  }

  /** Parse column alignments from separator row */
  function parseTableAlign(line) {
    return parseTableRow(line).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
  }

  /** Render accumulated table rows into an HTML <table> */
  function renderTable(tableLines) {
    if (tableLines.length < 2) {
      // Not enough for header + separator — render as plain text
      return tableLines.map((l) => `<p class="cv-p">${renderInline(l)}</p>`).join('\n');
    }

    const hasSeparator = isTableSeparator(tableLines[1]);
    const aligns = hasSeparator ? parseTableAlign(tableLines[1]) : [];
    const headerCells = parseTableRow(tableLines[0]);
    const bodyStart = hasSeparator ? 2 : 1;

    let out = '<div class="cv-table-wrap"><table class="cv-table">';

    // Header
    if (hasSeparator) {
      out += '<thead><tr>';
      headerCells.forEach((cell, i) => {
        const align = aligns[i] && aligns[i] !== 'left' ? ` style="text-align:${aligns[i]}"` : '';
        out += `<th${align}>${renderInline(cell)}</th>`;
      });
      out += '</tr></thead>';
    }

    // Body
    out += '<tbody>';
    for (let i = hasSeparator ? 0 : 0, r = bodyStart; r < tableLines.length; r++) {
      const cells = parseTableRow(tableLines[r]);
      out += '<tr>';
      cells.forEach((cell, ci) => {
        const align = aligns[ci] && aligns[ci] !== 'left' ? ` style="text-align:${aligns[ci]}"` : '';
        out += `<td${align}>${renderInline(cell)}</td>`;
      });
      out += '</tr>';
    }
    out += '</tbody></table></div>';
    return out;
  }

  /** Flush accumulated list items into a proper <ul> or <ol> */
  function flushList(listItems, html) {
    if (listItems.length === 0) return;
    const isOrdered = listItems[0].ordered;
    const tag = isOrdered ? 'ol' : 'ul';
    html.push(`<${tag} class="cv-list">`);
    for (const item of listItems) {
      html.push(`<li>${renderInline(item.text)}</li>`);
    }
    html.push(`</${tag}>`);
    listItems.length = 0;
  }

  /** Flush accumulated table lines into rendered HTML */
  function flushTable(tableLines, html) {
    if (tableLines.length === 0) return;
    html.push(renderTable(tableLines));
    tableLines.length = 0;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const html = [];
    let inCodeBlock = false;
    let codeLang = '';
    let codeLines = [];
    let pendingList = []; // accumulated list items
    let pendingTable = []; // accumulated table lines

    for (const line of lines) {
      // Code block fence
      if (line.trimStart().startsWith('```')) {
        flushList(pendingList, html);
        flushTable(pendingTable, html);
        if (inCodeBlock) {
          html.push(
            `<pre class="cv-code"><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`
          );
          codeLines = [];
          inCodeBlock = false;
          codeLang = '';
        } else {
          inCodeBlock = true;
          codeLang = line.trimStart().slice(3).trim() || 'text';
        }
        continue;
      }
      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      // Table rows — accumulate consecutive lines starting with |
      if (line.trim().startsWith('|') && line.includes('|', line.indexOf('|') + 1)) {
        flushList(pendingList, html);
        pendingTable.push(line);
        continue;
      }
      if (pendingTable.length > 0) flushTable(pendingTable, html);

      // Headers
      const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
      if (headerMatch) {
        flushList(pendingList, html);
        const level = headerMatch[1].length;
        html.push(`<h${level} class="cv-h">${renderInline(headerMatch[2])}</h${level}>`);
        continue;
      }

      // Unordered list items
      if (/^\s*[-*]\s/.test(line)) {
        pendingList.push({ ordered: false, text: line.replace(/^\s*[-*]\s/, '') });
        continue;
      }
      // Ordered list items
      if (/^\s*\d+\.\s/.test(line)) {
        pendingList.push({ ordered: true, text: line.replace(/^\s*\d+\.\s/, '') });
        continue;
      }
      if (pendingList.length > 0) flushList(pendingList, html);

      // Horizontal rule
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        html.push('<hr class="cv-hr">');
        continue;
      }

      // Empty line
      if (!line.trim()) {
        html.push('<div class="cv-spacer"></div>');
        continue;
      }

      // Regular paragraph
      html.push(`<p class="cv-p">${renderInline(line)}</p>`);
    }

    // Flush any remaining accumulated blocks
    flushList(pendingList, html);
    flushTable(pendingTable, html);

    // Unclosed code block
    if (inCodeBlock && codeLines.length > 0) {
      html.push(`<pre class="cv-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    }

    return html.join('\n');
  }

  function renderInline(text) {
    let s = escapeHtml(text);
    // Bold
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code class="cv-inline-code">$1</code>');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  // ─── Tool Input Formatting ───────────────────────────────────

  function formatToolInput(toolName, input) {
    if (!input) return '';
    switch (toolName) {
      case 'Read':
        return input.file_path || '';
      case 'Edit':
        return input.file_path || '';
      case 'Write':
        return input.file_path || '';
      case 'Bash':
        return input.command ? `$ ${input.command}` : '';
      case 'Grep':
        return `/${input.pattern}/ ${input.path || ''}`;
      case 'Glob':
        return `${input.pattern} ${input.path || ''}`;
      case 'Agent':
        return input.description || input.prompt?.slice(0, 80) || '';
      case 'WebSearch':
        return input.query || '';
      case 'WebFetch':
        return input.url || '';
      default:
        // Show first string value as summary
        for (const v of Object.values(input)) {
          if (typeof v === 'string' && v.length < 120) return v;
        }
        return Object.keys(input).join(', ');
    }
  }

  function toolIcon(toolName) {
    const icons = {
      Read: '📖',
      Edit: '✏️',
      Write: '📝',
      Bash: '⚡',
      Grep: '🔍',
      Glob: '📁',
      Agent: '🤖',
      WebSearch: '🌐',
      WebFetch: '🌐',
      ToolSearch: '🔧',
    };
    return icons[toolName] || '🔧';
  }

  // ─── Message Rendering ──────────────────────────────────────

  function renderMessage(msg) {
    // Store data for later expand
    const storeKey = msg.toolUseId || `msg-${msg.index}`;
    msgDataStore.set(storeKey, msg);

    switch (msg.type) {
      case 'user':
        return `<div class="cv-msg cv-user">
          <div class="cv-msg-label">You</div>
          <div class="cv-msg-body">${renderMarkdown(msg.content)}</div>
        </div>`;

      case 'assistant':
        return `<div class="cv-msg cv-assistant">
          <div class="cv-msg-body">${renderMarkdown(msg.content)}</div>
        </div>`;

      case 'thinking': {
        const isExpanded = expandedThinking.has(msg.index);
        const preview = (msg.content || '').slice(0, 80).replace(/\n/g, ' ');
        return `<div class="cv-msg cv-thinking ${isExpanded ? 'expanded' : ''}" data-index="${msg.index}" data-key="${escapeHtml(storeKey)}">
          <div class="cv-thinking-toggle" onclick="ConversationView.toggleThinking(${msg.index})">
            <span class="cv-chevron">${isExpanded ? '▾' : '▸'}</span>
            <span class="cv-thinking-label">Thinking</span>
            ${!isExpanded ? `<span class="cv-thinking-preview">${escapeHtml(preview)}…</span>` : ''}
          </div>
          ${isExpanded ? `<div class="cv-thinking-content">${renderMarkdown(msg.content)}</div>` : ''}
        </div>`;
      }

      case 'tool_use': {
        const id = msg.toolUseId || `tool-${msg.index}`;
        const isExpanded = expandedTools.has(id);
        const summary = formatToolInput(msg.toolName, msg.toolInput);
        const isAgent = msg.toolName === 'Agent';
        return `<div class="cv-msg cv-tool ${isExpanded ? 'expanded' : ''} ${isAgent ? 'cv-agent' : ''}" data-tool-id="${escapeHtml(id)}">
          <div class="cv-tool-header" onclick="ConversationView.toggleTool('${escapeHtml(id)}')">
            <span class="cv-chevron">${isExpanded ? '▾' : '▸'}</span>
            <span class="cv-tool-icon">${toolIcon(msg.toolName)}</span>
            <span class="cv-tool-name">${escapeHtml(msg.toolName || '')}</span>
            <span class="cv-tool-summary">${escapeHtml(summary)}</span>
          </div>
          ${isExpanded ? `<div class="cv-tool-detail"><pre class="cv-code"><code>${escapeHtml(JSON.stringify(msg.toolInput, null, 2))}</code></pre></div>` : ''}
          ${isAgent && msg.agentDescription ? `<div class="cv-agent-desc">${escapeHtml(msg.agentDescription)}</div>` : ''}
        </div>`;
      }

      case 'tool_result': {
        const id = msg.toolUseId || `result-${msg.index}`;
        const isExpanded = expandedTools.has(id);
        if (!msg.content || !msg.content.trim()) return ''; // Skip empty results
        const preview = msg.content.split('\n')[0].slice(0, 80);
        const lineCount = msg.content.split('\n').length;
        // Check if this is an Agent tool result with a subagent ID
        const hasSubagent = !!msg.agentId;
        return `<div class="cv-msg cv-result ${isExpanded ? 'expanded' : ''} ${msg.isError ? 'cv-error' : ''} ${hasSubagent ? 'cv-agent-result' : ''}" data-tool-id="${escapeHtml(id)}"${hasSubagent ? ` data-agent-id="${escapeHtml(msg.agentId)}"` : ''}>
          <div class="cv-result-header" onclick="ConversationView.toggleTool('${escapeHtml(id)}')">
            <span class="cv-chevron">${isExpanded ? '▾' : '▸'}</span>
            <span class="cv-result-label">${hasSubagent ? '🤖 Agent launched' : msg.isError ? '✗ Error' : '✓ Result'}</span>
            <span class="cv-result-preview">${hasSubagent ? '' : `${escapeHtml(preview)}${lineCount > 1 ? ` (${lineCount} lines)` : ''}`}</span>
          </div>
          ${isExpanded ? `<pre class="cv-code cv-result-content"><code>${escapeHtml(msg.content)}</code></pre>` : ''}
          ${hasSubagent ? `<button class="cv-subagent-btn" onclick="ConversationView.loadSubagent('${escapeHtml(msg.agentId)}', this)" data-agent-id="${escapeHtml(msg.agentId)}">View subagent conversation</button>` : ''}
        </div>`;
      }

      default:
        return '';
    }
  }

  // ─── Data Loading ───────────────────────────────────────────

  async function loadMessages(sessionId, append) {
    if (isLoading) return;
    isLoading = true;

    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (append && oldestIndex !== null) {
      params.set('before', String(oldestIndex));
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/conversation?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      totalMessages = data.total;
      hasMore = data.hasMore;

      // Messages come newest-first from API
      const msgs = data.messages || [];
      if (msgs.length > 0) {
        oldestIndex = msgs[msgs.length - 1].index;
        if (msgs[0].index > newestIndex) newestIndex = msgs[0].index;
      }

      if (append && messagesContainer) {
        // Prepend older messages at the top
        const scrollBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop;
        const frag = document.createDocumentFragment();
        const wrapper = document.createElement('div');
        // Render in reverse so oldest is at top
        for (let i = msgs.length - 1; i >= 0; i--) {
          const html = renderMessage(msgs[i]);
          if (html) {
            const div = document.createElement('div');
            div.innerHTML = html;
            frag.appendChild(div.firstElementChild);
          }
        }
        // Insert load-more button replacement
        const existingBtn = messagesContainer.querySelector('.cv-load-more');
        if (existingBtn) existingBtn.remove();
        if (hasMore) {
          const loadMoreBtn = document.createElement('button');
          loadMoreBtn.className = 'cv-load-more';
          loadMoreBtn.textContent = `Load older messages (${totalMessages - msgs.length} remaining)`;
          loadMoreBtn.onclick = () => loadMessages(sessionId, true);
          messagesContainer.prepend(loadMoreBtn);
        }
        messagesContainer.prepend(frag);
        // Restore scroll position
        messagesContainer.scrollTop = messagesContainer.scrollHeight - scrollBottom;
      } else {
        renderAll(msgs);
      }

      updateHeader();
    } catch (err) {
      console.error('[ConversationView] Failed to load messages:', err);
      if (messagesContainer) {
        messagesContainer.innerHTML = `<div class="cv-error-msg">Failed to load conversation: ${escapeHtml(String(err))}</div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  function renderAll(msgs) {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = '';

    if (hasMore) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'cv-load-more';
      loadMoreBtn.textContent = 'Load older messages…';
      loadMoreBtn.onclick = () => loadMessages(currentSessionId, true);
      messagesContainer.appendChild(loadMoreBtn);
    }

    // Render in chronological order (API returns newest-first, so reverse)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const html = renderMessage(msgs[i]);
      if (html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        messagesContainer.appendChild(div.firstElementChild);
      }
    }

    // Scroll to bottom (newest)
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Auto-expand subagent conversations
    autoExpandSubagents();
  }

  /** Auto-expand subagent conversations that haven't been loaded yet */
  function autoExpandSubagents() {
    if (!messagesContainer) return;
    const btns = messagesContainer.querySelectorAll('.cv-subagent-btn');
    btns.forEach((btn) => {
      // Only auto-load if no thread has been loaded yet
      const parent = btn.closest('.cv-agent-result');
      if (parent && !parent.querySelector('.cv-subagent-thread')) {
        const agentId = btn.dataset.agentId;
        if (agentId) {
          // Use a short delay to avoid blocking the initial render
          setTimeout(() => ConversationView.loadSubagent(agentId, btn), 50);
        }
      }
    });
  }

  function updateHeader() {
    const countEl = panel?.querySelector('.cv-count');
    if (countEl) {
      countEl.textContent = `${totalMessages} messages`;
    }
  }

  /** @type {number} Newest message index we've seen */
  let newestIndex = 0;

  /** Debounce timer for SSE-triggered refresh */
  let refreshDebounce = null;

  /** Fetch and append new messages since our last known index */
  async function fetchNewMessages() {
    if (!isOpen || !currentSessionId || isLoading) return;
    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/conversation?limit=20`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.total > totalMessages) {
        const newMsgs = (data.messages || []).filter((m) => m.index > newestIndex);
        if (newMsgs.length > 0 && messagesContainer) {
          const wasAtBottom =
            messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 50;
          for (let i = newMsgs.length - 1; i >= 0; i--) {
            const html = renderMessage(newMsgs[i]);
            if (html) {
              const div = document.createElement('div');
              div.innerHTML = html;
              messagesContainer.appendChild(div.firstElementChild);
            }
            if (newMsgs[i].index > newestIndex) newestIndex = newMsgs[i].index;
          }
          totalMessages = data.total;
          updateHeader();
          if (wasAtBottom) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
          autoExpandSubagents();
        }
      }
    } catch {
      /* ignore fetch errors */
    }
  }

  /** Debounced refresh — coalesces rapid SSE events into a single fetch */
  function scheduleRefresh() {
    if (!isOpen) return;
    clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(fetchNewMessages, 200);
  }

  /** SSE handler for terminal output events */
  function onSSETerminalEvent(e) {
    if (!isOpen || !currentSessionId) return;
    try {
      const data = JSON.parse(e.data);
      if (data.sessionId === currentSessionId) {
        scheduleRefresh();
      }
    } catch {
      /* ignore parse errors */
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    // Listen to SSE events for real-time updates
    if (typeof app !== 'undefined' && app.eventSource) {
      app.eventSource.addEventListener('session:terminal', onSSETerminalEvent);
      app.eventSource.addEventListener('session:completion', onSSETerminalEvent);
      app.eventSource.addEventListener('session:idle', onSSETerminalEvent);
    }
    // Fallback: poll every 10s in case SSE events are missed
    refreshTimer = setInterval(fetchNewMessages, 10000);
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    clearTimeout(refreshDebounce);
    if (typeof app !== 'undefined' && app.eventSource) {
      app.eventSource.removeEventListener('session:terminal', onSSETerminalEvent);
      app.eventSource.removeEventListener('session:completion', onSSETerminalEvent);
      app.eventSource.removeEventListener('session:idle', onSSETerminalEvent);
    }
  }

  // ─── DOM Setup ──────────────────────────────────────────────

  function ensurePanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'conversationPanel';
    panel.className = 'cv-panel';
    panel.innerHTML = `
      <div class="cv-header">
        <div class="cv-header-left">
          <span class="cv-title">Conversation</span>
          <span class="cv-count"></span>
        </div>
        <div class="cv-header-right"></div>
      </div>
      <div class="cv-messages" id="cvMessages"></div>
      <div class="cv-input-bar">
        <textarea class="cv-input" id="cvInput" rows="1" placeholder="Send a message…" autocomplete="off" autocorrect="on" spellcheck="true"></textarea>
        <button class="cv-send-btn" id="cvSendBtn" onclick="ConversationView.sendMessage()" title="Send" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
        </button>
      </div>
    `;

    // Insert inside .main alongside the terminal container
    const main = document.querySelector('.main');
    if (main) {
      main.appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }

    messagesContainer = panel.querySelector('#cvMessages');

    // Wire up the input bar
    const input = panel.querySelector('#cvInput');
    const sendBtn = panel.querySelector('#cvSendBtn');
    if (input) {
      // Auto-grow textarea
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        sendBtn.disabled = !input.value.trim();
      });
      // Send on Enter (without Shift)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (input.value.trim()) ConversationView.sendMessage();
        }
      });
    }

    // Adjust panel when iOS keyboard opens/closes so the input bar stays visible.
    // With interactive-widget=overlays-content + 100dvh, the panel auto-resizes
    // on modern iOS. The visualViewport listener is a fallback for older iOS and
    // ensures the keyboard-accessory-bar stays hidden while the CV is open.
    if (window.visualViewport) {
      const adjustForKeyboard = () => {
        if (!isOpen || !panel) return;
        const vvh = window.visualViewport.height;
        const vvTop = window.visualViewport.offsetTop;
        // Fallback: if dvh isn't working, set explicit height
        panel.style.height = vvh + 'px';
        panel.style.top = vvTop + 'px';
        // Hide keyboard accessory bar when conversation view is open —
        // it's designed for the terminal input, not the conversation input
        const accessory = document.querySelector('.keyboard-accessory-bar');
        if (accessory) accessory.style.display = 'none';
        // Scroll input into view if keyboard obscures it
        const input = panel.querySelector('#cvInput');
        if (input && document.activeElement === input) {
          requestAnimationFrame(() => input.scrollIntoView({ block: 'nearest' }));
        }
      };
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  return {
    open(sessionId) {
      sessionId = sessionId || (typeof app !== 'undefined' ? app.activeSessionId : null);
      if (!sessionId) return;

      ensurePanel();
      currentSessionId = sessionId;
      oldestIndex = null;
      newestIndex = 0;
      hasMore = false;
      expandedTools.clear();
      expandedThinking.clear();
      msgDataStore.clear();
      isOpen = true;

      // Hide terminal, show conversation. On mobile, also hide the toolbar
      // (position:fixed at bottom) to prevent it from covering the input bar.
      const termContainer = document.getElementById('terminalContainer');
      const welcome = document.getElementById('welcomeOverlay');
      const toolbar = document.querySelector('.toolbar');
      const isMobile =
        typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice() && window.innerWidth < 1024;
      if (termContainer) termContainer.style.display = 'none';
      if (welcome) welcome.style.display = 'none';
      if (toolbar && isMobile) toolbar.style.display = 'none';
      // Hide keyboard accessory bar (it's for terminal input, not conversation input)
      const accessory = document.querySelector('.keyboard-accessory-bar');
      if (accessory && isMobile) accessory.style.display = 'none';
      panel.style.display = 'flex';

      loadMessages(sessionId, false);
      startAutoRefresh();
    },

    close() {
      if (!panel) return;
      isOpen = false;
      stopAutoRefresh();
      panel.style.display = 'none';

      // Restore terminal + toolbar + keyboard accessory
      const termContainer = document.getElementById('terminalContainer');
      const toolbar = document.querySelector('.toolbar');
      const accessory = document.querySelector('.keyboard-accessory-bar');
      if (termContainer) termContainer.style.display = '';
      if (toolbar) toolbar.style.display = '';
      if (accessory) accessory.style.display = '';
      // Reset panel inline styles set by keyboard handler
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.height = '';

      if (typeof app !== 'undefined') {
        if (app.terminal) {
          // Refit terminal
          if (app.fitAddon)
            try {
              app.fitAddon.fit();
            } catch {
              /* ignore */
            }
          // Load buffer if it wasn't loaded yet (mobile path skips buffer load).
          // Set _forceTerminalView so selectSession doesn't re-open conversation view,
          // then temporarily clear activeSessionId so the guard passes.
          const sid = app.activeSessionId;
          if (sid && app.terminal.buffer.active.length <= 1) {
            app._forceTerminalView = true;
            app.activeSessionId = null;
            app.selectSession(sid);
          }
        }
        app._updateConversationToggleBtn();
      }
    },

    toggle(sessionId) {
      if (isOpen) {
        this.close();
      } else {
        this.open(sessionId);
      }
    },

    isOpen() {
      return isOpen;
    },

    /** Send a message to the active session via the input API */
    async sendMessage() {
      const input = panel?.querySelector('#cvInput');
      const sendBtn = panel?.querySelector('#cvSendBtn');
      if (!input || !currentSessionId) return;

      const text = input.value.trim();
      if (!text) return;

      // Disable while sending
      input.disabled = true;
      if (sendBtn) sendBtn.disabled = true;

      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: text + '\r', useMux: true }),
        });

        if (res.ok) {
          // Optimistically render the user message immediately
          if (messagesContainer) {
            const div = document.createElement('div');
            div.className = 'cv-msg cv-user';
            div.innerHTML = `<div class="cv-msg-label">You</div><div class="cv-msg-body">${renderMarkdown(text)}</div>`;
            messagesContainer.appendChild(div);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
          input.value = '';
          input.style.height = 'auto';
        } else {
          console.error('[ConversationView] Send failed:', res.status);
        }
      } catch (err) {
        console.error('[ConversationView] Send error:', err);
      } finally {
        input.disabled = false;
        if (sendBtn) sendBtn.disabled = true; // Reset until next input
        input.focus();
      }
    },

    refresh() {
      if (!currentSessionId) return;
      oldestIndex = null;
      hasMore = false;
      loadMessages(currentSessionId, false);
    },

    /** Called when the active session changes */
    onSessionChanged(newSessionId) {
      if (isOpen && newSessionId !== currentSessionId) {
        this.open(newSessionId);
      }
    },

    toggleTool(toolId) {
      const isNowExpanded = !expandedTools.has(toolId);
      if (isNowExpanded) {
        expandedTools.add(toolId);
      } else {
        expandedTools.delete(toolId);
      }
      if (!messagesContainer) return;
      const els = messagesContainer.querySelectorAll(`[data-tool-id="${CSS.escape(toolId)}"]`);
      const storedMsg = msgDataStore.get(toolId);

      els.forEach((el) => {
        const chevron = el.querySelector('.cv-chevron');
        if (isNowExpanded) {
          el.classList.add('expanded');
          if (chevron) chevron.textContent = '▾';
          if (!el.querySelector('.cv-tool-detail, .cv-result-content')) {
            if (el.classList.contains('cv-tool') && storedMsg?.toolInput) {
              const d = document.createElement('div');
              d.className = 'cv-tool-detail';
              d.innerHTML = `<pre class="cv-code"><code>${escapeHtml(JSON.stringify(storedMsg.toolInput, null, 2))}</code></pre>`;
              el.appendChild(d);
            } else if (el.classList.contains('cv-result') && storedMsg?.content) {
              const d = document.createElement('pre');
              d.className = 'cv-code cv-result-content';
              d.innerHTML = `<code>${escapeHtml(storedMsg.content)}</code>`;
              el.appendChild(d);
            }
          }
        } else {
          el.classList.remove('expanded');
          if (chevron) chevron.textContent = '▸';
          const detail = el.querySelector('.cv-tool-detail, .cv-result-content');
          if (detail) detail.remove();
        }
      });
    },

    /** Load and render a subagent's conversation inline below its parent result */
    async loadSubagent(agentId, btnEl) {
      if (!currentSessionId || !btnEl) return;
      const parent = btnEl.closest('.cv-agent-result');
      if (!parent) return;

      // Toggle: if already loaded, toggle visibility
      const existing = parent.querySelector('.cv-subagent-thread');
      if (existing) {
        const isHidden = existing.style.display === 'none';
        existing.style.display = isHidden ? '' : 'none';
        btnEl.textContent = isHidden ? 'Hide subagent conversation' : 'View subagent conversation';
        return;
      }

      btnEl.textContent = 'Loading…';
      btnEl.disabled = true;

      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/conversation?subagent=${agentId}&limit=200`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const msgs = data.messages || [];

        const thread = document.createElement('div');
        thread.className = 'cv-subagent-thread';

        const threadHeader = document.createElement('div');
        threadHeader.className = 'cv-subagent-header';
        threadHeader.innerHTML = `<span class="cv-subagent-label">Subagent (${msgs.length} messages)</span>`;
        thread.appendChild(threadHeader);

        // Render in chronological order (API returns newest-first)
        for (let i = msgs.length - 1; i >= 0; i--) {
          const html = renderMessage(msgs[i]);
          if (html) {
            const div = document.createElement('div');
            div.innerHTML = html;
            thread.appendChild(div.firstElementChild);
          }
        }

        parent.appendChild(thread);
        btnEl.textContent = 'Hide subagent conversation';
        btnEl.disabled = false;
      } catch (err) {
        console.error('[ConversationView] Failed to load subagent:', err);
        btnEl.textContent = 'Failed to load — tap to retry';
        btnEl.disabled = false;
      }
    },

    toggleThinking(index) {
      const isNowExpanded = !expandedThinking.has(index);
      if (isNowExpanded) {
        expandedThinking.add(index);
      } else {
        expandedThinking.delete(index);
      }
      if (!messagesContainer) return;
      const el = messagesContainer.querySelector(`[data-index="${index}"]`);
      if (!el) return;
      const chevron = el.querySelector('.cv-chevron');
      const preview = el.querySelector('.cv-thinking-preview');
      const storeKey = el.dataset.key || `msg-${index}`;
      const storedMsg = msgDataStore.get(storeKey);

      if (isNowExpanded) {
        el.classList.add('expanded');
        if (chevron) chevron.textContent = '▾';
        if (preview) preview.style.display = 'none';
        if (!el.querySelector('.cv-thinking-content') && storedMsg?.content) {
          const d = document.createElement('div');
          d.className = 'cv-thinking-content';
          d.innerHTML = renderMarkdown(storedMsg.content);
          el.appendChild(d);
        }
      } else {
        el.classList.remove('expanded');
        if (chevron) chevron.textContent = '▸';
        if (preview) preview.style.display = '';
        const content = el.querySelector('.cv-thinking-content');
        if (content) content.remove();
      }
    },
  };
})();
