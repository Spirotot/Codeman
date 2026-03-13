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
  /** @type {string|null} */
  let currentSessionId = null;
  /** @type {boolean} */
  let isOpen = false;
  /** @type {boolean} */
  let isLoading = false;
  /** @type {number|null} Auto-refresh interval ID */
  let refreshTimer = null;
  /** @type {HTMLElement|null} Typing indicator element */
  let typingIndicator = null;
  /** @type {boolean} Whether the session is currently working (for stop button visibility) */
  let sessionBusy = false;
  /** @type {Map<string, string>} Draft input text per session — preserved across tab switches */
  const draftTextMap = new Map();

  // ─── Per-session DOM cache ─────────────────────────────────
  // Each session gets its own messages container + pagination state.
  // Tab switching hides/shows cached containers — no re-fetch, no rebuild,
  // scroll position naturally preserved.

  /** @type {Map<string, {el: HTMLElement, oldestIndex: number|null, newestIndex: number, totalMessages: number, hasMore: boolean, expandedTools: Set<string>, expandedThinking: Set<number>, expandedSystem: Set<number>, msgDataStore: Map<string, object>, savedScrollTop: number}>} */
  const sessionCache = new Map();

  /** Get or create the cache entry for a session */
  function getCache(sessionId) {
    let c = sessionCache.get(sessionId);
    if (!c) {
      const el = document.createElement('div');
      el.className = 'cv-messages';
      el.id = 'cvMessages-' + sessionId;
      el.style.display = 'none';
      c = { el, oldestIndex: null, newestIndex: 0, totalMessages: 0, hasMore: false, expandedTools: new Set(), expandedThinking: new Set(), expandedSystem: new Set(), msgDataStore: new Map(), savedScrollTop: -1 };
      sessionCache.set(sessionId, c);
    }
    return c;
  }

  /** @type {HTMLElement|null} Points to the active session's cached messages container */
  let messagesContainer = null;

  /** Shorthand to get the active cache entry */
  function activeCache() {
    return currentSessionId ? sessionCache.get(currentSessionId) : null;
  }

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

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
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
      // Empty line — if a list is pending, swallow blank lines that are followed
      // by more list items (loose list style). Without this, each item separated
      // by a blank line gets its own <ol>, resetting the counter to 1 every time.
      if (!line.trim()) {
        if (pendingList.length > 0) {
          let nextIsListItem = false;
          for (let look = li + 1; look < lines.length; look++) {
            if (!lines[look].trim()) continue;
            nextIsListItem = /^\s*[-*]\s/.test(lines[look]) || /^\s*\d+\.\s/.test(lines[look]);
            break;
          }
          if (nextIsListItem) continue;
          flushList(pendingList, html);
        }
        html.push('<div class="cv-spacer"></div>');
        continue;
      }

      if (pendingList.length > 0) flushList(pendingList, html);

      // Horizontal rule
      if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
        html.push('<hr class="cv-hr">');
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

  // ─── AskUserQuestion Rendering ─────────────────────────────────

  function renderAskUserQuestion(msg) {
    const questions = msg.toolInput.questions;
    let html = '<div class="cv-msg cv-ask">';
    html += '<div class="cv-ask-icon">❓</div>';
    for (const q of questions) {
      if (q.header) html += `<div class="cv-ask-header">${escapeHtml(q.header)}</div>`;
      html += `<div class="cv-ask-question">${escapeHtml(q.question)}</div>`;
      if (q.options && q.options.length) {
        html += '<div class="cv-ask-options">';
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i];
          html += `<div class="cv-ask-option" onclick="ConversationView.selectOption(${i}, ${q.options.length})" role="button" tabindex="0">`;
          html += `<span class="cv-ask-option-label">${escapeHtml(opt.label)}</span>`;
          if (opt.description) html += `<span class="cv-ask-option-desc">${escapeHtml(opt.description)}</span>`;
          html += '</div>';
        }
        html += '</div>';
      }
    }
    html += '</div>';
    return html;
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

  /** Derive a short label for collapsed system messages */
  function systemLabel(content) {
    if (!content) return 'System';
    if (content.startsWith('Base directory for this skill:')) {
      const match = content.match(/skills\/([^/\n]+)/);
      return match ? `Skill: ${match[1]}` : 'Skill';
    }
    if (content.startsWith('<command-name>/')) return 'Command';
    if (content.startsWith('<local-command-stdout>')) return 'Command output';
    if (content.startsWith('This session is being continued')) return 'Compaction summary';
    if (content.startsWith('<system-reminder>')) return 'System reminder';
    if (content.startsWith('<teammate-message')) return 'Teammate';
    if (content.startsWith('<task-notification>')) return 'Task notification';
    return 'System';
  }

  // ─── Message Rendering ──────────────────────────────────────

  function renderMessage(msg, cache) {
    // Store data for later expand — use the explicitly-passed cache so that
    // async callers (loadMessages, fetchNewMessages) route to the correct
    // session even if currentSessionId has changed since the fetch started.
    if (cache === undefined) cache = activeCache();
    const storeKey = msg.toolUseId || `msg-${msg.index}`;
    if (cache) cache.msgDataStore.set(storeKey, msg);

    switch (msg.type) {
      case 'user':
        return `<div class="cv-msg cv-user">
          <div class="cv-msg-label">You</div>
          <div class="cv-msg-body">${renderMarkdown(msg.content)}</div>
        </div>`;

      case 'system': {
        const isExpanded = cache ? cache.expandedSystem.has(msg.index) : false;
        const sysLabel = systemLabel(msg.content);
        const preview = (msg.content || '').replace(/^Base directory for this skill:[^\n]*\n+(?:#[^\n]*\n+)?/, '').slice(0, 80).replace(/\n/g, ' ');
        return `<div class="cv-msg cv-system ${isExpanded ? 'expanded' : ''}" data-index="${msg.index}" data-key="${escapeHtml(storeKey)}">
          <div class="cv-system-toggle" onclick="ConversationView.toggleSystem(${msg.index})">
            <span class="cv-chevron">${isExpanded ? '▾' : '▸'}</span>
            <span class="cv-system-label">${escapeHtml(sysLabel)}</span>
            ${!isExpanded ? `<span class="cv-system-preview">${escapeHtml(preview)}${preview.length >= 80 ? '…' : ''}</span>` : ''}
          </div>
          ${isExpanded ? `<div class="cv-system-content">${renderMarkdown(msg.content)}</div>` : ''}
        </div>`;
      }

      case 'assistant':
        return `<div class="cv-msg cv-assistant">
          <div class="cv-msg-body">${renderMarkdown(msg.content)}</div>
        </div>`;

      case 'thinking': {
        const isExpanded = cache ? cache.expandedThinking.has(msg.index) : false;
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
        // AskUserQuestion gets a special card rendering
        if (msg.toolName === 'AskUserQuestion' && msg.toolInput?.questions) {
          return renderAskUserQuestion(msg);
        }
        const id = msg.toolUseId || `tool-${msg.index}`;
        const isExpanded = cache ? cache.expandedTools.has(id) : false;
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
        const isExpanded = cache ? cache.expandedTools.has(id) : false;
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

    const cache = getCache(sessionId);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (append && cache.oldestIndex !== null) {
      params.set('before', String(cache.oldestIndex));
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/conversation?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      cache.totalMessages = data.total;
      cache.hasMore = data.hasMore;

      // Messages come newest-first from API
      const msgs = data.messages || [];
      if (msgs.length > 0) {
        cache.oldestIndex = msgs[msgs.length - 1].index;
        if (msgs[0].index > cache.newestIndex) cache.newestIndex = msgs[0].index;
      }

      // Guard: if the user switched sessions while the fetch was in-flight,
      // the module-level messagesContainer now points to a different session.
      // Only mutate the DOM if it still belongs to this fetch's session.
      const targetContainer = cache.el;
      if (append && targetContainer.parentNode) {
        // Prepend older messages at the top
        const scrollBottom = targetContainer.scrollHeight - targetContainer.scrollTop;
        const frag = document.createDocumentFragment();
        for (let i = msgs.length - 1; i >= 0; i--) {
          const html = renderMessage(msgs[i], cache);
          if (html) {
            const div = document.createElement('div');
            div.innerHTML = html;
            frag.appendChild(div.firstElementChild);
          }
        }
        const existingBtn = targetContainer.querySelector('.cv-load-more');
        if (existingBtn) existingBtn.remove();
        if (cache.hasMore) {
          const loadMoreBtn = document.createElement('button');
          loadMoreBtn.className = 'cv-load-more';
          loadMoreBtn.textContent = `Load older messages (${cache.totalMessages - msgs.length} remaining)`;
          loadMoreBtn.onclick = () => loadMessages(sessionId, true);
          targetContainer.prepend(loadMoreBtn);
        }
        targetContainer.prepend(frag);
        targetContainer.scrollTop = targetContainer.scrollHeight - scrollBottom;
      } else {
        renderAll(msgs, cache);
      }

      updateHeader();
      syncTypingIndicator();
      syncStopButton();

      // Scroll to bottom after initial load — instant, not smooth
      if (!append && targetContainer.parentNode) {
        targetContainer.style.scrollBehavior = 'auto';
        targetContainer.scrollTop = targetContainer.scrollHeight;
        requestAnimationFrame(() => {
          targetContainer.scrollTop = targetContainer.scrollHeight;
          targetContainer.style.scrollBehavior = '';
        });
      }
    } catch (err) {
      console.error('[ConversationView] Failed to load messages:', err);
      if (cache.el.parentNode) {
        cache.el.innerHTML = `<div class="cv-error-msg">Failed to load conversation: ${escapeHtml(String(err))}</div>`;
      }
    } finally {
      isLoading = false;
    }
  }

  /** Check if user is near the bottom of the messages container */
  function isNearBottom() {
    if (!messagesContainer) return true;
    const dist = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    return dist < 80;
  }

  function renderAll(msgs, cache) {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = '';

    if (cache && cache.hasMore) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.className = 'cv-load-more';
      loadMoreBtn.textContent = 'Load older messages…';
      loadMoreBtn.onclick = () => loadMessages(currentSessionId, true);
      messagesContainer.appendChild(loadMoreBtn);
    }

    // Render in chronological order (API returns newest-first, so reverse)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const html = renderMessage(msgs[i], cache);
      if (html) {
        const div = document.createElement('div');
        div.innerHTML = html;
        messagesContainer.appendChild(div.firstElementChild);
      }
    }

    autoExpandSubagents();
  }

  /** Auto-expand subagent conversations that haven't been loaded yet. */
  function autoExpandSubagents() {
    if (!messagesContainer) return;
    const btns = messagesContainer.querySelectorAll('.cv-subagent-btn');
    btns.forEach((btn) => {
      const parent = btn.closest('.cv-agent-result');
      if (parent && !parent.querySelector('.cv-subagent-thread')) {
        const agentId = btn.dataset.agentId;
        if (agentId) {
          setTimeout(() => ConversationView.loadSubagent(agentId, btn), 50);
        }
      }
    });
  }

  function updateHeader() {
    const cache = activeCache();
    const countEl = panel?.querySelector('.cv-count');
    if (countEl) {
      countEl.textContent = `${cache ? cache.totalMessages : 0} messages`;
    }
  }

  /** Debounce timer for SSE-triggered refresh */
  let refreshDebounce = null;

  /** Fetch and append new messages since our last known index */
  async function fetchNewMessages() {
    if (!isOpen || !currentSessionId || isLoading) return;
    // Snapshot session identity and container BEFORE the async fetch.
    // If the user switches sessions while the request is in-flight these
    // captures let us detect staleness and bail out instead of corrupting
    // the newly-active session's view.
    const fetchSessionId = currentSessionId;
    const cache = activeCache();
    if (!cache) return;
    const targetContainer = cache.el;
    try {
      const res = await fetch(`/api/sessions/${fetchSessionId}/conversation?limit=20`);
      if (!res.ok) return;
      // Guard: session changed while we were waiting for the response.
      if (currentSessionId !== fetchSessionId) return;
      const data = await res.json();
      if (data.total > cache.totalMessages) {
        const newMsgs = (data.messages || []).filter((m) => m.index > cache.newestIndex);
        if (newMsgs.length > 0 && targetContainer.parentNode) {
          const wasAtBottom = isNearBottom();
          for (let i = newMsgs.length - 1; i >= 0; i--) {
            const html = renderMessage(newMsgs[i], cache);
            if (html) {
              const div = document.createElement('div');
              div.innerHTML = html;
              if (typingIndicator && typingIndicator.parentNode === targetContainer) {
                targetContainer.insertBefore(div.firstElementChild, typingIndicator);
              } else {
                targetContainer.appendChild(div.firstElementChild);
              }
            }
            if (newMsgs[i].index > cache.newestIndex) cache.newestIndex = newMsgs[i].index;
          }
          cache.totalMessages = data.total;
          updateHeader();
          autoExpandSubagents();
          if (wasAtBottom) {
            targetContainer.scrollTop = targetContainer.scrollHeight;
          }
        }
      }
      // Sync typing indicator + stop button on every poll — more reliable than
      // relying solely on SSE events which can be missed or arrive out of order.
      syncTypingIndicator();
      syncStopButton();
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
      <div class="cv-messages-wrapper" id="cvMessagesWrapper">
        <button class="cv-scroll-bottom" id="cvScrollBottom" onclick="ConversationView.scrollToBottom()" title="Scroll to bottom" style="display:none">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
      <div class="cv-input-bar">
        <div class="cv-slash-dropdown" id="cvSlashDropdown" style="display:none"></div>
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

    // messagesContainer is set per-session in open() via sessionCache

    // Wire up the input bar
    const input = panel.querySelector('#cvInput');
    const sendBtn = panel.querySelector('#cvSendBtn');
    const slashDropdown = panel.querySelector('#cvSlashDropdown');
    let slashSelectedIndex = 0;
    let slashResults = [];

    function updateSlashDropdown() {
      const text = input.value;
      // Show dropdown when text is just a slash command prefix (no spaces = still typing the command)
      const slashMatch = text.match(/^\/(\S*)$/);
      if (!slashMatch || typeof SlashCommands === 'undefined') {
        slashDropdown.style.display = 'none';
        slashResults = [];
        return;
      }
      slashResults = SlashCommands.match('/' + slashMatch[1], 12);
      if (slashResults.length === 0) {
        slashDropdown.style.display = 'none';
        return;
      }
      slashSelectedIndex = Math.min(slashSelectedIndex, slashResults.length - 1);
      slashDropdown.innerHTML = slashResults.map((cmd, i) =>
        `<div class="cv-slash-item${i === slashSelectedIndex ? ' selected' : ''}" data-index="${i}">` +
        `<span class="cv-slash-name">${cmd.name}</span>` +
        `<span class="cv-slash-desc">${cmd.desc}</span>` +
        `</div>`
      ).join('');
      slashDropdown.style.display = '';
    }

    function acceptSlashCompletion() {
      if (!slashResults.length) return false;
      const cmd = slashResults[slashSelectedIndex];
      if (cmd) {
        input.value = cmd.name + ' ';
        input.dispatchEvent(new Event('input'));
        slashDropdown.style.display = 'none';
        slashResults = [];
      }
      return true;
    }

    if (input) {
      // Auto-grow textarea — keep messages scrolled to bottom when input bar grows.
      // Avoid setting height='auto' first (causes layout reflow jitter in flex containers).
      // Instead, temporarily hide overflow, shrink to 0 to measure scrollHeight, then set
      // the final height — the browser batches the writes into a single paint.
      let lastInputHeight = 0;
      input.addEventListener('input', () => {
        const wasNearBottom = isNearBottom();
        // Hide overflow during measurement so content doesn't flash at height:0
        input.style.overflow = 'hidden';
        input.style.height = '0';
        const target = Math.min(input.scrollHeight, 120);
        input.style.height = target + 'px';
        // Restore scroll when content exceeds max-height
        input.style.overflow = input.scrollHeight > 120 ? 'auto' : 'hidden';
        const heightChanged = target !== lastInputHeight;
        lastInputHeight = target;
        sendBtn.disabled = !input.value.trim();
        input.classList.toggle('cv-input-multiline', input.value.includes('\n'));
        updateSlashDropdown();
        if (heightChanged && wasNearBottom && messagesContainer) {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      });
      // Keyboard navigation for slash dropdown + send on Enter
      input.addEventListener('keydown', (e) => {
        // Slash dropdown navigation
        if (slashResults.length > 0 && slashDropdown.style.display !== 'none') {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            slashSelectedIndex = (slashSelectedIndex + 1) % slashResults.length;
            updateSlashDropdown();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            slashSelectedIndex = (slashSelectedIndex - 1 + slashResults.length) % slashResults.length;
            updateSlashDropdown();
            return;
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            acceptSlashCompletion();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            slashDropdown.style.display = 'none';
            slashResults = [];
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            acceptSlashCompletion();
            return;
          }
        }
        // Normal Enter = send (desktop only)
        if (e.key === 'Enter' && !e.shiftKey) {
          const isMobile =
            typeof MobileDetection !== 'undefined' && MobileDetection.isTouchDevice() && window.innerWidth < 1024;
          if (!isMobile) {
            e.preventDefault();
            if (input.value.trim()) ConversationView.sendMessage();
          }
        }
      });
      // Click to select from dropdown
      if (slashDropdown) {
        slashDropdown.addEventListener('mousedown', (e) => {
          const item = e.target.closest('.cv-slash-item');
          if (item) {
            e.preventDefault(); // keep focus on textarea
            slashSelectedIndex = parseInt(item.dataset.index, 10) || 0;
            acceptSlashCompletion();
          }
        });
      }
      // Load custom commands on focus (reloads when session changes for project commands)
      input.addEventListener('focus', () => {
        if (typeof SlashCommands !== 'undefined') SlashCommands.loadCustomCommands(currentSessionId);
      });
    }

    // Show/hide the scroll-to-bottom button based on scroll position.
    // Uses event delegation on the wrapper — each per-session .cv-messages container
    // fires scroll events that bubble to the wrapper.
    const scrollBtn = panel.querySelector('#cvScrollBottom');
    const wrapper = panel.querySelector('#cvMessagesWrapper');
    if (wrapper && scrollBtn) {
      wrapper.addEventListener('scroll', () => {
        if (!messagesContainer) return;
        scrollBtn.style.display = isNearBottom() ? 'none' : '';
      }, true); // capture phase so we hear scroll on child elements
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
    input.style.overflow = 'hidden';
    input.style.height = '0';
    const h = Math.min(input.scrollHeight, 120);
    input.style.height = h + 'px';
    input.style.overflow = input.scrollHeight > 120 ? 'auto' : 'hidden';
    if (sendBtn) sendBtn.disabled = !draft.trim();
    input.classList.toggle('cv-input-multiline', draft.includes('\n'));
  }

  // ─── Public API ─────────────────────────────────────────────

  return {
    open(sessionId) {
      sessionId = sessionId || (typeof app !== 'undefined' ? app.activeSessionId : null);
      if (!sessionId) return;

      ensurePanel();

      // Always save draft text for the current session before switching or re-opening.
      // Without this, re-opening the same session (e.g. clicking its tab again) would
      // skip the save but restoreDraft would read the stale/empty map entry, clearing input.
      if (currentSessionId) {
        saveDraft(currentSessionId);
      }

      // Hide the previous session's messages container — save scroll position first
      // (display:none resets scrollTop to 0)
      const prevCache = currentSessionId ? sessionCache.get(currentSessionId) : null;
      if (prevCache) {
        prevCache.savedScrollTop = prevCache.el.scrollTop;
        prevCache.el.style.display = 'none';
      }

      currentSessionId = sessionId;
      isOpen = true;
      if (typeof SlashCommands !== 'undefined') SlashCommands.invalidate();

      // Get or create this session's cached container
      const cache = getCache(sessionId);
      messagesContainer = cache.el;

      // Attach to the wrapper if not already in the DOM
      const wrapper = panel.querySelector('#cvMessagesWrapper');
      if (wrapper && !messagesContainer.parentNode) {
        wrapper.appendChild(messagesContainer);
      }
      messagesContainer.style.display = '';

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
      const accessory = document.querySelector('.keyboard-accessory-bar');
      if (accessory && isMobile) accessory.style.display = 'none';
      panel.style.display = 'flex';

      // First open: fetch all messages. Subsequent: restore scroll + fetch new.
      if (cache.totalMessages === 0) {
        loadMessages(sessionId, false);
      } else {
        updateHeader();
        // Restore scroll position that was saved before hiding (display:none resets it).
        // Temporarily disable smooth scrolling so restore is instant.
        if (cache.savedScrollTop >= 0) {
          messagesContainer.style.scrollBehavior = 'auto';
          messagesContainer.scrollTop = cache.savedScrollTop;
          cache.savedScrollTop = -1;
          messagesContainer.style.scrollBehavior = '';
        }
        // Fetch any new messages that arrived while this tab was hidden
        fetchNewMessages();
      }
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

    scrollToBottom() {
      if (!messagesContainer) return;
      const distance = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
      // Smooth for short distances, instant for long jumps
      if (distance < 2000) {
        messagesContainer.style.scrollBehavior = 'smooth';
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        setTimeout(() => {
          if (messagesContainer) messagesContainer.style.scrollBehavior = '';
        }, 400);
      } else {
        messagesContainer.style.scrollBehavior = 'auto';
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        messagesContainer.style.scrollBehavior = '';
      }
      const scrollBtn = panel?.querySelector('#cvScrollBottom');
      if (scrollBtn) scrollBtn.style.display = 'none';
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
          // Optimistically render the user message immediately, then bump
          // newestIndex so fetchNewMessages doesn't duplicate it when the
          // server-side copy arrives.  We advance newestIndex by 1 beyond
          // the current highest known index; the real server index will be
          // ≥ that, so the duplicate check (m.index > cache.newestIndex)
          // correctly skips this message until a genuinely newer one appears.
          if (messagesContainer) {
            const div = document.createElement('div');
            div.className = 'cv-msg cv-user';
            div.innerHTML = `<div class="cv-msg-label">You</div><div class="cv-msg-body">${renderMarkdown(text)}</div>`;
            messagesContainer.appendChild(div);
            const sendCache = activeCache();
            if (sendCache) {
              sendCache.newestIndex = sendCache.newestIndex + 1;
              sendCache.totalMessages = sendCache.totalMessages + 1;
            }
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
          input.value = '';
          input.style.overflow = 'hidden';
          input.style.height = '';
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

    /** Select an option in an AskUserQuestion elicitation dialog */
    async selectOption(index, _total) {
      if (!currentSessionId) return;
      // Claude Code's Ink UI: first option is pre-selected, Down arrow to navigate
      const downs = '\x1b[B'.repeat(index);
      const input = downs + '\r';
      try {
        await fetch(`/api/sessions/${currentSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, useMux: false }),
        });
      } catch (err) {
        console.error('[ConversationView] selectOption error:', err);
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
      const cache = activeCache();
      if (cache) {
        cache.oldestIndex = null;
        cache.newestIndex = 0;
        cache.totalMessages = 0;
        cache.hasMore = false;
        cache.el.innerHTML = '';
      }
      loadMessages(currentSessionId, false);
    },

    /** Called when the active session changes */
    onSessionChanged(newSessionId) {
      if (isOpen && newSessionId !== currentSessionId) {
        this.open(newSessionId);
      }
    },

    toggleTool(toolId) {
      const cache = activeCache();
      if (!cache) return;
      const isNowExpanded = !cache.expandedTools.has(toolId);
      if (isNowExpanded) {
        cache.expandedTools.add(toolId);
      } else {
        cache.expandedTools.delete(toolId);
      }
      if (!messagesContainer) return;
      const els = messagesContainer.querySelectorAll(`[data-tool-id="${CSS.escape(toolId)}"]`);
      const storedMsg = cache.msgDataStore.get(toolId);

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
      const cache = activeCache();
      if (!cache) return;
      const isNowExpanded = !cache.expandedThinking.has(index);
      if (isNowExpanded) {
        cache.expandedThinking.add(index);
      } else {
        cache.expandedThinking.delete(index);
      }
      if (!messagesContainer) return;
      const el = messagesContainer.querySelector(`[data-index="${index}"]`);
      if (!el) return;
      const chevron = el.querySelector('.cv-chevron');
      const preview = el.querySelector('.cv-thinking-preview');
      const storeKey = el.dataset.key || `msg-${index}`;
      const storedMsg = cache.msgDataStore.get(storeKey);

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

    toggleSystem(index) {
      const cache = activeCache();
      if (!cache) return;
      const isNowExpanded = !cache.expandedSystem.has(index);
      if (isNowExpanded) {
        cache.expandedSystem.add(index);
      } else {
        cache.expandedSystem.delete(index);
      }
      if (!messagesContainer) return;
      const el = messagesContainer.querySelector(`.cv-system[data-index="${index}"]`);
      if (!el) return;
      const chevron = el.querySelector('.cv-chevron');
      const preview = el.querySelector('.cv-system-preview');
      const storeKey = el.dataset.key || `msg-${index}`;
      const storedMsg = cache.msgDataStore.get(storeKey);

      if (isNowExpanded) {
        el.classList.add('expanded');
        if (chevron) chevron.textContent = '▾';
        if (preview) preview.style.display = 'none';
        if (!el.querySelector('.cv-system-content') && storedMsg?.content) {
          const d = document.createElement('div');
          d.className = 'cv-system-content';
          d.innerHTML = renderMarkdown(storedMsg.content);
          el.appendChild(d);
        }
      } else {
        el.classList.remove('expanded');
        if (chevron) chevron.textContent = '▸';
        if (preview) preview.style.display = '';
        const content = el.querySelector('.cv-system-content');
        if (content) content.remove();
      }
    },

    /** Remove a session's cached DOM when the session is destroyed */
    cleanupSession(sessionId) {
      const cache = sessionCache.get(sessionId);
      if (cache) {
        cache.el.remove();
        sessionCache.delete(sessionId);
      }
      draftTextMap.delete(sessionId);
    },
  };
})();
