/**
 * @fileoverview App settings modal, visibility settings (header/panel/device-specific defaults),
 * web push notifications, session lifecycle log (JSONL viewer), tunnel/QR management,
 * persistent parent associations, and help modal.
 * Includes 13 SSE handlers for hooks and tunnel events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.notificationManager, this._tunnelUrl)
 * @dependency constants.js (escapeHtml)
 * @dependency keyboard-accessory.js (FocusTrap)
 * @loadorder 10 of 15 — loaded after ralph-panel.js, before panels-ui.js
 */

Object.assign(CodemanApp.prototype, {
  // Hooks (Claude Code hook events)
  _onHookIdlePrompt(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - alert will show when switching away from session
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'idle_prompt');
    }
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'hook-idle',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Waiting for Input',
      message: data.message || 'Claude is idle and waiting for a prompt',
    });
  },

  _onHookPermissionPrompt(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'permission_prompt');
    }
    const toolInfo = data.tool ? `${data.tool}${data.command ? ': ' + data.command : data.file ? ': ' + data.file : ''}` : '';
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-permission',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Permission Required',
      message: toolInfo || 'Claude needs tool approval to continue',
    });
  },

  _onHookElicitationDialog(data) {
    const session = this.sessions.get(data.sessionId);
    // Always track pending hook - action alerts need user interaction to clear
    if (data.sessionId) {
      this.setPendingHook(data.sessionId, 'elicitation_dialog');
    }
    this.notificationManager?.notify({
      urgency: 'critical',
      category: 'hook-elicitation',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Question Asked',
      message: data.question || 'Claude is asking a question and waiting for your answer',
    });
  },

  _onHookStop(data) {
    const session = this.sessions.get(data.sessionId);
    // Clear all pending hooks when Claude finishes responding
    if (data.sessionId) {
      this.clearPendingHooks(data.sessionId);
    }
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'hook-stop',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Response Complete',
      message: data.reason || 'Claude has finished responding',
    });
  },

  _onHookTeammateIdle(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'warning',
      category: 'hook-teammate-idle',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Teammate Idle',
      message: `A teammate is idle in ${session?.name || data.sessionId}`,
    });
  },

  _onHookTaskCompleted(data) {
    const session = this.sessions.get(data.sessionId);
    this.notificationManager?.notify({
      urgency: 'info',
      category: 'hook-task-completed',
      sessionId: data.sessionId,
      sessionName: session?.name || data.sessionId,
      title: 'Task Completed',
      message: `A team task completed in ${session?.name || data.sessionId}`,
    });
  },


  // Tunnel
  _onTunnelStarted(data) {
    console.log('[Tunnel] Started:', data.url);
    this._tunnelUrl = data.url;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(data.url);
    this._updateTunnelIndicator(true);
    const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
    if (welcomeVisible) {
      // On welcome screen: QR appears inline, expanded first
      this._updateWelcomeTunnelBtn(true, data.url, true);
      this.showToast(`Tunnel active`, 'success');
    } else {
      // Not on welcome screen: popup QR overlay
      this._updateWelcomeTunnelBtn(true, data.url);
      this.showToast(`Tunnel active: ${data.url}`, 'success');
      this.showTunnelQR();
    }
  },

  _onTunnelStopped() {
    console.log('[Tunnel] Stopped');
    this._tunnelUrl = null;
    this._dismissTunnelConnecting();
    this._updateTunnelUrlDisplay(null);
    this._updateWelcomeTunnelBtn(false);
    this._updateTunnelIndicator(false);
    this.closeTunnelPanel();
    this.closeTunnelQR();
  },

  _onTunnelProgress(data) {
    console.log('[Tunnel] Progress:', data.message);
    const toast = document.getElementById('tunnelConnectingToast');
    if (toast) {
      toast.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
    }
    // Also update button text if on welcome screen
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn?.classList.contains('connecting')) {
      btn.innerHTML = `<span class="tunnel-spinner"></span> ${data.message}`;
    }
  },

  _onTunnelError(data) {
    console.warn('[Tunnel] Error:', data.message);
    this._dismissTunnelConnecting();
    this.showToast(`Tunnel error: ${data.message}`, 'error');
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) { btn.disabled = false; btn.classList.remove('connecting'); }
  },

  _onTunnelQrRotated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  },

  _onTunnelQrRegenerated(data) {
    if (data.svg) {
      const container = document.getElementById('tunnelQrContainer');
      if (container) container.innerHTML = data.svg;
      const welcomeInner = document.getElementById('welcomeQrInner');
      if (welcomeInner) welcomeInner.innerHTML = data.svg;
    } else {
      this._refreshTunnelQrFromApi();
    }
    this._resetQrCountdown();
  },

  _onTunnelQrAuthUsed(data) {
    const ua = data.ua || 'Unknown device';
    const family = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
    this.showToast(`Device authenticated via QR (${family}, ${data.ip}). Not you?`, 'warning', {
      duration: 10000,
      action: { label: 'Revoke All', onClick: () => {
        fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(() => this.showToast('All sessions revoked', 'success'))
          .catch(() => this.showToast('Failed to revoke sessions', 'error'));
      }},
    });
  },


  // ═══════════════════════════════════════════════════════════════
  // Web Push
  // ═══════════════════════════════════════════════════════════════

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      this._swRegistration = reg;
      // Listen for messages from service worker (notification clicks)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
          const { sessionId } = event.data;
          if (sessionId && this.sessions.has(sessionId)) {
            this.selectSession(sessionId);
          }
          window.focus();
        }
      });
      // Check if already subscribed
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          this._pushSubscription = sub;
          this._updatePushUI(true);
        }
      });
    }).catch(() => {
      // Service worker registration failed (likely not HTTPS)
    });
  },

  async subscribeToPush() {
    if (!this._swRegistration) {
      this.showToast('Service worker not available. HTTPS or localhost required.', 'error');
      return;
    }
    try {
      // Get VAPID public key from server
      const keyData = await this._apiJson('/api/push/vapid-key');
      if (!keyData?.success) throw new Error('Failed to get VAPID key');

      const applicationServerKey = urlBase64ToUint8Array(keyData.data.publicKey);
      const subscription = await this._swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      // Send subscription to server
      const subJson = subscription.toJSON();
      const data = await this._apiJson('/api/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          userAgent: navigator.userAgent,
          pushPreferences: this._buildPushPreferences(),
        },
      });
      if (!data?.success) throw new Error('Failed to register subscription');

      this._pushSubscription = subscription;
      this._pushSubscriptionId = data.data.id;
      localStorage.setItem('codeman-push-subscription-id', data.data.id);
      this._updatePushUI(true);
      this.showToast('Push notifications enabled', 'success');
    } catch (err) {
      this.showToast('Push subscription failed: ' + (err.message || err), 'error');
    }
  },

  async unsubscribeFromPush() {
    try {
      if (this._pushSubscription) {
        await this._pushSubscription.unsubscribe();
      }
      const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
      if (subId) {
        await fetch(`/api/push/subscribe/${subId}`, { method: 'DELETE' }).catch(() => {});
      }
      this._pushSubscription = null;
      this._pushSubscriptionId = null;
      localStorage.removeItem('codeman-push-subscription-id');
      this._updatePushUI(false);
      this.showToast('Push notifications disabled', 'success');
    } catch (err) {
      this.showToast('Failed to unsubscribe: ' + (err.message || err), 'error');
    }
  },

  async togglePushSubscription() {
    if (this._pushSubscription) {
      await this.unsubscribeFromPush();
    } else {
      await this.subscribeToPush();
    }
  },

  /** Sync push preferences to server */
  async _syncPushPreferences() {
    const subId = this._pushSubscriptionId || localStorage.getItem('codeman-push-subscription-id');
    if (!subId) return;
    try {
      await fetch(`/api/push/subscribe/${subId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushPreferences: this._buildPushPreferences() }),
      });
    } catch {
      // Silently fail — prefs saved locally, will sync on next subscribe
    }
  },

  /** Build push preferences object from current event type checkboxes */
  _buildPushPreferences() {
    const prefs = {};
    const eventMap = {
      'hook:permission_prompt': 'eventPermissionPush',
      'hook:elicitation_dialog': 'eventQuestionPush',
      'hook:idle_prompt': 'eventIdlePush',
      'hook:stop': 'eventStopPush',
      'respawn:blocked': 'eventRespawnPush',
      'session:ralphCompletionDetected': 'eventRalphPush',
    };
    for (const [event, checkboxId] of Object.entries(eventMap)) {
      const el = document.getElementById(checkboxId);
      prefs[event] = el ? el.checked : true;
    }
    // session:error always receives push (no per-event toggle, always critical)
    prefs['session:error'] = true;
    return prefs;
  },

  _updatePushUI(subscribed) {
    const btn = document.getElementById('pushSubscribeBtn');
    const status = document.getElementById('pushSubscriptionStatus');
    if (btn) btn.textContent = subscribed ? 'Unsubscribe' : 'Subscribe';
    if (status) {
      status.textContent = subscribed ? 'active' : 'off';
      status.classList.remove('granted', 'denied');
      if (subscribed) status.classList.add('granted');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // App Settings Modal
  // ═══════════════════════════════════════════════════════════════

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    // Use device-aware defaults for display settings (mobile has different defaults)
    const defaults = this.getDefaultSettings();
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? defaults.ralphTrackerEnabled ?? false;
    // Header visibility settings
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? defaults.showFontControls ?? false;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    document.getElementById('appSettingsShowTokenCount').checked = settings.showTokenCount ?? defaults.showTokenCount ?? true;
    document.getElementById('appSettingsShowCost').checked = settings.showCost ?? defaults.showCost ?? false;
    document.getElementById('appSettingsShowLifecycleLog').checked = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    document.getElementById('appSettingsShowMonitor').checked = settings.showMonitor ?? defaults.showMonitor ?? true;
    document.getElementById('appSettingsShowProjectInsights').checked = settings.showProjectInsights ?? defaults.showProjectInsights ?? false;
    document.getElementById('appSettingsShowFileBrowser').checked = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;
    document.getElementById('appSettingsShowSubagents').checked = settings.showSubagents ?? defaults.showSubagents ?? false;
    document.getElementById('appSettingsSubagentTracking').checked = settings.subagentTrackingEnabled ?? defaults.subagentTrackingEnabled ?? true;
    document.getElementById('appSettingsSubagentActiveTabOnly').checked = settings.subagentActiveTabOnly ?? defaults.subagentActiveTabOnly ?? true;
    document.getElementById('appSettingsImageWatcherEnabled').checked = settings.imageWatcherEnabled ?? defaults.imageWatcherEnabled ?? false;
    document.getElementById('appSettingsTunnelEnabled').checked = settings.tunnelEnabled ?? false;
    this.loadTunnelStatus();
    document.getElementById('appSettingsLocalEcho').checked = settings.localEchoEnabled ?? MobileDetection.isTouchDevice();
    document.getElementById('appSettingsTabTwoRows').checked = settings.tabTwoRows ?? defaults.tabTwoRows ?? false;
    // Claude CLI settings
    const claudeModeSelect = document.getElementById('appSettingsClaudeMode');
    const allowedToolsRow = document.getElementById('allowedToolsRow');
    claudeModeSelect.value = settings.claudeMode || 'dangerously-skip-permissions';
    document.getElementById('appSettingsAllowedTools').value = settings.allowedTools || '';
    allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    // Toggle allowed tools row visibility based on mode selection
    claudeModeSelect.onchange = () => {
      allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    };
    // Claude Permissions settings
    document.getElementById('appSettingsAgentTeams').checked = settings.agentTeamsEnabled ?? false;
    // CPU Priority settings
    const niceSettings = settings.nice || {};
    document.getElementById('appSettingsNiceEnabled').checked = niceSettings.enabled ?? false;
    document.getElementById('appSettingsNiceValue').value = niceSettings.niceValue ?? 10;
    // Model configuration (loaded from server)
    this.loadModelConfigForSettings();
    // Notification settings
    const notifPrefs = this.notificationManager?.preferences || {};
    document.getElementById('appSettingsNotifEnabled').checked = notifPrefs.enabled ?? true;
    document.getElementById('appSettingsNotifBrowser').checked = notifPrefs.browserNotifications ?? false;
    document.getElementById('appSettingsNotifAudio').checked = notifPrefs.audioAlerts ?? false;
    document.getElementById('appSettingsNotifStuckMins').value = Math.round((notifPrefs.stuckThresholdMs || 600000) / 60000);
    document.getElementById('appSettingsNotifCritical').checked = !notifPrefs.muteCritical;
    document.getElementById('appSettingsNotifWarning').checked = !notifPrefs.muteWarning;
    document.getElementById('appSettingsNotifInfo').checked = !notifPrefs.muteInfo;
    // Push notification settings
    document.getElementById('appSettingsPushEnabled').checked = !!this._pushSubscription;
    this._updatePushUI(!!this._pushSubscription);
    // Per-event-type preferences
    const eventTypes = notifPrefs.eventTypes || {};
    // Permission prompts
    const permPref = eventTypes.permission_prompt || {};
    document.getElementById('eventPermissionEnabled').checked = permPref.enabled ?? true;
    document.getElementById('eventPermissionBrowser').checked = permPref.browser ?? true;
    document.getElementById('eventPermissionPush').checked = permPref.push ?? false;
    document.getElementById('eventPermissionAudio').checked = permPref.audio ?? true;
    // Questions (elicitation_dialog)
    const questionPref = eventTypes.elicitation_dialog || {};
    document.getElementById('eventQuestionEnabled').checked = questionPref.enabled ?? true;
    document.getElementById('eventQuestionBrowser').checked = questionPref.browser ?? true;
    document.getElementById('eventQuestionPush').checked = questionPref.push ?? false;
    document.getElementById('eventQuestionAudio').checked = questionPref.audio ?? true;
    // Session idle (idle_prompt)
    const idlePref = eventTypes.idle_prompt || {};
    document.getElementById('eventIdleEnabled').checked = idlePref.enabled ?? true;
    document.getElementById('eventIdleBrowser').checked = idlePref.browser ?? true;
    document.getElementById('eventIdlePush').checked = idlePref.push ?? false;
    document.getElementById('eventIdleAudio').checked = idlePref.audio ?? false;
    // Response complete (stop)
    const stopPref = eventTypes.stop || {};
    document.getElementById('eventStopEnabled').checked = stopPref.enabled ?? true;
    document.getElementById('eventStopBrowser').checked = stopPref.browser ?? false;
    document.getElementById('eventStopPush').checked = stopPref.push ?? false;
    document.getElementById('eventStopAudio').checked = stopPref.audio ?? false;
    // Respawn cycles
    const respawnPref = eventTypes.respawn_cycle || {};
    document.getElementById('eventRespawnEnabled').checked = respawnPref.enabled ?? true;
    document.getElementById('eventRespawnBrowser').checked = respawnPref.browser ?? false;
    document.getElementById('eventRespawnPush').checked = respawnPref.push ?? false;
    document.getElementById('eventRespawnAudio').checked = respawnPref.audio ?? false;
    // Task complete (ralph_complete)
    const ralphPref = eventTypes.ralph_complete || {};
    document.getElementById('eventRalphEnabled').checked = ralphPref.enabled ?? true;
    document.getElementById('eventRalphBrowser').checked = ralphPref.browser ?? true;
    document.getElementById('eventRalphPush').checked = ralphPref.push ?? false;
    document.getElementById('eventRalphAudio').checked = ralphPref.audio ?? true;
    // Subagent activity (subagent_spawn and subagent_complete)
    const subagentPref = eventTypes.subagent_spawn || {};
    document.getElementById('eventSubagentEnabled').checked = subagentPref.enabled ?? false;
    document.getElementById('eventSubagentBrowser').checked = subagentPref.browser ?? false;
    document.getElementById('eventSubagentPush').checked = subagentPref.push ?? false;
    document.getElementById('eventSubagentAudio').checked = subagentPref.audio ?? false;
    // Update permission status display (compact format for new grid layout)
    const permStatus = document.getElementById('notifPermissionStatus');
    if (permStatus && typeof Notification !== 'undefined') {
      const perm = Notification.permission;
      permStatus.textContent = perm === 'granted' ? '\u2713' : perm === 'denied' ? '\u2717' : '?';
      permStatus.classList.remove('granted', 'denied');
      if (perm === 'granted') permStatus.classList.add('granted');
      else if (perm === 'denied') permStatus.classList.add('denied');
    }
    // Voice settings (loaded from localStorage only)
    const voiceCfg = VoiceInput._getDeepgramConfig();
    document.getElementById('voiceDeepgramKey').value = voiceCfg.apiKey || '';
    document.getElementById('voiceLanguage').value = voiceCfg.language || 'en-US';
    document.getElementById('voiceKeyterms').value = voiceCfg.keyterms || 'refactor, endpoint, middleware, callback, async, regex, TypeScript, npm, API, deploy, config, linter, env, webhook, schema, CLI, JSON, CSS, DOM, SSE, backend, frontend, localhost, dependencies, repository, merge, rebase, diff, commit, com';
    document.getElementById('voiceInsertMode').value = voiceCfg.insertMode || 'direct';
    // Reset key visibility to hidden
    const keyInput = document.getElementById('voiceDeepgramKey');
    keyInput.type = 'password';
    document.getElementById('voiceKeyToggleBtn').textContent = 'Show';
    // Update provider status
    const providerName = VoiceInput.getActiveProviderName();
    const providerEl = document.getElementById('voiceProviderStatus');
    providerEl.textContent = providerName;
    providerEl.className = 'voice-provider-status' + (providerName.startsWith('Deepgram') ? ' active' : '');

    // Reset to first tab and wire up tab switching
    this.switchSettingsTab('settings-display');
    const modal = document.getElementById('appSettingsModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchSettingsTab(btn.dataset.tab);
    });
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  switchSettingsTab(tabName) {
    const modal = document.getElementById('appSettingsModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
  },

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  async loadTunnelStatus() {
    try {
      const res = await fetch('/api/tunnel/status');
      const status = await res.json();
      const active = status.running && status.url;
      this._tunnelUrl = active ? status.url : null;
      this._updateTunnelUrlDisplay(this._tunnelUrl);
      this._updateWelcomeTunnelBtn(!!active, this._tunnelUrl);
      this._updateTunnelIndicator(!!active);
    } catch {
      this._tunnelUrl = null;
      this._updateTunnelUrlDisplay(null);
      this._updateWelcomeTunnelBtn(false);
      this._updateTunnelIndicator(false);
    }
  },

  _updateTunnelUrlDisplay(url) {
    const row = document.getElementById('tunnelUrlRow');
    const display = document.getElementById('tunnelUrlDisplay');
    if (!row || !display) return;
    if (url) {
      row.style.display = '';
      display.textContent = url;
      display.onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
          this.showToast('Tunnel URL copied', 'success');
        });
      };
    } else {
      row.style.display = 'none';
      display.textContent = '';
      display.onclick = null;
    }
    // Upload URL row
    const uploadRow = document.getElementById('tunnelUploadUrlRow');
    const uploadDisplay = document.getElementById('tunnelUploadUrlDisplay');
    if (!uploadRow || !uploadDisplay) return;
    if (url) {
      const uploadUrl = url + '/upload.html';
      uploadRow.style.display = '';
      uploadDisplay.textContent = uploadUrl;
      uploadDisplay.onclick = () => {
        navigator.clipboard.writeText(uploadUrl).then(() => {
          this.showToast('Upload URL copied', 'success');
        });
      };
    } else {
      uploadRow.style.display = 'none';
      uploadDisplay.textContent = '';
      uploadDisplay.onclick = null;
    }
  },

  showTunnelQR() {
    // Close existing popup if open
    this.closeTunnelQR();

    const overlay = document.createElement('div');
    overlay.id = 'tunnelQrOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:5000;display:flex;align-items:center;justify-content:center;cursor:pointer';
    overlay.onclick = (e) => { if (e.target === overlay) this.closeTunnelQR(); };

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;max-width:340px;width:90vw;box-shadow:var(--shadow-lg);cursor:default';

    card.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px">Scan to connect</div>
      <div id="tunnelQrContainer" style="background:#fff;border-radius:8px;padding:16px;display:inline-block">
        <div style="color:#666;font-size:12px">Loading...</div>
      </div>
      <div id="tunnelQrUrl" style="margin-top:12px;font-family:monospace;font-size:11px;color:var(--text-muted);word-break:break-all;cursor:pointer" title="Click to copy"></div>
      <button onclick="app.closeTunnelQR()" style="margin-top:16px;padding:6px 20px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);cursor:pointer;font-size:13px">Close</button>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Fetch QR SVG from server
    fetch('/api/tunnel/qr')
      .then(res => {
        if (!res.ok) throw new Error('Tunnel not running');
        return res.json();
      })
      .then(data => {
        const container = document.getElementById('tunnelQrContainer');
        if (container && data.svg) container.innerHTML = data.svg;
        // Show auth badge, countdown, and regenerate button when auth is enabled
        if (data.authEnabled) {
          const badge = document.createElement('div');
          badge.id = 'tunnelQrBadge';
          badge.style.cssText = 'margin-top:8px;font-size:11px;color:var(--text-muted)';
          badge.textContent = 'Single-use auth \u00b7 expires in 60s';
          const regenBtn = document.createElement('button');
          regenBtn.textContent = 'Regenerate QR';
          regenBtn.style.cssText = 'margin-top:8px;padding:4px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer;font-size:11px';
          regenBtn.onclick = () => {
            fetch('/api/tunnel/qr/regenerate', { method: 'POST' })
              .then(() => this.showToast('QR code regenerated', 'success'))
              .catch(() => this.showToast('Failed to regenerate QR', 'error'));
          };
          const card = container.parentElement;
          if (card) {
            card.appendChild(badge);
            card.appendChild(regenBtn);
          }
          this._resetQrCountdown();
        }
      })
      .catch(() => {
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = '<div style="color:#c00;font-size:12px;padding:20px">Tunnel not active</div>';
      });

    // Fetch URL for display
    fetch('/api/tunnel/status')
      .then(r => r.json())
      .then(status => {
        const urlEl = document.getElementById('tunnelQrUrl');
        if (urlEl && status.url) {
          urlEl.textContent = status.url;
          urlEl.onclick = () => {
            navigator.clipboard.writeText(status.url).then(() => {
              this.showToast('Tunnel URL copied', 'success');
            });
          };
        }
      })
      .catch(() => {});

    // Close on Escape
    this._tunnelQrEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelQR(); };
    document.addEventListener('keydown', this._tunnelQrEscHandler);
  },

  closeTunnelQR() {
    const overlay = document.getElementById('tunnelQrOverlay');
    if (overlay) overlay.remove();
    if (this._tunnelQrEscHandler) {
      document.removeEventListener('keydown', this._tunnelQrEscHandler);
      this._tunnelQrEscHandler = null;
    }
    this._clearQrCountdown();
  },

  /** Fallback: fetch QR SVG from API when SSE payload lacks it */
  _refreshTunnelQrFromApi() {
    fetch('/api/tunnel/qr')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data?.svg) return;
        const container = document.getElementById('tunnelQrContainer');
        if (container) container.innerHTML = data.svg;
        const welcomeInner = document.getElementById('welcomeQrInner');
        if (welcomeInner) welcomeInner.innerHTML = data.svg;
      })
      .catch(() => {});
  },

  /** Start or reset the 60s countdown on the QR badge */
  _resetQrCountdown() {
    this._clearQrCountdown();
    this._qrCountdownSec = 60;
    this._updateQrCountdownText();
    this._qrCountdownTimer = setInterval(() => {
      this._qrCountdownSec--;
      if (this._qrCountdownSec <= 0) {
        this._clearQrCountdown();
        return;
      }
      this._updateQrCountdownText();
    }, 1000);
  },

  _updateQrCountdownText() {
    const badge = document.getElementById('tunnelQrBadge');
    if (badge) {
      badge.textContent = `Single-use auth \u00b7 expires in ${this._qrCountdownSec}s`;
    }
  },

  _clearQrCountdown() {
    if (this._qrCountdownTimer) {
      clearInterval(this._qrCountdownTimer);
      this._qrCountdownTimer = null;
    }
  },

  async toggleTunnelFromWelcome() {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (!btn) return;
    const isActive = btn.classList.contains('active');
    btn.disabled = true;
    try {
      const newEnabled = !isActive;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: newEnabled }),
      });
      if (newEnabled) {
        this._showTunnelConnecting();
        // Poll tunnel status as fallback in case SSE event is missed
        this._pollTunnelStatus();
      } else {
        this._dismissTunnelConnecting();
        this.showToast('Tunnel stopped', 'info');
        this._updateWelcomeTunnelBtn(false);
        btn.disabled = false;
      }
    } catch (err) {
      this._dismissTunnelConnecting();
      this.showToast('Failed to toggle tunnel', 'error');
      btn.disabled = false;
    }
  },

  _showTunnelConnecting() {
    // Remove any existing connecting toast first (without resetting button state)
    const oldToast = document.getElementById('tunnelConnectingToast');
    if (oldToast) {
      oldToast.remove();
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.classList.add('connecting');
      btn.innerHTML = `
        <span class="tunnel-spinner"></span>
        Connecting...`;
    }
    // Persistent toast with spinner
    const toast = document.createElement('div');
    toast.className = 'toast toast-info show';
    toast.id = 'tunnelConnectingToast';
    toast.innerHTML = '<span class="tunnel-spinner"></span> Cloudflare Tunnel connecting...';
    toast.style.pointerEvents = 'auto';
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);
  },

  _dismissTunnelConnecting() {
    clearTimeout(this._tunnelPollTimer);
    this._tunnelPollTimer = null;
    const toast = document.getElementById('tunnelConnectingToast');
    if (toast) {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) btn.classList.remove('connecting');
  },

  _pollTunnelStatus(attempt = 0) {
    if (attempt > 15) return; // give up after ~30s
    this._tunnelPollTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/tunnel/status');
        const status = await res.json();
        if (status.running && status.url) {
          // Tunnel is up — update UI
          this._dismissTunnelConnecting();
          this._updateTunnelUrlDisplay(status.url);
          const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
          if (welcomeVisible) {
            this._updateWelcomeTunnelBtn(true, status.url, true);
            this.showToast('Tunnel active', 'success');
          } else {
            this._updateWelcomeTunnelBtn(true, status.url);
            this.showToast(`Tunnel active: ${status.url}`, 'success');
            this.showTunnelQR();
          }
          return;
        }
      } catch { /* ignore */ }
      this._pollTunnelStatus(attempt + 1);
    }, 2000);
  },

  _updateWelcomeTunnelBtn(active, url, firstAppear = false) {
    const btn = document.getElementById('welcomeTunnelBtn');
    if (btn) {
      btn.disabled = false;
      if (active) {
        btn.classList.remove('connecting');
        btn.classList.add('active');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Tunnel Active`;
      } else {
        btn.classList.remove('active', 'connecting');
        btn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel`;
      }
    }
    // Update welcome QR code
    const qrWrap = document.getElementById('welcomeQr');
    const qrInner = document.getElementById('welcomeQrInner');
    const qrUrl = document.getElementById('welcomeQrUrl');
    if (!qrWrap || !qrInner) return;
    if (active) {
      qrWrap.classList.add('visible');
      // First appear: start expanded, auto-shrink after 8s
      if (firstAppear) {
        qrWrap.classList.add('expanded');
        clearTimeout(this._welcomeQrShrinkTimer);
        this._welcomeQrShrinkTimer = setTimeout(() => {
          qrWrap.classList.remove('expanded');
        }, 8000);
      }
      if (url) {
        qrUrl.textContent = url;
        qrUrl.title = 'Click QR to enlarge';
      }
      fetch('/api/tunnel/qr')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(data => { if (data.svg) qrInner.innerHTML = data.svg; })
        .catch(() => { qrInner.innerHTML = '<div style="color:#999;font-size:11px;padding:20px">QR unavailable</div>'; });
    } else {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.remove('visible', 'expanded');
      qrInner.innerHTML = '';
      if (qrUrl) qrUrl.textContent = '';
    }
  },

  toggleWelcomeQrSize() {
    const qrWrap = document.getElementById('welcomeQr');
    if (qrWrap) {
      clearTimeout(this._welcomeQrShrinkTimer);
      qrWrap.classList.toggle('expanded');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Tunnel Header Indicator & Panel (desktop only)
  // ═══════════════════════════════════════════════════════════════

  _updateTunnelIndicator(active) {
    if (MobileDetection.getDeviceType() === 'mobile') return;
    const indicator = document.getElementById('tunnelIndicator');
    if (!indicator) return;
    indicator.style.display = active ? 'flex' : 'none';
    indicator.classList.remove('connecting');
  },

  toggleTunnelPanel() {
    const existing = document.getElementById('tunnelPanel');
    if (existing) {
      this.closeTunnelPanel();
      return;
    }
    this._openTunnelPanel();
  },

  async _openTunnelPanel() {
    const panel = document.createElement('div');
    panel.className = 'tunnel-panel';
    panel.id = 'tunnelPanel';
    panel.innerHTML = `
      <div class="tunnel-panel-header">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Cloudflare Tunnel
          <span class="tunnel-panel-status" id="tunnelPanelStatus">Loading...</span>
        </h3>
      </div>
      <div class="tunnel-panel-body" id="tunnelPanelBody">
        <div style="font-size:12px;color:var(--text-muted);padding:8px 0">Loading...</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Close on outside click
    this._tunnelPanelClickHandler = (e) => {
      if (!panel.contains(e.target) && e.target.id !== 'tunnelIndicator' && !e.target.closest('.tunnel-indicator')) {
        this.closeTunnelPanel();
      }
    };
    setTimeout(() => document.addEventListener('click', this._tunnelPanelClickHandler), 0);

    // Close on Escape
    this._tunnelPanelEscHandler = (e) => { if (e.key === 'Escape') this.closeTunnelPanel(); };
    document.addEventListener('keydown', this._tunnelPanelEscHandler);

    // Fetch tunnel info
    try {
      const res = await fetch('/api/tunnel/info');
      const info = await res.json();
      this._renderTunnelPanel(info);
    } catch {
      const body = document.getElementById('tunnelPanelBody');
      if (body) body.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px 0">Failed to load tunnel info</div>';
    }
  },

  _renderTunnelPanel(info) {
    const statusEl = document.getElementById('tunnelPanelStatus');
    const body = document.getElementById('tunnelPanelBody');
    if (!statusEl || !body) return;

    statusEl.textContent = info.running ? 'Connected' : 'Offline';
    statusEl.className = 'tunnel-panel-status' + (info.running ? '' : ' offline');

    let html = '';

    // URL section
    if (info.url) {
      html += `
        <div class="tunnel-panel-section">
          <div class="tunnel-panel-label">URL</div>
          <div class="tunnel-panel-url" id="tunnelPanelUrl" title="Click to copy">${escapeHtml(info.url)}</div>
        </div>`;
    }

    // Clients section
    html += `
      <div class="tunnel-panel-section">
        <div class="tunnel-panel-label">Connections</div>
        <div class="tunnel-panel-stat">
          <span>Remote Clients</span>
          <span class="tunnel-panel-stat-value">${info.sseClients}</span>
        </div>`;

    if (info.authEnabled) {
      html += `
        <div class="tunnel-panel-stat">
          <span>Auth Sessions</span>
          <span class="tunnel-panel-stat-value">${info.authSessions.length}</span>
        </div>`;
    }
    html += '</div>';

    // Auth sessions detail
    if (info.authEnabled && info.authSessions.length > 0) {
      html += '<div class="tunnel-panel-section"><div class="tunnel-panel-label">Authenticated Devices</div>';
      for (const s of info.authSessions) {
        const ua = s.ua || 'Unknown';
        const browser = ua.match(/Chrome|Firefox|Safari|Edge|Mobile/)?.[0] || 'Browser';
        const ago = this._formatTimeAgo(s.createdAt);
        html += `
          <div class="tunnel-panel-session">
            <span class="tunnel-panel-session-dot"></span>
            <span class="tunnel-panel-session-info" title="${escapeHtml(ua)}">${escapeHtml(browser)} &middot; ${escapeHtml(s.ip)} &middot; ${ago}</span>
            <span class="tunnel-panel-session-method">${s.method}</span>
          </div>`;
      }
      html += '</div>';
    }

    // Actions
    html += '<div class="tunnel-panel-actions">';
    if (info.running) {
      html += `
        <button class="tunnel-panel-btn btn-qr" onclick="app.showTunnelQR();app.closeTunnelPanel()">QR Code</button>
        <button class="tunnel-panel-btn btn-stop" onclick="app._tunnelPanelToggle(false)">Stop Tunnel</button>`;
    } else {
      html += `<button class="tunnel-panel-btn btn-start" onclick="app._tunnelPanelToggle(true)">Start Tunnel</button>`;
    }
    html += '</div>';

    // Revoke all sessions button
    if (info.authEnabled && info.authSessions.length > 0) {
      html += `
        <div style="padding-top:8px">
          <button class="tunnel-panel-btn btn-revoke" style="width:100%" onclick="app._tunnelPanelRevokeAll()">Revoke All Sessions</button>
        </div>`;
    }

    body.innerHTML = html;

    // Bind URL copy handler
    const urlEl = document.getElementById('tunnelPanelUrl');
    if (urlEl) {
      urlEl.onclick = () => {
        navigator.clipboard.writeText(info.url).then(() => this.showToast('Tunnel URL copied', 'success'));
      };
    }
  },

  _formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  },

  async _tunnelPanelToggle(enable) {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnelEnabled: enable }),
      });
      if (enable) {
        this._updateTunnelIndicator(false);
        const indicator = document.getElementById('tunnelIndicator');
        if (indicator) {
          indicator.style.display = 'flex';
          indicator.classList.add('connecting');
        }
        this.showToast('Tunnel starting...', 'info');
        this._showTunnelConnecting();
        this._pollTunnelStatus();
      } else {
        this.showToast('Tunnel stopped', 'info');
      }
      this.closeTunnelPanel();
    } catch {
      this.showToast('Failed to toggle tunnel', 'error');
    }
  },

  async _tunnelPanelRevokeAll() {
    try {
      await fetch('/api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      this.showToast('All sessions revoked', 'success');
      // Refresh panel
      const res = await fetch('/api/tunnel/info');
      const info = await res.json();
      this._renderTunnelPanel(info);
    } catch {
      this.showToast('Failed to revoke sessions', 'error');
    }
  },

  closeTunnelPanel() {
    const panel = document.getElementById('tunnelPanel');
    if (panel) panel.remove();
    if (this._tunnelPanelClickHandler) {
      document.removeEventListener('click', this._tunnelPanelClickHandler);
      this._tunnelPanelClickHandler = null;
    }
    if (this._tunnelPanelEscHandler) {
      document.removeEventListener('keydown', this._tunnelPanelEscHandler);
      this._tunnelPanelEscHandler = null;
    }
  },

  toggleDeepgramKeyVisibility() {
    const input = document.getElementById('voiceDeepgramKey');
    const btn = document.getElementById('voiceKeyToggleBtn');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle Log
  // ═══════════════════════════════════════════════════════════════

  openLifecycleLog() {
    const win = document.getElementById('lifecycleWindow');
    win.style.display = 'block';
    // Reset transform so it appears centered initially
    if (!win._dragInitialized) {
      win.style.left = '50%';
      win.style.transform = 'translateX(-50%)';
      this._initLifecycleDrag(win);
      win._dragInitialized = true;
    }
    this.loadLifecycleLog();
  },

  closeLifecycleLog() {
    document.getElementById('lifecycleWindow').style.display = 'none';
  },

  _initLifecycleDrag(win) {
    const header = document.getElementById('lifecycleWindowHeader');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      isDragging = true;
      // Clear transform so left/top work in absolute pixels
      const rect = win.getBoundingClientRect();
      win.style.transform = 'none';
      win.style.left = rect.left + 'px';
      win.style.top = rect.top + 'px';
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      win.style.left = (startLeft + e.clientX - startX) + 'px';
      win.style.top = (startTop + e.clientY - startY) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  },

  async loadLifecycleLog() {
    const eventFilter = document.getElementById('lifecycleFilterEvent').value;
    const sessionFilter = document.getElementById('lifecycleFilterSession').value.trim();
    const params = new URLSearchParams();
    if (eventFilter) params.set('event', eventFilter);
    if (sessionFilter) params.set('sessionId', sessionFilter);
    params.set('limit', '300');

    try {
      const res = await fetch(`/api/session-lifecycle?${params}`);
      const data = await res.json();
      const tbody = document.getElementById('lifecycleTableBody');
      const empty = document.getElementById('lifecycleEmpty');

      if (!data.entries || data.entries.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';

      const eventColors = {
        created: '#4ade80', started: '#4ade80', recovered: '#4ade80',
        exit: '#fbbf24', mux_died: '#f87171', deleted: '#f87171', stale_cleaned: '#f87171',
        server_started: '#666', server_stopped: '#666',
      };

      tbody.innerHTML = data.entries.map(e => {
        const time = new Date(e.ts).toLocaleString();
        const color = eventColors[e.event] || '#888';
        const name = e.name || (e.sessionId === '*' ? '—' : this.getShortId(e.sessionId));
        const extra = [];
        if (e.exitCode !== undefined && e.exitCode !== null) extra.push(`code=${e.exitCode}`);
        if (e.mode) extra.push(e.mode);
        return `<tr style="border-bottom:1px solid #1a1a2e">
          <td style="padding:3px 8px;color:#888;white-space:nowrap">${time}</td>
          <td style="padding:3px 8px;color:${color};font-weight:600">${e.event}</td>
          <td style="padding:3px 8px;color:#e0e0e0" title="${e.sessionId}">${name}</td>
          <td style="padding:3px 8px;color:#aaa">${e.reason || ''}</td>
          <td style="padding:3px 8px;color:#666">${extra.join(', ')}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      console.error('Failed to load lifecycle log:', err);
    }
  },

  async saveAppSettings() {
    const settings = {
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
      ralphTrackerEnabled: document.getElementById('appSettingsRalphEnabled').checked,
      // Header visibility settings
      showFontControls: document.getElementById('appSettingsShowFontControls').checked,
      showSystemStats: document.getElementById('appSettingsShowSystemStats').checked,
      showTokenCount: document.getElementById('appSettingsShowTokenCount').checked,
      showCost: document.getElementById('appSettingsShowCost').checked,
      showLifecycleLog: document.getElementById('appSettingsShowLifecycleLog').checked,
      showMonitor: document.getElementById('appSettingsShowMonitor').checked,
      showProjectInsights: document.getElementById('appSettingsShowProjectInsights').checked,
      showFileBrowser: document.getElementById('appSettingsShowFileBrowser').checked,
      showSubagents: document.getElementById('appSettingsShowSubagents').checked,
      subagentTrackingEnabled: document.getElementById('appSettingsSubagentTracking').checked,
      subagentActiveTabOnly: document.getElementById('appSettingsSubagentActiveTabOnly').checked,
      imageWatcherEnabled: document.getElementById('appSettingsImageWatcherEnabled').checked,
      tunnelEnabled: document.getElementById('appSettingsTunnelEnabled').checked,
      localEchoEnabled: document.getElementById('appSettingsLocalEcho').checked,
      tabTwoRows: document.getElementById('appSettingsTabTwoRows').checked,
      // Claude CLI settings
      claudeMode: document.getElementById('appSettingsClaudeMode').value,
      allowedTools: document.getElementById('appSettingsAllowedTools').value.trim(),
      // Claude Permissions settings
      agentTeamsEnabled: document.getElementById('appSettingsAgentTeams').checked,
      // CPU Priority settings
      nice: {
        enabled: document.getElementById('appSettingsNiceEnabled').checked,
        niceValue: parseInt(document.getElementById('appSettingsNiceValue').value) || 10,
      },
    };

    // Save to localStorage
    this.saveAppSettingsToStorage(settings);
    this._updateLocalEchoState();

    // Save voice settings to localStorage + include in server payload for cross-device sync
    const voiceSettings = {
      apiKey: document.getElementById('voiceDeepgramKey').value.trim(),
      language: document.getElementById('voiceLanguage').value,
      keyterms: document.getElementById('voiceKeyterms').value.trim(),
      insertMode: document.getElementById('voiceInsertMode').value,
    };
    VoiceInput._saveDeepgramConfig(voiceSettings);

    // Save notification preferences separately
    const notifPrefsToSave = {
      enabled: document.getElementById('appSettingsNotifEnabled').checked,
      browserNotifications: document.getElementById('appSettingsNotifBrowser').checked,
      audioAlerts: document.getElementById('appSettingsNotifAudio').checked,
      stuckThresholdMs: (parseInt(document.getElementById('appSettingsNotifStuckMins').value) || 10) * 60000,
      muteCritical: !document.getElementById('appSettingsNotifCritical').checked,
      muteWarning: !document.getElementById('appSettingsNotifWarning').checked,
      muteInfo: !document.getElementById('appSettingsNotifInfo').checked,
      // Per-event-type preferences
      eventTypes: {
        permission_prompt: {
          enabled: document.getElementById('eventPermissionEnabled').checked,
          browser: document.getElementById('eventPermissionBrowser').checked,
          push: document.getElementById('eventPermissionPush').checked,
          audio: document.getElementById('eventPermissionAudio').checked,
        },
        elicitation_dialog: {
          enabled: document.getElementById('eventQuestionEnabled').checked,
          browser: document.getElementById('eventQuestionBrowser').checked,
          push: document.getElementById('eventQuestionPush').checked,
          audio: document.getElementById('eventQuestionAudio').checked,
        },
        idle_prompt: {
          enabled: document.getElementById('eventIdleEnabled').checked,
          browser: document.getElementById('eventIdleBrowser').checked,
          push: document.getElementById('eventIdlePush').checked,
          audio: document.getElementById('eventIdleAudio').checked,
        },
        stop: {
          enabled: document.getElementById('eventStopEnabled').checked,
          browser: document.getElementById('eventStopBrowser').checked,
          push: document.getElementById('eventStopPush').checked,
          audio: document.getElementById('eventStopAudio').checked,
        },
        session_error: {
          enabled: true,
          browser: this.notificationManager?.preferences?.eventTypes?.session_error?.browser ?? true,
          push: this.notificationManager?.preferences?.eventTypes?.session_error?.push ?? false,
          audio: false,
        },
        respawn_cycle: {
          enabled: document.getElementById('eventRespawnEnabled').checked,
          browser: document.getElementById('eventRespawnBrowser').checked,
          push: document.getElementById('eventRespawnPush').checked,
          audio: document.getElementById('eventRespawnAudio').checked,
        },
        token_milestone: {
          enabled: true,
          browser: false,
          push: false,
          audio: false,
        },
        ralph_complete: {
          enabled: document.getElementById('eventRalphEnabled').checked,
          browser: document.getElementById('eventRalphBrowser').checked,
          push: document.getElementById('eventRalphPush').checked,
          audio: document.getElementById('eventRalphAudio').checked,
        },
        subagent_spawn: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
        subagent_complete: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          push: document.getElementById('eventSubagentPush').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
      },
      _version: 4,
    };
    if (this.notificationManager) {
      this.notificationManager.preferences = notifPrefsToSave;
      this.notificationManager.savePreferences();
    }

    // Sync push preferences to server
    this._syncPushPreferences();

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();
    this.applyTabWrapSettings();
    this._updateTokensImmediate();  // Re-render token display (picks up showCost change)
    this.applyMonitorVisibility();
    this.renderProjectInsightsPanel();  // Re-render to apply visibility setting
    this.updateSubagentWindowVisibility();  // Apply subagent window visibility setting

    // Save to server (includes notification prefs for cross-browser persistence)
    // Strip device-specific keys — localEchoEnabled is per-platform (touch default differs)
    const { localEchoEnabled: _leo, ...serverSettings } = settings;
    try {
      await this._apiPut('/api/settings', { ...serverSettings, notificationPreferences: notifPrefsToSave, voiceSettings });

      // Save model configuration separately
      await this.saveModelConfigFromSettings();

      this.showToast('Settings saved', 'success');

      // Show tunnel-specific feedback if toggled on
      if (settings.tunnelEnabled) {
        this.showToast('Tunnel starting — QR code will appear when ready...', 'info');
      }
    } catch (err) {
      // Server save failed but localStorage succeeded
      this.showToast('Settings saved locally', 'warning');
    }

    this.closeAppSettings();
  },

  // Load model configuration from server for the settings modal
  async loadModelConfigForSettings() {
    try {
      const res = await fetch('/api/execution/model-config');
      const data = await res.json();
      if (data.success && data.data) {
        const config = data.data;
        // Default model
        const defaultModelEl = document.getElementById('appSettingsDefaultModel');
        if (defaultModelEl) {
          defaultModelEl.value = config.defaultModel || 'opus';
        }
        // Show recommendations
        const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
        if (showRecsEl) {
          showRecsEl.checked = config.showRecommendations ?? true;
        }
        // Agent type overrides
        const overrides = config.agentTypeOverrides || {};
        const exploreEl = document.getElementById('appSettingsModelExplore');
        const implementEl = document.getElementById('appSettingsModelImplement');
        const testEl = document.getElementById('appSettingsModelTest');
        const reviewEl = document.getElementById('appSettingsModelReview');
        if (exploreEl) exploreEl.value = overrides.explore || '';
        if (implementEl) implementEl.value = overrides.implement || '';
        if (testEl) testEl.value = overrides.test || '';
        if (reviewEl) reviewEl.value = overrides.review || '';
      }
    } catch (err) {
      console.warn('Failed to load model config:', err);
    }
  },

  // Save model configuration from settings modal to server
  async saveModelConfigFromSettings() {
    const defaultModelEl = document.getElementById('appSettingsDefaultModel');
    const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
    const exploreEl = document.getElementById('appSettingsModelExplore');
    const implementEl = document.getElementById('appSettingsModelImplement');
    const testEl = document.getElementById('appSettingsModelTest');
    const reviewEl = document.getElementById('appSettingsModelReview');

    const agentTypeOverrides = {};
    if (exploreEl?.value) agentTypeOverrides.explore = exploreEl.value;
    if (implementEl?.value) agentTypeOverrides.implement = implementEl.value;
    if (testEl?.value) agentTypeOverrides.test = testEl.value;
    if (reviewEl?.value) agentTypeOverrides.review = reviewEl.value;

    const config = {
      defaultModel: defaultModelEl?.value || 'opus',
      showRecommendations: showRecsEl?.checked ?? true,
      agentTypeOverrides,
    };

    try {
      await fetch('/api/execution/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch (err) {
      console.warn('Failed to save model config:', err);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Visibility Settings & Device-Specific Defaults
  // ═══════════════════════════════════════════════════════════════

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  },

  // Get the settings storage key based on device type (mobile vs desktop)
  getSettingsStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'codeman-app-settings-mobile' : 'codeman-app-settings';
  },

  // Get default settings based on device type
  // Note: Notification prefs are handled separately by NotificationManager
  getDefaultSettings() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    if (isMobile) {
      // Mobile defaults: minimal UI for small screens
      return {
        // Header visibility - hide everything on mobile
        showFontControls: false,
        showSystemStats: false,
        showTokenCount: false,
        showCost: false,
        // Panel visibility - hide panels on mobile (not enough space)
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
        showSubagents: false,
        // Feature toggles - keep tracking on even on mobile
        subagentTrackingEnabled: true,
        subagentActiveTabOnly: true, // Only show subagents for active tab
        imageWatcherEnabled: false,
        ralphTrackerEnabled: false,
        tabTwoRows: false,
      };
    }
    // Desktop defaults - rely on ?? operators in apply functions
    // This allows desktop to have different defaults without duplication
    return {};
  },

  loadAppSettingsFromStorage() {
    // Return cached settings if available (avoids synchronous localStorage + JSON.parse
    // on every SSE event — critical for input responsiveness)
    if (this._cachedAppSettings) return this._cachedAppSettings;
    try {
      const key = this.getSettingsStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        this._cachedAppSettings = JSON.parse(saved);
        return this._cachedAppSettings;
      }
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
    // Return device-specific defaults
    this._cachedAppSettings = this.getDefaultSettings();
    return this._cachedAppSettings;
  },

  saveAppSettingsToStorage(settings) {
    // Invalidate cache on save
    this._cachedAppSettings = settings;
    try {
      const key = this.getSettingsStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save app settings:', err);
    }
  },

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showFontControls = settings.showFontControls ?? defaults.showFontControls ?? false;
    const showSystemStats = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    const showTokenCount = settings.showTokenCount ?? defaults.showTokenCount ?? true;

    const fontControlsEl = document.querySelector('.header-font-controls');
    const systemStatsEl = document.getElementById('headerSystemStats');
    const tokenCountEl = document.getElementById('headerTokens');

    if (fontControlsEl) {
      fontControlsEl.style.display = showFontControls ? '' : 'none';
    }
    if (systemStatsEl) {
      systemStatsEl.style.display = showSystemStats ? '' : 'none';
    }
    if (tokenCountEl) {
      tokenCountEl.style.display = showTokenCount ? '' : 'none';
    }

    // Hide lifecycle log button when setting is disabled
    const showLifecycleLog = settings.showLifecycleLog ?? defaults.showLifecycleLog ?? true;
    const lifecycleBtn = document.querySelector('.btn-lifecycle-log');
    if (lifecycleBtn) {
      lifecycleBtn.style.display = showLifecycleLog ? '' : 'none';
    }

    // Hide notification bell when notifications are disabled
    const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
    const notifBtn = document.querySelector('.btn-notifications');
    if (notifBtn) {
      notifBtn.style.display = notifEnabled ? '' : 'none';
    }
    // Close the drawer if notifications got disabled while it's open
    if (!notifEnabled) {
      const drawer = document.getElementById('notifDrawer');
      if (drawer) drawer.classList.remove('open');
    }
  },

  applyTabWrapSettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const deviceType = MobileDetection.getDeviceType();
    // Two-row tabs disabled on mobile/tablet — not enough screen space
    const twoRows = deviceType === 'desktop'
      ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false)
      : false;
    const prevTallTabs = this._tallTabsEnabled;
    this._tallTabsEnabled = twoRows;
    const tabsEl = document.getElementById('sessionTabs');
    if (tabsEl) {
      tabsEl.classList.toggle('tabs-two-rows', twoRows);
      tabsEl.classList.toggle('tabs-show-folder', twoRows);
    }
    // Re-render tabs if folder visibility changed (folder spans are generated in JS)
    if (prevTallTabs !== undefined && prevTallTabs !== twoRows) {
      this._fullRenderSessionTabs();
    }
  },

  applyMonitorVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showMonitor = settings.showMonitor ?? defaults.showMonitor ?? true;
    const showSubagents = settings.showSubagents ?? defaults.showSubagents ?? false;
    const showFileBrowser = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;

    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.style.display = showMonitor ? '' : 'none';
      if (showMonitor) {
        monitorPanel.classList.add('open');
      } else {
        monitorPanel.classList.remove('open');
      }
    }

    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      if (showSubagents) {
        subagentsPanel.classList.remove('hidden');
      } else {
        subagentsPanel.classList.add('hidden');
      }
    }

    // File browser panel visibility
    const fileBrowserPanel = document.getElementById('fileBrowserPanel');
    if (fileBrowserPanel) {
      if (showFileBrowser && this.activeSessionId) {
        fileBrowserPanel.classList.add('visible');
        this.loadFileBrowser(this.activeSessionId);
        // Attach drag listeners if not already attached
        if (!this.fileBrowserDragListeners) {
          const header = fileBrowserPanel.querySelector('.file-browser-header');
          if (header) {
            // Convert right-positioned to left/top before drag so makeWindowDraggable works
            const onFirstDrag = () => {
              if (!fileBrowserPanel.style.left) {
                const rect = fileBrowserPanel.getBoundingClientRect();
                fileBrowserPanel.style.left = `${rect.left}px`;
                fileBrowserPanel.style.top = `${rect.top}px`;
                fileBrowserPanel.style.right = 'auto';
              }
            };
            header.addEventListener('mousedown', onFirstDrag);
            header.addEventListener('touchstart', onFirstDrag, { passive: true });
            this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
            this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
          }
        }
      } else {
        fileBrowserPanel.classList.remove('visible');
      }
    }
  },

  closeMonitor() {
    // Hide the monitor panel
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.classList.remove('open');
      monitorPanel.style.display = 'none';
    }
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showMonitor = false;
    this.saveAppSettingsToStorage(settings);
  },

  closeSubagentsPanel() {
    // Hide the subagents panel
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
      subagentsPanel.classList.add('hidden');
    }
    this.subagentPanelVisible = false;
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showSubagents = false;
    this.saveAppSettingsToStorage(settings);
  },

  async clearAllSubagents() {
    const count = this.subagents.size;
    if (count === 0) {
      this.showToast('No subagents to clear', 'info');
      return;
    }

    if (!confirm(`Clear all ${count} tracked subagent(s)? This removes them from the UI but does not affect running processes.`)) {
      return;
    }

    try {
      const res = await fetch('/api/subagents', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Clear local state
        this.subagents.clear();
        this.subagentActivity.clear();
        this.subagentToolResults.clear();
        // Close any open subagent windows
        this.cleanupAllFloatingWindows();
        // Update UI
        this.renderSubagentPanel();
        this.renderMonitorSubagents();
        this.updateSubagentBadge();
        this.showToast(`Cleared ${data.data.cleared} subagent(s)`, 'success');
      } else {
        this.showToast('Failed to clear subagents: ' + data.error, 'error');
      }
    } catch (err) {
      this.showToast('Failed to clear subagents', 'error');
    }
  },

  toggleSubagentsPanel() {
    const panel = document.getElementById('subagentsPanel');
    const toggleBtn = document.getElementById('subagentsToggleBtn');
    if (!panel) return;

    // If hidden, show it first
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      // Save setting
      const settings = this.loadAppSettingsFromStorage();
      settings.showSubagents = true;
      this.saveAppSettingsToStorage(settings);
    }

    // Toggle open/collapsed state
    panel.classList.toggle('open');
    this.subagentPanelVisible = panel.classList.contains('open');

    // Update toggle button icon
    if (toggleBtn) {
      toggleBtn.innerHTML = this.subagentPanelVisible ? '&#x25BC;' : '&#x25B2;'; // Down when open, up when collapsed
    }

    if (this.subagentPanelVisible) {
      this.renderSubagentPanel();
    }
  },

  async loadAppSettingsFromServer(settingsPromise = null) {
    try {
      const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null);
      if (settings) {
        // Extract notification prefs before merging app settings
        const { notificationPreferences, voiceSettings, respawnPresets, runMode, ...appSettings } = settings;
        // Filter out display settings — these are device-specific (mobile vs desktop)
        // and should not be synced from the server to avoid overriding mobile defaults.
        // NOTE: Feature toggles (subagentTrackingEnabled, imageWatcherEnabled, ralphTrackerEnabled)
        // are NOT display keys — they control server-side behavior and must sync from server.
        const displayKeys = new Set([
          'showFontControls', 'showSystemStats', 'showTokenCount', 'showCost',
          'showMonitor', 'showProjectInsights', 'showFileBrowser', 'showSubagents',
          'subagentActiveTabOnly', 'tabTwoRows', 'localEchoEnabled',
        ]);
        // Merge settings: non-display keys always sync from server,
        // display keys only seed from server when localStorage has no value
        // (prevents cross-device overwrite while fixing settings re-enabling on fresh loads)
        const localSettings = this.loadAppSettingsFromStorage();
        const merged = { ...localSettings };
        for (const [key, value] of Object.entries(appSettings)) {
          if (displayKeys.has(key)) {
            // Display keys: only use server value as initial seed
            if (!(key in localSettings)) {
              merged[key] = value;
            }
          } else {
            // Non-display keys: server always wins
            merged[key] = value;
          }
        }
        this.saveAppSettingsToStorage(merged);

        // Apply notification prefs from server if present (only if localStorage has none)
        if (notificationPreferences && this.notificationManager) {
          const localNotifPrefs = localStorage.getItem(this.notificationManager.getStorageKey());
          if (!localNotifPrefs) {
            this.notificationManager.preferences = notificationPreferences;
            this.notificationManager.savePreferences();
          }
        }

        // Sync voice settings from server (seed localStorage if no local API key)
        if (voiceSettings) {
          const localVoice = localStorage.getItem('codeman-voice-settings');
          if (!localVoice || !JSON.parse(localVoice).apiKey) {
            VoiceInput._saveDeepgramConfig(voiceSettings);
          }
        }

        // Sync respawn presets from server (server is source of truth)
        if (respawnPresets && Array.isArray(respawnPresets)) {
          this._serverRespawnPresets = respawnPresets;
          // Also update localStorage for offline access
          localStorage.setItem('codeman-respawn-presets', JSON.stringify(respawnPresets));
        } else {
          // Migration: push existing localStorage presets to server
          const localPresets = localStorage.getItem('codeman-respawn-presets');
          if (localPresets) {
            const parsed = JSON.parse(localPresets);
            if (parsed.length > 0) {
              this._serverRespawnPresets = parsed;
              this._apiPut('/api/settings', { respawnPresets: parsed }).catch(() => {});
            }
          }
        }

        // Sync run mode from server
        if (runMode) {
          this.runMode = runMode;
          try { localStorage.setItem('codeman_runMode', runMode); } catch {}
          this._applyRunMode();
        }

        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  },


  /**
   * Load subagent window states from server (or localStorage fallback).
   * Called on page load to restore minimized/open window states.
   */
  async loadSubagentWindowStates() {
    let states = null;

    // Try server first for cross-browser sync
    try {
      const res = await fetch('/api/subagent-window-states');
      if (res.ok) {
        states = await res.json();
        // Also update localStorage
        localStorage.setItem('codeman-subagent-window-states', JSON.stringify(states));
      }
    } catch (err) {
      console.error('Failed to load subagent window states from server:', err);
    }

    // Fallback to localStorage
    if (!states) {
      try {
        const saved = localStorage.getItem('codeman-subagent-window-states');
        if (saved) {
          states = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent window states from localStorage:', err);
      }
    }

    return states || { minimized: {}, open: [] };
  },


  // ═══════════════════════════════════════════════════════════════
  // Persistent Parent Associations
  // ═══════════════════════════════════════════════════════════════
  // This is the ROCK-SOLID system for tracking which tab an agent belongs to.
  // Once an agent's parent is discovered, it's saved here PERMANENTLY.

  /**
   * Save the subagent parent map to localStorage and server.
   * Called whenever a new parent association is discovered.
   */
  async saveSubagentParentMap() {
    const mapData = Object.fromEntries(this.subagentParentMap);

    // Save to localStorage for instant recovery
    try {
      localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
    } catch (err) {
      console.error('Failed to save subagent parents to localStorage:', err);
    }

    // Save to server for cross-browser/session persistence
    try {
      await fetch('/api/subagent-parents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapData)
      });
    } catch (err) {
      console.error('Failed to save subagent parents to server:', err);
    }
  },

  /**
   * Load the subagent parent map from server (or localStorage fallback).
   * Called once on page load, before any agents are discovered.
   */
  async loadSubagentParentMap() {
    let mapData = null;

    // Try server first (most authoritative)
    try {
      const res = await fetch('/api/subagent-parents');
      if (res.ok) {
        mapData = await res.json();
        // Update localStorage as cache
        localStorage.setItem('codeman-subagent-parents', JSON.stringify(mapData));
      }
    } catch (err) {
      console.error('Failed to load subagent parents from server:', err);
    }

    // Fallback to localStorage
    if (!mapData) {
      try {
        const saved = localStorage.getItem('codeman-subagent-parents');
        if (saved) {
          mapData = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent parents from localStorage:', err);
      }
    }

    // Populate the map (prune stale entries: require both session and agent to exist)
    if (mapData && typeof mapData === 'object') {
      for (const [agentId, sessionId] of Object.entries(mapData)) {
        if (this.sessions.has(sessionId) && this.subagents.has(agentId)) {
          this.subagentParentMap.set(agentId, sessionId);
        }
      }
    }
  },

  /**
   * Get the parent session ID for an agent from the persistent map.
   * This is the ONLY source of truth for connection lines.
   */
  getAgentParentSessionId(agentId) {
    return this.subagentParentMap.get(agentId) || null;
  },

  /**
   * Set and persist the parent session ID for an agent.
   * Once set, this association is PERMANENT and never recalculated.
   */
  setAgentParentSessionId(agentId, sessionId) {
    if (!agentId || !sessionId) return;

    // Only set if not already set (first association wins)
    if (this.subagentParentMap.has(agentId)) {
      return; // Already has a parent, don't override
    }

    this.subagentParentMap.set(agentId, sessionId);
    this.saveSubagentParentMap(); // Persist immediately

    // Also update the agent object for consistency
    const agent = this.subagents.get(agentId);
    if (agent) {
      agent.parentSessionId = sessionId;
      const session = this.sessions.get(sessionId);
      if (session) {
        agent.parentSessionName = this.getSessionName(session);
      }
      this.subagents.set(agentId, agent);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Help Modal
  // ═══════════════════════════════════════════════════════════════

  showHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  closeAllPanels() {
    this.closeSessionOptions();
    this.closeAppSettings();
    this.cancelCloseSession();
    this.closeTokenStats();
    document.getElementById('monitorPanel').classList.remove('open');
    // Collapse subagents panel (don't hide it permanently)
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
    }
    this.subagentPanelVisible = false;
  },
});
