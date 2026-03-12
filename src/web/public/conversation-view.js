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
  /** @type {HTMLElement|null} Typing indicator element */
  let typingIndicator = null;
  /** @type {boolean} Whether the session is currently working (for stop button visibility) */
  let sessionBusy = false;
  /** @type {Map<string, string>} Draft input text per session — preserved across tab switches */
  const draftTextMap = new Map();

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
    // Build nested list structure from indent depths
    let out = '';
    const stack = []; // stack of { tag, indent }
    for (const item of listItems) {
      const tag = item.ordered ? 'ol' : 'ul';
      const depth = item.indent;
      // Close deeper levels
      while (stack.length > 0 && stack[stack.length - 1].indent > depth) {
        out += `</li></${stack.pop().tag}>`;
      }
      // Same level or switching list type at same level
      if (stack.length > 0 && stack[stack.length - 1].indent === depth) {
        if (stack[stack.length - 1].tag !== tag) {
          out += `</li></${stack.pop().tag}>`;
          out += `<${tag} class="cv-list">`;
          stack.push({ tag, indent: depth });
        } else {
          out += '</li>';
        }
      }
      // Open deeper level
      if (stack.length === 0 || stack[stack.length - 1].indent < depth) {
        out += `<${tag} class="cv-list">`;
        stack.push({ tag, indent: depth });
      }
      out += `<li>${renderInline(item.text)}`;
    }
    // Close remaining open tags
    while (stack.length > 0) {
      out += `</li></${stack.pop().tag}>`;
    }
    html.push(out);
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
        const indent = line.match(/^(\s*)/)[1].length;
        pendingList.push({ ordered: false, indent, text: line.replace(/^\s*[-*]\s/, '') });
        continue;
      }
      // Ordered list items
      if (/^\s*\d+\.\s/.test(line)) {
        const indent = line.match(/^(\s*)/)[1].length;
        pendingList.push({ ordered: true, indent, text: line.replace(/^\s*\d+\.\s/, '') });
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

      case 'system':
        return `<div class="cv-msg cv-system">
          <div class="cv-msg-label">System</div>
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
      syncTypingIndicator();
      syncStopButton();
    } catch (err) {
      console.error('[ConversationView] Failed to load messages:', err);
      if (messagesContainer) {
        messagesContainer.innerHTML = `<div class="cv-error-msg">Failed to load conversation: ${escapeHtml(String(err))}</div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  /** Scroll the messages container to the bottom (newest messages visible).
   *  Uses rAF to ensure browser layout has settled after DOM mutations —
   *  critical on mobile Safari where synchronous scrollTop after bulk
   *  insertion is unreliable. */
  function scrollToBottom() {
    if (!messagesContainer) return;
    // Immediate attempt (works on most desktop browsers)
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    // Deferred attempt after layout pass (needed on mobile Safari)
    requestAnimationFrame(() => {
      if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
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

    // Scroll to bottom (newest) — use rAF to ensure layout has settled
    // after bulk DOM insertion (especially important on mobile Safari).
    scrollToBottom();

    // Auto-expand subagent conversations
    autoExpandSubagents();
  }

  /** Auto-expand subagent conversations that haven't been loaded yet.
   *  After all subagent threads load, scroll to bottom so newest messages
   *  remain visible (subagent content adds height after initial scroll). */
  function autoExpandSubagents() {
    if (!messagesContainer) return;
    const btns = messagesContainer.querySelectorAll('.cv-subagent-btn');
    const loadPromises = [];
    btns.forEach((btn) => {
      // Only auto-load if no thread has been loaded yet
      const parent = btn.closest('.cv-agent-result');
      if (parent && !parent.querySelector('.cv-subagent-thread')) {
        const agentId = btn.dataset.agentId;
        if (agentId) {
          // Use a short delay to avoid blocking the initial render
          const p = new Promise((resolve) => {
            setTimeout(() => {
              ConversationView.loadSubagent(agentId, btn).then(resolve, resolve);
            }, 50);
          });
          loadPromises.push(p);
        }
      }
    });
    // After all subagent threads load, re-scroll to bottom
    if (loadPromises.length > 0) {
      Promise.all(loadPromises).then(() => scrollToBottom());
    }
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
              // Insert before typing indicator if visible, else append
              if (typingIndicator && typingIndicator.parentNode === messagesContainer) {
                messagesContainer.insertBefore(div.firstElementChild, typingIndicator);
              } else {
                messagesContainer.appendChild(div.firstElementChild);
              }
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

  // ─── Typing Indicator ─────────────────────────────────────────

  /** Create the typing indicator element (lazy, reused) */
  function ensureTypingIndicator() {
    if (typingIndicator) return;
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'cv-typing-indicator';
    typingIndicator.innerHTML =
      '<div class="cv-typing-dots">' +
      '<span class="cv-typing-dot"></span>' +
      '<span class="cv-typing-dot"></span>' +
      '<span class="cv-typing-dot"></span>' +
      '</div>' +
      '<span class="cv-typing-label">Claude is thinking</span>';
  }

  /** Show the typing indicator at the bottom of the messages list */
  function showTypingIndicator() {
    if (!messagesContainer || !isOpen) return;
    ensureTypingIndicator();
    if (typingIndicator.parentNode !== messagesContainer) {
      messagesContainer.appendChild(typingIndicator);
    }
    typingIndicator.classList.add('cv-typing-visible');
    // Auto-scroll if user is near the bottom
    const wasAtBottom =
      messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
      });
    }
  }

  /** Hide the typing indicator */
  function hideTypingIndicator() {
    if (typingIndicator) {
      typingIndicator.classList.remove('cv-typing-visible');
      setTimeout(() => {
        if (typingIndicator && !typingIndicator.classList.contains('cv-typing-visible')) {
          typingIndicator.remove();
        }
      }, 160);
    }
  }

  /** Sync typing indicator with current session status */
  function syncTypingIndicator() {
    if (!isOpen || !currentSessionId) return;
    if (typeof app === 'undefined') return;
    const session = app.sessions?.get(currentSessionId);
    if (session && (session.status === 'busy' || session.status === 'working')) {
      showTypingIndicator();
    } else {
      hideTypingIndicator();
    }
  }

  // ─── Stop Button ───────────────────────────────────────────────

  function showStopButton() {
    sessionBusy = true;
    const btn = panel?.querySelector('#cvStopBtn');
    if (btn) btn.style.display = '';
  }

  function hideStopButton() {
    sessionBusy = false;
    const btn = panel?.querySelector('#cvStopBtn');
    if (btn) {
      btn.style.display = 'none';
      btn.disabled = false;
    }
  }

  function syncStopButton() {
    if (!isOpen || !currentSessionId) return;
    if (typeof app === 'undefined') return;
    const session = app.sessions?.get(currentSessionId);
    if (session && (session.status === 'busy' || session.status === 'working')) {
      showStopButton();
    } else {
      hideStopButton();
    }
  }

  /** SSE handler: session:working → show indicator + stop button */
  function onSSEWorking(e) {
    if (!isOpen || !currentSessionId) return;
    try {
      const data = JSON.parse(e.data);
      if (data.id === currentSessionId) {
        showTypingIndicator();
        showStopButton();
      }
    } catch {
      /* ignore */
    }
  }

  /** SSE handler: session:idle → hide indicator + stop button */
  function onSSEIdle(e) {
    if (!isOpen || !currentSessionId) return;
    try {
      const data = JSON.parse(e.data);
      if (data.id === currentSessionId) {
        hideTypingIndicator();
        hideStopButton();
      }
    } catch {
      /* ignore */
    }
  }

  /** SSE handler: session:completion → hide indicator + stop button */
  function onSSECompletion(e) {
    if (!isOpen || !currentSessionId) return;
    try {
      const data = JSON.parse(e.data);
      if (data.id === currentSessionId) {
        hideTypingIndicator();
        hideStopButton();
      }
    } catch {
      /* ignore */
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
    // Typing indicator SSE events
    if (typeof app !== 'undefined' && app.eventSource) {
      app.eventSource.addEventListener('session:working', onSSEWorking);
      app.eventSource.addEventListener('session:idle', onSSEIdle);
      app.eventSource.addEventListener('session:completion', onSSECompletion);
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
      app.eventSource.removeEventListener('session:working', onSSEWorking);
      app.eventSource.removeEventListener('session:idle', onSSEIdle);
      app.eventSource.removeEventListener('session:completion', onSSECompletion);
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
        <div class="cv-header-right">
          <button class="cv-stop-btn" id="cvStopBtn" onclick="ConversationView.interruptSession()" title="Stop Claude (Ctrl+C)" style="display:none">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>
          </button>
          <button class="cv-close-btn" onclick="ConversationView.close()" title="Back to terminal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
          </button>
        </div>
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
        input.classList.toggle('cv-input-multiline', input.value.includes('\n'));
      });
      // Send on Enter (without Shift) — desktop only.
      // On mobile, Enter inserts a newline; the send button is the only way to send.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          const isMobile =
            typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice() && window.innerWidth < 1024;
          if (!isMobile) {
            e.preventDefault();
            if (input.value.trim()) ConversationView.sendMessage();
          }
        }
      });
    }

    // Adjust panel when iOS keyboard opens/closes so the input bar stays visible.
    // On iOS Safari, the virtual keyboard overlays content without changing dvh
    // or layout viewport height. We detect the keyboard via visualViewport.height
    // and switch the panel to position:fixed so it fills exactly the visible area.
    if (window.visualViewport) {
      let baseVVHeight = window.visualViewport.height;

      const adjustForKeyboard = () => {
        if (!isOpen || !panel) return;
        const vv = window.visualViewport;
        const keyboardOpen = vv.height < baseVVHeight - 100;

        if (keyboardOpen) {
          // Switch to fixed positioning — visualViewport coordinates are relative
          // to the initial containing block (same as position:fixed), so the math
          // is directly correct. This covers the tab bar, but it's unreachable
          // while typing anyway.
          panel.style.position = 'fixed';
          panel.style.top = vv.offsetTop + 'px';
          panel.style.height = vv.height + 'px';
          panel.style.left = '0';
          panel.style.right = '0';
          panel.style.bottom = 'auto';
        } else {
          // Keyboard closed — revert to absolute positioning within .main
          panel.style.position = '';
          panel.style.top = '';
          panel.style.height = '';
          panel.style.left = '';
          panel.style.right = '';
          panel.style.bottom = '';
          baseVVHeight = vv.height; // Update for orientation changes
        }

        // Hide keyboard accessory bar when conversation view is open —
        // it's designed for the terminal input, not the conversation input
        const accessory = document.querySelector('.keyboard-accessory-bar');
        if (accessory) accessory.style.display = 'none';

        // Ensure messages scroll so input stays visible
        if (keyboardOpen && messagesContainer) {
          requestAnimationFrame(() => {
            if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
          });
        }
      };
      window.visualViewport.addEventListener('resize', adjustForKeyboard);
      window.visualViewport.addEventListener('scroll', adjustForKeyboard);
    }
  }

  /** Save current input text into the draft map for the given session */
  function saveDraft(sessionId) {
    if (!sessionId || !panel) return;
    const input = panel.querySelector('#cvInput');
    if (input) draftTextMap.set(sessionId, input.value);
  }

  /** Restore draft text for a session (or clear if none saved) and sync textarea height + send button */
  function restoreDraft(sessionId) {
    if (!panel) return;
    const input = panel.querySelector('#cvInput');
    const sendBtn = panel.querySelector('#cvSendBtn');
    if (!input) return;
    const draft = (sessionId && draftTextMap.get(sessionId)) || '';
    input.value = draft;
    input.style.height = 'auto';
    if (draft) input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (sendBtn) sendBtn.disabled = !draft.trim();
    input.classList.toggle('cv-input-multiline', draft.includes('\n'));
  }

  // ─── Public API ─────────────────────────────────────────────

  return {
    open(sessionId) {
      sessionId = sessionId || (typeof app !== 'undefined' ? app.activeSessionId : null);
      if (!sessionId) return;

      ensurePanel();

      // Save draft text for the outgoing session before switching
      if (currentSessionId && currentSessionId !== sessionId) {
        saveDraft(currentSessionId);
      }

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

      // Restore any saved draft text for the incoming session
      restoreDraft(sessionId);
    },

    close() {
      if (!panel) return;

      // Preserve draft text so it survives close → reopen
      saveDraft(currentSessionId);

      isOpen = false;
      stopAutoRefresh();
      hideTypingIndicator();
      panel.style.display = 'none';

      // Restore terminal + toolbar + keyboard accessory
      const termContainer = document.getElementById('terminalContainer');
      const toolbar = document.querySelector('.toolbar');
      const accessory = document.querySelector('.keyboard-accessory-bar');
      if (termContainer) termContainer.style.display = '';
      if (toolbar) toolbar.style.display = '';
      if (accessory) accessory.style.display = '';
      // Reset panel inline styles set by keyboard handler
      panel.style.position = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.left = '';
      panel.style.right = '';
      panel.style.height = '';

      if (typeof app !== 'undefined') {
        // Mark as user-dismissed so tab switching doesn't auto-reopen CV
        app._forceTerminalView = true;

        const sid = app.activeSessionId;
        if (app.terminal && app.fitAddon) {
          // Wait for iOS Safari to fully reflow after display:none → display:''
          // before measuring dimensions. A single rAF isn't enough on iOS — the
          // layout may not have settled. 100ms timeout is reliable across devices.
          setTimeout(() => {
            try {
              app.fitAddon.fit();
            } catch {
              /* ignore */
            }
            // Send server resize so tmux/Ink redraws at correct dimensions
            if (sid) {
              const dims = app.fitAddon.proposeDimensions();
              if (dims) {
                fetch(`/api/sessions/${sid}/resize`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cols: Math.max(dims.cols, 40), rows: Math.max(dims.rows, 10) }),
                }).catch(() => {});
              }
            }
            // Load buffer if it wasn't loaded yet (mobile path skips buffer load).
            if (sid && app.terminal.buffer.active.length <= 1) {
              app.activeSessionId = null;
              app.selectSession(sid);
            }
          }, 150);
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
          draftTextMap.delete(currentSessionId);
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

    /** Send Ctrl+C interrupt to stop the active session */
    async interruptSession() {
      if (!currentSessionId) return;
      const btn = panel?.querySelector('#cvStopBtn');
      if (btn) btn.disabled = true;

      try {
        await fetch(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '\x03' }),
        });
      } catch (err) {
        console.error('[ConversationView] Interrupt failed:', err);
      }

      setTimeout(() => {
        if (btn) btn.disabled = false;
      }, 1500);
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
