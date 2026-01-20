    // Register service worker for offline shell and cached config
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => {
          console.log('Service worker registered');
          // Force immediate update check
          reg.update();
        })
        .catch((err) => console.log('Service worker registration failed:', err));
    }

    // Sync hash with parent window (if in iframe)
    const isInIframe = window.parent !== window;
    let notifyParentOfHashChange;
    let notifyParentReady;

    if (isInIframe) {
      // Helper to notify parent of hash changes
      notifyParentOfHashChange = () => {
        window.parent.postMessage({ type: 'hashchange', hash: window.location.hash }, '*');
      };

      // Helper to notify parent that iframe is ready
      notifyParentReady = () => {
        window.parent.postMessage({ type: 'ready' }, '*');
      };

      // Notify parent when hash changes via hashchange event
      window.addEventListener('hashchange', notifyParentOfHashChange);

      // Listen for hash changes from parent
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'hashchange' && event.data.hash !== undefined) {
          if (window.location.hash !== event.data.hash) {
            window.location.hash = event.data.hash;
          }
        }
      });
    } else {
      // No-op when not in iframe
      notifyParentOfHashChange = () => {};
      notifyParentReady = () => {};
    }

    // Elements
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const menuBtn = document.getElementById('menu-btn');
    const newChatBtn = document.getElementById('new-chat-btn');
    const startChatBtn = document.getElementById('start-chat-btn');
    const sessionsList = document.getElementById('sessions-list');
    const chatTitle = document.getElementById('chat-title');
    const emptyState = document.getElementById('empty-state');
    const messagesEl = document.getElementById('messages');
    const inputArea = document.getElementById('input-area');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const statusEl = document.getElementById('status');
    const settingsBtn = document.getElementById('settings-btn');
    const regenerateTitleBtn = document.getElementById('regenerate-title-btn');
    const stopBtn = document.getElementById('stop-btn');
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const imagePreview = document.getElementById('image-preview');
    const imagePreviewImg = document.getElementById('image-preview-img');
    const imagePreviewName = document.getElementById('image-preview-name');
    const removeImageBtn = document.getElementById('remove-image');
    const spritesModal = document.getElementById('sprites-modal');
    const closeSpritesModal = document.getElementById('close-sprites-modal');
    const spritesList = document.getElementById('sprites-list');
    const spriteNameInput = document.getElementById('sprite-name-input');
    const spriteAddressInput = document.getElementById('sprite-address-input');
    const addSpriteBtn = document.getElementById('add-sprite-btn');
    const pullIndicator = document.getElementById('pull-indicator');
    const networkSpritesSection = document.getElementById('network-sprites-section');
    const networkSpritesList = document.getElementById('network-sprites-list');
    const refreshNetworkBtn = document.getElementById('refresh-network-btn');
    const spritesSeparator = document.getElementById('sprites-separator');
    const wakingOverlay = document.getElementById('waking-overlay');
    const switchingOverlay = document.getElementById('switching-overlay');
    const attachSessionBtn = document.getElementById('attach-session-btn');
    const externalSessionsModal = document.getElementById('external-sessions-modal');
    const closeExternalSessionsModal = document.getElementById('close-external-sessions-modal');
    const externalSessionsList = document.getElementById('external-sessions-list');

    // State
    let sessions = [];
    let currentSession = null;
    let ws = null;
    let keepaliveWs = null;
    let currentAssistantMessage = null;
    let assistantContent = '';
    let sprites = [];
    let networkSprites = [];
    let networkEnabled = false;
    let pendingImage = null; // { id, filename, mediaType, url, localUrl }
    let isEditingTitle = false;
    let messageCountSinceLastTitleUpdate = 0;

    // Detect if we're on a desktop device (has precise pointer like mouse/trackpad)
    function isDesktop() {
      return window.matchMedia('(pointer: fine)').matches;
    }
    let pendingUserMessage = false; // True while processing incoming user_message

    // Activity indicator state
    let currentToolName = null;
    let currentToolInput = '';

    // Voice input state
    let recognition = null;
    let isRecording = false;
    let voiceInputSent = false; // Prevents onresult from updating after send

    // Tool name to human-readable action mapping
    const toolActions = {
      'Read': { action: 'Reading', getDetail: (input) => input?.file_path },
      'Write': { action: 'Writing', getDetail: (input) => input?.file_path },
      'Edit': { action: 'Editing', getDetail: (input) => input?.file_path },
      'Bash': { action: 'Running', getDetail: (input) => input?.command?.slice(0, 60) },
      'Grep': { action: 'Searching', getDetail: (input) => input?.pattern ? `"${input.pattern}"` : null },
      'Glob': { action: 'Finding files', getDetail: (input) => input?.pattern },
      'Task': { action: 'Working on subtask', getDetail: (input) => input?.description },
      'WebFetch': { action: 'Fetching', getDetail: (input) => input?.url },
      'WebSearch': { action: 'Searching web', getDetail: (input) => input?.query },
      'LSP': { action: 'Analyzing code', getDetail: (input) => input?.operation },
      'TodoWrite': { action: 'Updating tasks', getDetail: () => null },
      'AskUserQuestion': { action: 'Asking question', getDetail: () => null },
      'NotebookEdit': { action: 'Editing notebook', getDetail: (input) => input?.notebook_path },
    };

    function getToolAction(toolName) {
      return toolActions[toolName] || { action: `Using ${toolName}`, getDetail: () => null };
    }

    function truncatePath(path, maxLen = 40) {
      if (!path || path.length <= maxLen) return path;
      // Show the end of the path (most relevant part)
      return '...' + path.slice(-(maxLen - 3));
    }

    // Keepalive WebSocket - keeps sprite awake while app is open
    function connectKeepalive() {
      if (keepaliveWs && keepaliveWs.readyState === WebSocket.OPEN) return;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      keepaliveWs = new WebSocket(`${protocol}//${location.host}/ws/keepalive`);

      keepaliveWs.onopen = () => {
        console.log('Keepalive connected - sprite will stay awake');
      };

      keepaliveWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'reload') {
            console.log('Server requested reload (via keepalive)');
            location.reload();
          }
        } catch {}
      };

      keepaliveWs.onclose = () => {
        console.log('Keepalive disconnected');
        // Reconnect after a short delay
        setTimeout(connectKeepalive, 2000);
      };

      keepaliveWs.onerror = () => {
        console.log('Keepalive error');
      };
    }

    // Keepalive will be connected after sprite wakes up in init()

    // Public URL keepalive - pings the public URL every 30 seconds to keep sprite awake
    let spritePublicUrl = null;
    let spriteName = 'Sprite Mobile'; // Default, will be updated from publicUrl
    let publicKeepaliveInterval = null;

    // Extract and sanitize hostname from public URL
    function getSpriteNameFromUrl(url) {
      if (!url) return null;
      try {
        const hostname = new URL(url).hostname;
        // Extract subdomain (first part before first dot)
        const subdomain = hostname.split('.')[0];
        // Sanitize: only allow alphanumeric, hyphens, underscores
        const sanitized = subdomain.replace(/[^a-zA-Z0-9\-_]/g, '');
        return sanitized || null;
      } catch {
        return null;
      }
    }

    // Update displayed sprite name
    function updateSpriteName(name) {
      spriteName = name || 'Sprite MObile';
      const emojiHtml = '<span class="sprite-emoji">👾</span>';
      const displayHtml = `${escapeHtml(spriteName)} ${emojiHtml}`;
      // Update header title if showing empty state
      if (emptyState.style.display !== 'none') {
        chatTitle.innerHTML = displayHtml;
      }
      // Update welcome message
      const welcomeH2 = emptyState.querySelector('h2');
      if (welcomeH2) {
        welcomeH2.innerHTML = `Welcome to ${displayHtml}`;
      }
      // Update page title
      document.title = spriteName;
    }

    // Get cached config from service worker
    function getCachedConfig() {
      return new Promise((resolve) => {
        if (!navigator.serviceWorker?.controller) {
          resolve(null);
          return;
        }

        const timeout = setTimeout(() => resolve(null), 1000);

        const handler = (event) => {
          if (event.data?.type === 'CACHED_CONFIG') {
            clearTimeout(timeout);
            navigator.serviceWorker.removeEventListener('message', handler);
            resolve(event.data.config);
          }
        };

        navigator.serviceWorker.addEventListener('message', handler);
        navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHED_CONFIG' });
      });
    }

    // Cache config in service worker
    function cacheConfig(config) {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_CONFIG', config });
      }
    }

    // Hide the waking overlay with animation
    function hideWakingOverlay() {
      wakingOverlay.classList.add('hidden');
      setTimeout(() => wakingOverlay.classList.add('removed'), 300);
    }

    // Log to the waking overlay for debugging
    const wakingLog = document.getElementById('waking-log');
    function wakeLog(msg) {
      console.log('[wake]', msg);
      if (wakingLog) {
        const entry = document.createElement('div');
        entry.className = 'wlog-entry';
        entry.textContent = msg;
        wakingLog.appendChild(entry);
        wakingLog.scrollTop = wakingLog.scrollHeight;
      }
    }

    // Try to fetch config from sprite, with retries
    async function fetchConfigWithRetry(maxRetries = 10, delay = 1000) {
      for (let i = 0; i < maxRetries; i++) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const res = await fetch(`/api/config?_t=${Date.now()}`, { signal: controller.signal });
          clearTimeout(timeout);

          if (res.ok) {
            return await res.json();
          }
        } catch (err) {
          console.log(`Config fetch attempt ${i + 1}/${maxRetries} failed, retrying...`);
        }

        if (i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delay));
        }
      }
      return null;
    }

    // Wake up sprite using cached or fresh public URL
    async function wakeUpSprite() {
      wakeLog('Starting wake-up...');
      wakeLog('SW controller: ' + (navigator.serviceWorker?.controller ? 'yes' : 'no'));

      // First, try to get cached config from service worker
      const cachedConfig = await getCachedConfig();
      wakeLog('Cached config: ' + (cachedConfig ? JSON.stringify(cachedConfig) : 'none'));

      if (cachedConfig?.publicUrl) {
        spritePublicUrl = cachedConfig.publicUrl;
        updateSpriteName(cachedConfig.spriteName || getSpriteNameFromUrl(spritePublicUrl));
        wakeLog('Pinging: ' + spritePublicUrl);

        // Ping the public URL to wake the sprite
        try {
          await fetch(spritePublicUrl, { mode: 'no-cors', cache: 'no-store' });
          wakeLog('Ping sent OK');
        } catch (err) {
          wakeLog('Ping error: ' + err.message);
        }

        // Wait for sprite to actually respond
        wakeLog('Waiting for sprite...');
        const config = await fetchConfigWithRetry();
        if (config) {
          wakeLog('Sprite responded!');
          spritePublicUrl = config.publicUrl;
          updateSpriteName(config.spriteName || getSpriteNameFromUrl(spritePublicUrl));
          cacheConfig(config);
          startPublicKeepalive();
          return true;
        }
        wakeLog('Sprite did not respond');
      }

      // No cached config or wake failed - try fetching directly
      // (sprite might already be awake)
      wakeLog('Trying direct connection...');
      try {
        const config = await fetchConfigWithRetry(3, 500);
        if (config?.publicUrl) {
          wakeLog('Direct connection OK');
          spritePublicUrl = config.publicUrl;
          updateSpriteName(config.spriteName || getSpriteNameFromUrl(spritePublicUrl));
          cacheConfig(config);
          startPublicKeepalive();
          return true;
        }
      } catch (err) {
        wakeLog('Direct failed: ' + err.message);
      }

      wakeLog('Could not reach sprite');
      return false;
    }

    function startPublicKeepalive() {
      if (!spritePublicUrl || publicKeepaliveInterval) return;

      // Ping every 30 seconds
      publicKeepaliveInterval = setInterval(pingPublicUrl, 30000);
    }

    function pingPublicUrl() {
      if (!spritePublicUrl) return;

      fetch(spritePublicUrl, { mode: 'no-cors', cache: 'no-store' })
        .then(() => console.log('Public keepalive ping sent'))
        .catch(() => console.log('Public keepalive ping failed'));
    }

    // Configure marked
    marked.setOptions({
      highlight: (code, lang) => {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true,
    });

    // Sidebar toggle
    function openSidebar() {
      sidebar.classList.add('open');
      overlay.classList.add('visible');
    }

    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible');
    }

    menuBtn.addEventListener('click', openSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Swipe to close sidebar
    let sidebarTouchStartX = 0;
    let sidebarTouchCurrentX = 0;
    let isSidebarSwiping = false;

    sidebar.addEventListener('touchstart', (e) => {
      if (!sidebar.classList.contains('open')) return;
      sidebarTouchStartX = e.touches[0].clientX;
      sidebarTouchCurrentX = sidebarTouchStartX;
      isSidebarSwiping = true;
      sidebar.style.transition = 'none';
    }, { passive: true });

    sidebar.addEventListener('touchmove', (e) => {
      if (!isSidebarSwiping) return;
      sidebarTouchCurrentX = e.touches[0].clientX;
      const diff = sidebarTouchCurrentX - sidebarTouchStartX;
      if (diff < 0) {
        sidebar.style.transform = `translateX(${diff}px)`;
        overlay.style.opacity = Math.max(0, 1 + diff / 280);
      }
    }, { passive: true });

    sidebar.addEventListener('touchend', () => {
      if (!isSidebarSwiping) return;
      isSidebarSwiping = false;
      sidebar.style.transition = '';
      sidebar.style.transform = '';
      overlay.style.opacity = '';

      const diff = sidebarTouchCurrentX - sidebarTouchStartX;
      if (diff < -80) {
        closeSidebar();
      }
    });

    // Sessions API
    async function loadSessions() {
      const res = await fetch('/api/sessions');
      sessions = await res.json();
      renderSessionsList();
      return sessions;
    }

    async function createSession(name) {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const session = await res.json();
      sessions.unshift(session);
      renderSessionsList();
      selectSession(session);
      closeSidebar();
    }

    async function deleteSession(id, e) {
      e.stopPropagation();
      e.preventDefault();

      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      sessions = sessions.filter(s => s.id !== id);
      if (currentSession?.id === id) {
        currentSession = null;
        disconnectWs();
        showEmptyState();
      }
      renderSessionsList();
    }

    function renderSessionsList() {
      sessionsList.innerHTML = sessions.map(s => `
        <div class="session-item ${currentSession?.id === s.id ? 'active' : ''}" data-id="${s.id}">
          <div class="session-name">
            <span>${escapeHtml(s.name)}</span>
            <button class="session-delete" onclick="deleteSession('${s.id}', event)">×</button>
          </div>
          <div class="session-preview">${escapeHtml(s.lastMessage || 'No messages yet')}</div>
          <div class="session-time">${formatTime(s.lastMessageAt)}</div>
        </div>
      `).join('');

      sessionsList.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', () => {
          const session = sessions.find(s => s.id === el.dataset.id);
          if (session) {
            selectSession(session);
            closeSidebar();
          }
        });
      });
    }

    function formatTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function selectSession(session) {
      currentSession = session;
      chatTitle.textContent = session.name;
      emptyState.style.display = 'none';
      messagesEl.classList.add('active');
      inputArea.classList.add('active');
      messagesEl.innerHTML = '';
      renderSessionsList();
      connectWs(session.id);
      regenerateTitleBtn.classList.add('visible');
      messageCountSinceLastTitleUpdate = 0;
      // Update URL hash to persist session across refreshes
      history.replaceState(null, '', `#session=${session.id}`);
      // Manually notify parent since history.replaceState doesn't trigger hashchange
      notifyParentOfHashChange();
    }

    function showEmptyState() {
      currentSession = null;
      const emojiHtml = '<span class="sprite-emoji">👾</span>';
      chatTitle.innerHTML = `${escapeHtml(spriteName)} ${emojiHtml}`;
      emptyState.style.display = 'flex';
      messagesEl.classList.remove('active');
      inputArea.classList.remove('active');
      statusEl.textContent = 'Disconnected';
      statusEl.className = '';
      regenerateTitleBtn.classList.remove('visible');
      // Clear URL hash when no session selected
      history.replaceState(null, '', location.pathname);
      // Manually notify parent since history.replaceState doesn't trigger hashchange
      notifyParentOfHashChange();
    }

    // WebSocket
    let currentWsSessionId = null;

    function connectWs(sessionId) {
      // Clear any pending reconnect
      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
      }

      // Close old connection without triggering reconnect for it
      if (ws) {
        const oldWs = ws;
        ws = null;
        oldWs.onclose = null; // Prevent onclose from firing
        oldWs.close();
      }

      currentWsSessionId = sessionId;
      intentionalDisconnect = false;
      currentAssistantMessage = null;
      assistantContent = '';

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws?session=${sessionId}`);

      ws.onopen = () => {
        console.log('[Client] WebSocket connected to session:', sessionId);
        statusEl.textContent = 'Connected';
        statusEl.className = 'connected';
        sendBtn.disabled = false;
        wsReconnectAttempts = 0; // Reset on successful connection
      };

      ws.onclose = () => {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'error';
        sendBtn.disabled = true;
        scheduleReconnect();
      };

      ws.onerror = () => {
        statusEl.textContent = 'Error';
        statusEl.className = 'error';
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type !== 'content_block_delta') { // Don't log every streaming delta
            console.log('[Client] Received message type:', msg.type);
          }
          handleMessage(msg);
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };
    }

    let wsReconnectTimeout = null;
    let wsReconnectAttempts = 0;
    let intentionalDisconnect = false;

    function disconnectWs() {
      intentionalDisconnect = true;
      currentWsSessionId = null;
      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
        wsReconnectTimeout = null;
      }
      if (ws) {
        ws.onclose = null; // Prevent onclose from triggering reconnect
        ws.close();
        ws = null;
      }
      currentAssistantMessage = null;
      assistantContent = '';
      wsReconnectAttempts = 0;
    }

    function scheduleReconnect() {
      if (intentionalDisconnect || !currentWsSessionId) return;

      // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
      wsReconnectAttempts++;

      statusEl.textContent = `Reconnecting in ${Math.round(delay/1000)}s...`;
      statusEl.className = 'error';

      const sessionToReconnect = currentWsSessionId;
      wsReconnectTimeout = setTimeout(() => {
        // Only reconnect if we're still trying to connect to the same session
        if (currentWsSessionId === sessionToReconnect && !intentionalDisconnect) {
          statusEl.textContent = 'Reconnecting...';
          connectWs(sessionToReconnect);
        }
      }, delay);
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case 'system':
          if (msg.message && !msg.message.includes('Connected')) {
            addSystemMessage(msg.message);
          }
          break;

        case 'reload':
          // Server detected file changes - reload the page
          console.log('Server requested reload');
          location.reload();
          break;

        case 'history':
          // Render stored message history - clear first to avoid duplicates
          console.log('[Client] Received history:', msg.messages?.length, 'messages');
          if (msg.messages && Array.isArray(msg.messages)) {
            messagesEl.innerHTML = '';
            currentAssistantMessage = null;
            assistantContent = '';
            for (const m of msg.messages) {
              if (m.role === 'user') {
                // Build image URL if message has an attached image
                const imageUrl = m.image ? `/api/uploads/${currentSession.id}/${m.image.filename}` : null;
                addUserMessage(m.content, imageUrl);
              } else if (m.role === 'assistant') {
                addStoredAssistantMessage(m.content);
              }
            }
            console.log('[Client] Rendered', msg.messages.length, 'messages from history');
          }
          break;

        case 'refresh_sessions':
          // Refresh sidebar and update current chat title if changed
          loadSessions().then(() => {
            if (currentSession) {
              const updated = sessions.find(s => s.id === currentSession.id);
              if (updated && updated.name !== currentSession.name) {
                currentSession.name = updated.name;
                chatTitle.textContent = updated.name;
              }
            }
          });
          break;

        case 'processing':
          // Claude is still working (reconnected to running process)
          if (msg.isProcessing) {
            showThinkingIndicator();
          }
          break;

        case 'user_message':
          // Another client sent a message - display it and show thinking
          // Set flag to ensure user message is rendered before assistant starts
          pendingUserMessage = true;
          if (msg.message) {
            const m = msg.message;
            const imageUrl = m.image ? `/api/uploads/${currentSession.id}/${m.image.filename}` : null;
            addUserMessage(m.content, imageUrl);
            showThinkingIndicator();
          }
          // Small delay to ensure DOM update completes
          requestAnimationFrame(() => {
            pendingUserMessage = false;
          });
          break;

        case 'assistant':
          // Wait for any pending user message to render first
          if (pendingUserMessage) {
            requestAnimationFrame(() => {
              if (msg.message?.content) {
                handleAssistantContent(msg.message.content);
              }
              if (msg.stop_reason) {
                finalizeAssistantMessage();
              }
            });
          } else {
            if (msg.message?.content) {
              handleAssistantContent(msg.message.content);
            }
            if (msg.stop_reason) {
              finalizeAssistantMessage();
            }
          }
          break;

        case 'content_block_start':
          // Wait for any pending user message to render first
          if (pendingUserMessage) {
            requestAnimationFrame(() => {
              if (msg.content_block?.type === 'text') {
                startAssistantMessage();
              } else if (msg.content_block?.type === 'tool_use') {
                addToolIndicator(msg.content_block.name);
              }
            });
          } else {
            if (msg.content_block?.type === 'text') {
              startAssistantMessage();
            } else if (msg.content_block?.type === 'tool_use') {
              addToolIndicator(msg.content_block.name);
            }
          }
          break;

        case 'content_block_delta':
          // Wait for any pending user message to render first
          if (pendingUserMessage) {
            requestAnimationFrame(() => {
              handleContentBlockDelta(msg);
            });
          } else {
            handleContentBlockDelta(msg);
          }
          break;

        case 'message_stop':
          finalizeAssistantMessage();
          break;

        case 'result':
          // Claude finished responding - clean up and focus input on desktop
          removeToolIndicator();
          finalizeAssistantMessage();
          disableStopButton();
          if (isDesktop()) {
            inputEl.focus();
          }
          break;
      }
      scrollToBottom();
    }

    function handleAssistantContent(content) {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            startAssistantMessage();
            appendAssistantText(block.text);
          } else if (block.type === 'tool_use') {
            addToolIndicator(block.name, block.input);
          }
        }
      } else if (typeof content === 'string') {
        startAssistantMessage();
        appendAssistantText(content);
      }
    }

    function handleContentBlockDelta(msg) {
      if (msg.delta?.type === 'text_delta') {
        appendAssistantText(msg.delta.text);
      } else if (msg.delta?.type === 'input_json_delta' && currentToolName) {
        // Accumulate tool input JSON
        currentToolInput += msg.delta.partial_json || '';

        // Try to parse and update indicator with details
        try {
          const parsed = JSON.parse(currentToolInput);
          const toolInfo = getToolAction(currentToolName);
          const detail = toolInfo.getDetail(parsed);
          if (detail) {
            updateActivityIndicator(detail);
          }
        } catch {
          // JSON not complete yet, that's fine
        }
      }
    }

    function startAssistantMessage() {
      if (!currentAssistantMessage) {
        removeThinkingIndicator();
        removeToolIndicator();
        currentAssistantMessage = document.createElement('div');
        currentAssistantMessage.className = 'message assistant';
        currentAssistantMessage.innerHTML = `
          <div class="message-header">Claude</div>
          <div class="message-content streaming"></div>
        `;
        messagesEl.appendChild(currentAssistantMessage);
        assistantContent = '';
      }
    }

    function appendAssistantText(text) {
      if (!currentAssistantMessage) startAssistantMessage();
      assistantContent += text;
      const contentEl = currentAssistantMessage.querySelector('.message-content');
      contentEl.innerHTML = marked.parse(assistantContent);
      contentEl.classList.add('streaming');
      scrollToBottom();
    }

    function finalizeAssistantMessage() {
      removeToolIndicator();
      disableStopButton();
      if (currentAssistantMessage) {
        const contentEl = currentAssistantMessage.querySelector('.message-content');
        contentEl.classList.remove('streaming');
        contentEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
        currentAssistantMessage = null;
        assistantContent = '';
        // Track for auto title regeneration
        maybeAutoRegenerateTitle();
        // Auto-focus input on desktop (not mobile to avoid keyboard popup)
        if (isDesktop()) {
          inputEl.focus();
        }
      }
    }

    function addUserMessage(text, imageUrl = null) {
      const msg = document.createElement('div');
      msg.className = 'message user';
      let imageHtml = '';
      if (imageUrl) {
        imageHtml = `<img src="${imageUrl}" class="message-image" style="max-width: 200px; max-height: 200px; border-radius: 8px; margin-bottom: 8px; display: block;">`;
      }
      // Escape HTML but preserve newlines by converting them to <br> tags
      const formattedText = text ? escapeHtml(text).replace(/\n/g, '<br>') : '';
      msg.innerHTML = `
        <div class="message-header">You</div>
        <div class="message-content">${imageHtml}${formattedText}</div>
      `;
      messagesEl.appendChild(msg);
      scrollToBottom();
    }

    function addStoredAssistantMessage(text) {
      const msg = document.createElement('div');
      msg.className = 'message assistant';
      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';
      contentEl.innerHTML = marked.parse(text);
      contentEl.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
      msg.innerHTML = `<div class="message-header">Claude</div>`;
      msg.appendChild(contentEl);
      messagesEl.appendChild(msg);
      scrollToBottom();
    }

    function addSystemMessage(text) {
      const msg = document.createElement('div');
      msg.className = 'message system';
      msg.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
      messagesEl.appendChild(msg);
      scrollToBottom();
    }

    function showActivityIndicator(action, detail = null) {
      removeActivityIndicator();
      removeThinkingIndicator();
      enableStopButton();
      const indicator = document.createElement('div');
      indicator.className = 'activity-indicator';
      indicator.innerHTML = `
        <div class="activity-spinner"></div>
        <div class="activity-content">
          <div class="activity-action">${escapeHtml(action)}...</div>
          ${detail ? `<div class="activity-detail">${escapeHtml(truncatePath(detail))}</div>` : ''}
        </div>
      `;
      messagesEl.appendChild(indicator);
      scrollToBottom();
    }

    function updateActivityIndicator(detail) {
      const indicator = messagesEl.querySelector('.activity-indicator');
      if (indicator) {
        let detailEl = indicator.querySelector('.activity-detail');
        if (detail) {
          if (!detailEl) {
            detailEl = document.createElement('div');
            detailEl.className = 'activity-detail';
            indicator.querySelector('.activity-content').appendChild(detailEl);
          }
          detailEl.textContent = truncatePath(detail);
        }
      }
    }

    function removeActivityIndicator() {
      const indicators = messagesEl.querySelectorAll('.activity-indicator');
      indicators.forEach(ind => ind.remove());
      // Reset tool state
      currentToolName = null;
      currentToolInput = '';
    }

    function addToolIndicator(toolName, toolInput = null) {
      finalizeAssistantMessage();
      currentToolName = toolName;
      currentToolInput = '';

      const toolInfo = getToolAction(toolName);
      let detail = null;

      if (toolInput) {
        try {
          const parsed = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
          detail = toolInfo.getDetail(parsed);
        } catch {}
      }

      showActivityIndicator(toolInfo.action, detail);
    }

    function removeToolIndicator() {
      removeActivityIndicator();
    }

    function showThinkingIndicator() {
      removeThinkingIndicator();
      removeActivityIndicator();
      const indicator = document.createElement('div');
      indicator.className = 'thinking-indicator';
      indicator.innerHTML = `
        <div class="thinking-dots">
          <span></span><span></span><span></span>
        </div>
        <span class="thinking-text">Claude is thinking...</span>
      `;
      messagesEl.appendChild(indicator);
      scrollToBottom();
      enableStopButton();
    }

    function removeThinkingIndicator() {
      const indicator = messagesEl.querySelector('.thinking-indicator');
      if (indicator) indicator.remove();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function scrollToBottom() {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }

    function send() {
      // Stop voice recording if active
      if (recognition && isRecording) {
        voiceInputSent = true; // Prevent onresult from re-populating input
        recognition.stop();
      }

      const text = inputEl.value.trim();
      const hasImage = pendingImage !== null;

      // Need either text or image to send
      if ((!text && !hasImage) || !ws || ws.readyState !== WebSocket.OPEN) return;

      // Build message payload
      const payload = { type: 'user', content: text };
      if (hasImage) {
        payload.imageId = pendingImage.id;
        payload.imageFilename = pendingImage.filename;
        payload.imageMediaType = pendingImage.mediaType;
      }

      // Reset assistant state before adding user message to ensure clean ordering
      currentAssistantMessage = null;
      assistantContent = '';

      addUserMessage(text, hasImage ? pendingImage.localUrl : null);
      ws.send(JSON.stringify(payload));
      showThinkingIndicator();

      // Clear input and image
      inputEl.value = '';
      inputEl.style.height = 'auto';
      clearPendingImage();

      // Blur to dismiss keyboard on mobile
      inputEl.blur();
    }

    function sendStop() {
      // Send interrupt signal (ESC) to Claude process
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const payload = { type: 'interrupt' };
      ws.send(JSON.stringify(payload));

      // Disable stop button and clean up indicators
      disableStopButton();
      removeThinkingIndicator();
      removeActivityIndicator();
      removeToolIndicator();
    }

    function enableStopButton() {
      if (stopBtn) {
        stopBtn.disabled = false;
      }
    }

    function disableStopButton() {
      if (stopBtn) {
        stopBtn.disabled = true;
      }
    }

    function clearPendingImage() {
      if (pendingImage?.localUrl) {
        URL.revokeObjectURL(pendingImage.localUrl);
      }
      pendingImage = null;
      imagePreview.classList.remove('has-image');
      imagePreviewImg.src = '';
      imagePreviewName.textContent = '';
    }

    // Resize image if too large (max 2048px on longest side)
    async function resizeImage(file, maxSize = 2048) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;

          // If image is small enough, return original
          if (width <= maxSize && height <= maxSize) {
            resolve(file);
            return;
          }

          // Calculate new dimensions
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }

          // Draw to canvas and export
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            resolve(new File([blob], file.name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.85);
        };
        img.src = URL.createObjectURL(file);
      });
    }

    async function uploadImage(file) {
      if (!currentSession) return;

      // Resize if needed
      const resizedFile = await resizeImage(file);

      const formData = new FormData();
      formData.append('file', resizedFile);

      try {
        const res = await fetch(`/api/upload?session=${currentSession.id}`, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          throw new Error(await res.text());
        }

        const data = await res.json();

        // Create local URL for preview
        const localUrl = URL.createObjectURL(file);

        pendingImage = {
          id: data.id,
          filename: data.filename,
          mediaType: data.mediaType,
          url: data.url,
          localUrl,
        };

        // Show preview
        imagePreviewImg.src = localUrl;
        imagePreviewName.textContent = file.name;
        imagePreview.classList.add('has-image');
      } catch (err) {
        console.error('Upload failed:', err);
        alert('Failed to upload image');
      }
    }

    // Title editing
    function startEditingTitle() {
      if (!currentSession || isEditingTitle) return;
      isEditingTitle = true;
      chatTitle.classList.add('editing');
      const currentName = currentSession.name;
      chatTitle.innerHTML = `<input type="text" id="title-input" value="${escapeHtml(currentName)}">`;
      const titleInput = document.getElementById('title-input');
      titleInput.focus();
      titleInput.select();

      titleInput.addEventListener('blur', () => finishEditingTitle(titleInput.value));
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleInput.blur();
        } else if (e.key === 'Escape') {
          titleInput.value = currentName;
          titleInput.blur();
        }
      });
    }

    async function finishEditingTitle(newName) {
      if (!isEditingTitle) return;
      isEditingTitle = false;
      chatTitle.classList.remove('editing');

      newName = newName.trim();
      if (!newName) newName = currentSession.name;

      chatTitle.textContent = newName;

      if (newName !== currentSession.name && currentSession) {
        currentSession.name = newName;
        await fetch(`/api/sessions/${currentSession.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        loadSessions();
      }
    }

    async function regenerateTitle() {
      if (!currentSession) return;
      regenerateTitleBtn.classList.add('spinning');

      try {
        const res = await fetch(`/api/sessions/${currentSession.id}/regenerate-title`, {
          method: 'POST',
        });

        if (res.ok) {
          const data = await res.json();
          currentSession.name = data.name;
          chatTitle.textContent = data.name;
          loadSessions();
          messageCountSinceLastTitleUpdate = 0;
        }
      } catch (err) {
        console.error('Failed to regenerate title:', err);
      } finally {
        regenerateTitleBtn.classList.remove('spinning');
      }
    }

    // Auto-regenerate title periodically (every 6 assistant messages)
    function maybeAutoRegenerateTitle() {
      messageCountSinceLastTitleUpdate++;
      if (messageCountSinceLastTitleUpdate >= 6 && currentSession) {
        regenerateTitle();
      }
    }

    chatTitle.addEventListener('click', (e) => {
      if (currentSession && !isEditingTitle) {
        startEditingTitle();
      }
    });

    regenerateTitleBtn.addEventListener('click', regenerateTitle);

    // Event listeners
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', sendStop);
    newChatBtn.addEventListener('click', () => createSession());
    startChatBtn.addEventListener('click', () => createSession());

    // Image upload handlers
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        uploadImage(file);
      }
      fileInput.value = ''; // Reset so same file can be selected again
    });
    removeImageBtn.addEventListener('click', clearPendingImage);

    // Prevent zoom on double-tap
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    }, false);

    // Make deleteSession global for onclick
    window.deleteSession = deleteSession;

    // Sprites management
    function openSpritesModal() {
      loadSprites();
      if (networkEnabled) {
        loadNetworkSprites();
      }
      spritesModal.classList.add('open');
    }

    function closeSpritesModalFn() {
      spritesModal.classList.remove('open');
      spriteNameInput.value = '';
      spriteAddressInput.value = '';
    }

    async function loadSprites() {
      const res = await fetch('/api/sprites');
      sprites = await res.json();
      renderSpritesList();
    }

    function getCurrentSpriteAddress() {
      // Get current host without port
      return location.hostname;
    }

    // Update the current sprite's publicUrl in the sprites list
    async function updateCurrentSpritePublicUrl(publicUrl) {
      if (!publicUrl) return;

      const currentAddr = getCurrentSpriteAddress();
      const sprite = sprites.find(s => s.address === currentAddr);

      if (sprite && sprite.publicUrl !== publicUrl) {
        // Update the sprite's publicUrl
        try {
          await fetch(`/api/sprites/${sprite.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicUrl }),
          });
          sprite.publicUrl = publicUrl;
          console.log(`Updated sprite ${sprite.name} publicUrl to ${publicUrl}`);
        } catch (err) {
          console.log('Failed to update sprite publicUrl:', err);
        }
      }
    }

    function renderSpritesList() {
      const currentAddr = getCurrentSpriteAddress();

      if (sprites.length === 0) {
        spritesList.innerHTML = '<div class="sprites-empty">No sprites saved yet. Add one below!</div>';
        return;
      }

      spritesList.innerHTML = sprites.map(s => {
        const isCurrent = s.address === currentAddr;
        return `
          <div class="sprite-item ${isCurrent ? 'current' : ''}" data-id="${s.id}" data-address="${s.address}" data-port="${s.port}" data-publicurl="${escapeHtml(s.publicUrl || '')}">
            <div class="sprite-info">
              <div class="sprite-name">
                ${escapeHtml(s.name)}
                ${isCurrent ? '<span class="sprite-current-badge">Current</span>' : ''}
              </div>
              <div class="sprite-address">${escapeHtml(s.address)}:${s.port}</div>
            </div>
            <button class="sprite-delete" onclick="deleteSprite('${s.id}', event)">×</button>
          </div>
        `;
      }).join('');

      spritesList.querySelectorAll('.sprite-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('sprite-delete')) return;
          const address = el.dataset.address;
          const port = el.dataset.port;
          const publicUrl = el.dataset.publicurl || '';
          navigateToSprite(address, port, publicUrl);
        });
      });
    }

    async function addSprite() {
      const name = spriteNameInput.value.trim();
      const address = spriteAddressInput.value.trim();

      if (!name || !address) {
        alert('Please enter both name and address');
        return;
      }

      await fetch('/api/sprites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, address, port: 8080 }),
      });

      spriteNameInput.value = '';
      spriteAddressInput.value = '';
      loadSprites();
    }

    async function deleteSprite(id, e) {
      e.stopPropagation();
      if (!confirm('Delete this sprite?')) return;
      await fetch(`/api/sprites/${id}`, { method: 'DELETE' });
      loadSprites();
    }

    async function navigateToSprite(address, port, publicUrl) {
      const protocol = location.protocol;
      const targetUrl = `${protocol}//${address}:${port}`;

      // Close the sprites modal
      closeSpritesModalFn();

      // Navigate immediately - if publicUrl exists, use it (tailnet-gate handles wake)
      // Otherwise navigate to direct URL
      const navigationUrl = publicUrl || targetUrl;
      console.log('Switching to sprite:', navigationUrl);
      window.location.href = navigationUrl;
    }

    // Make deleteSprite global for onclick
    window.deleteSprite = deleteSprite;

    // Network sprites management
    async function checkNetworkStatus() {
      try {
        const res = await fetch('/api/network/status');
        const status = await res.json();
        networkEnabled = status.enabled;
        if (networkEnabled && networkSpritesSection) {
          networkSpritesSection.style.display = 'block';
        }
      } catch (err) {
        console.log('Network status check failed:', err);
      }
    }

    async function loadNetworkSprites() {
      if (!networkEnabled) return;

      try {
        const res = await fetch('/api/network/sprites');
        networkSprites = await res.json();
        renderNetworkSpritesList();
      } catch (err) {
        console.log('Failed to load network sprites:', err);
      }
    }

    function renderNetworkSpritesList() {
      if (!networkSpritesList) return;

      // Filter out self and sort by status/name
      const otherSprites = networkSprites
        .filter(s => !s.isSelf)
        .sort((a, b) => {
          const statusOrder = { online: 0, recent: 1, offline: 2 };
          const statusDiff = statusOrder[a.status] - statusOrder[b.status];
          if (statusDiff !== 0) return statusDiff;
          return (a.displayName || a.hostname).localeCompare(b.displayName || b.hostname);
        });

      if (otherSprites.length === 0) {
        networkSpritesList.innerHTML = '<div class="sprites-empty">No other sprites in network</div>';
        if (spritesSeparator) spritesSeparator.style.display = 'none';
        return;
      }

      // Show separator if we have manual sprites too
      if (spritesSeparator) {
        spritesSeparator.style.display = sprites.length > 0 ? 'flex' : 'none';
      }

      networkSpritesList.innerHTML = otherSprites.map(s => `
        <div class="sprite-item network ${s.status}"
             data-hostname="${escapeHtml(s.hostname)}"
             data-tailscale-url="${escapeHtml(s.tailscaleUrl || '')}"
             data-public-url="${escapeHtml(s.publicUrl || '')}">
          <div class="sprite-status ${s.status}" title="${s.status}"></div>
          <div class="sprite-info">
            <div class="sprite-name">${escapeHtml(s.displayName || s.hostname)}</div>
            <div class="sprite-address">${escapeHtml(s.hostname)}</div>
            ${s.ownerEmail ? `<div class="sprite-owner">${escapeHtml(s.ownerEmail)}</div>` : ''}
          </div>
          <button class="sprite-delete-btn" title="Remove from network" data-hostname="${escapeHtml(s.hostname)}">×</button>
        </div>
      `).join('');

      // Click handlers for network sprites
      networkSpritesList.querySelectorAll('.sprite-item').forEach(el => {
        el.addEventListener('click', (e) => {
          // Ignore if clicking delete button
          if (e.target.classList.contains('sprite-delete-btn')) return;
          const tailscaleUrl = el.dataset.tailscaleUrl;
          const publicUrl = el.dataset.publicUrl;
          if (tailscaleUrl) {
            navigateToNetworkSprite(tailscaleUrl, publicUrl);
          }
        });
      });

      // Delete button handlers
      networkSpritesList.querySelectorAll('.sprite-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const hostname = btn.dataset.hostname;
          if (!confirm(`Remove "${hostname}" from the sprite network?`)) return;
          try {
            const res = await fetch(`/api/network/sprites/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
            if (res.ok) {
              await loadNetworkSprites();
            } else {
              const data = await res.json();
              alert(`Failed to delete: ${data.error || 'Unknown error'}`);
            }
          } catch (err) {
            alert(`Failed to delete: ${err.message}`);
          }
        });
      });
    }

    async function navigateToNetworkSprite(tailscaleUrl, publicUrl) {
      // Close the sprites modal
      closeSpritesModalFn();

      // Navigate immediately - publicUrl if in iframe or available, otherwise Tailscale URL
      // The tailnet-gate at publicUrl handles sprite wake-up automatically
      if (isInIframe && publicUrl) {
        // In iframe: navigate parent window to public URL (updates address bar)
        console.log('[iframe] Switching to sprite via public URL:', publicUrl);
        window.parent.location.href = publicUrl;
      } else if (publicUrl) {
        // Not in iframe but have public URL: use it
        console.log('Switching to sprite via public URL:', publicUrl);
        window.location.href = publicUrl;
      } else {
        // No public URL: navigate directly to Tailscale URL
        console.log('Switching to sprite via Tailscale URL:', tailscaleUrl);
        window.location.href = tailscaleUrl;
      }
    }

    // Check network status on startup
    checkNetworkStatus();

    // Sprites modal event listeners
    settingsBtn.addEventListener('click', openSpritesModal);
    closeSpritesModal.addEventListener('click', closeSpritesModalFn);
    spritesModal.addEventListener('click', (e) => {
      if (e.target === spritesModal) closeSpritesModalFn();
    });
    addSpriteBtn.addEventListener('click', addSprite);
    spriteAddressInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addSprite();
    });
    if (refreshNetworkBtn) {
      refreshNetworkBtn.addEventListener('click', loadNetworkSprites);
    }

    // Tasks modal
    const tasksBtn = document.getElementById('tasks-btn');
    const tasksModal = document.getElementById('tasks-modal');
    const closeTasksModal = document.getElementById('close-tasks-modal');
    const refreshTasksBtn = document.getElementById('refresh-tasks-btn');
    const myTasksList = document.getElementById('my-tasks-list');
    const allTasksStatus = document.getElementById('all-tasks-status');
    const allTasksList = document.getElementById('all-tasks-list');

    function openTasksModal() {
      loadTasks();
      tasksModal.classList.add('open');
    }

    function closeTasksModalFn() {
      tasksModal.classList.remove('open');
    }

    async function loadTasks() {
      // Load my tasks
      myTasksList.innerHTML = '<div class="loading">Loading...</div>';
      try {
        const res = await fetch('/api/distributed-tasks/mine');
        const data = await res.json();

        if (data.error) {
          myTasksList.innerHTML = `<div class="empty">${escapeHtml(data.error)}</div>`;
        } else {
          const { current, queued } = data;
          const myTasks = [current, ...queued].filter(Boolean);

          if (myTasks.length === 0) {
            myTasksList.innerHTML = '<div class="empty">No tasks assigned</div>';
          } else {
            myTasksList.innerHTML = myTasks.map(task => renderTask(task)).join('');
          }
        }
      } catch (err) {
        myTasksList.innerHTML = '<div class="error">Failed to load tasks</div>';
      }

      // Load all sprites status
      allTasksStatus.innerHTML = '<div class="loading">Loading...</div>';
      try {
        const res = await fetch('/api/distributed-tasks/status');
        const data = await res.json();

        if (data.error) {
          allTasksStatus.innerHTML = `<div class="empty">${escapeHtml(data.error)}</div>`;
        } else {
          if (data.sprites.length === 0) {
            allTasksStatus.innerHTML = '<div class="empty">No sprites with tasks</div>';
          } else {
            allTasksStatus.innerHTML = data.sprites.map(sprite => `
              <div class="sprite-status-item">
                <div class="sprite-status-name">${escapeHtml(sprite.spriteName)}</div>
                <div class="sprite-status-tasks">
                  ${sprite.current ? `Working on: ${escapeHtml(sprite.current.title)}` : 'No current task'}
                  ${sprite.queuedCount > 0 ? ` (${sprite.queuedCount} queued)` : ''}
                </div>
              </div>
            `).join('');
          }
        }
      } catch (err) {
        allTasksStatus.innerHTML = '<div class="error">Failed to load status</div>';
      }

      // Load all tasks
      allTasksList.innerHTML = '<div class="loading">Loading...</div>';
      try {
        const res = await fetch('/api/distributed-tasks');
        const data = await res.json();

        if (data.error) {
          allTasksList.innerHTML = `<div class="empty">${escapeHtml(data.error)}</div>`;
        } else {
          if (data.tasks.length === 0) {
            allTasksList.innerHTML = '<div class="empty">No tasks</div>';
          } else {
            allTasksList.innerHTML = data.tasks
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
              .map(task => renderTask(task)).join('');
          }
        }
      } catch (err) {
        allTasksList.innerHTML = '<div class="error">Failed to load tasks</div>';
      }
    }

    function renderTask(task) {
      const createdAt = new Date(task.createdAt);
      const statusLabel = task.status.replace('_', ' ');

      // Show action buttons for tasks that aren't completed, failed, or abandoned
      const showActions = task.status !== 'completed' && task.status !== 'failed' && task.status !== 'abandoned';

      return `
        <div class="task-item status-${task.status}">
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="task-meta">
            Assigned to: ${escapeHtml(task.assignedTo)} by ${escapeHtml(task.assignedBy)} |
            Status: ${statusLabel} |
            Created: ${formatTime(createdAt.getTime())}
          </div>
          ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
          ${task.result ? `
            <div class="task-result">
              <strong>${task.result.success ? '✓ Completed' : '✗ Failed'}:</strong> ${escapeHtml(task.result.summary)}
              ${task.result.error ? `<br><span style="color: #ef4444">${escapeHtml(task.result.error)}</span>` : ''}
            </div>
          ` : ''}
          ${showActions ? `
            <div class="task-actions">
              <button class="task-action-btn cancel-btn" data-task-id="${task.id}">Cancel</button>
              <button class="task-action-btn reassign-btn" data-task-id="${task.id}">Reassign</button>
            </div>
          ` : ''}
        </div>
      `;
    }

    async function cancelTask(taskId) {
      if (!confirm('Are you sure you want to cancel this task?')) {
        return;
      }

      try {
        const res = await fetch(`/api/distributed-tasks/${taskId}/cancel`, {
          method: 'POST',
        });

        const data = await res.json();

        if (data.error) {
          alert(`Failed to cancel task: ${data.error}`);
        } else {
          alert('Task cancelled successfully');
          loadTasks(); // Refresh the task list
        }
      } catch (err) {
        alert('Failed to cancel task');
      }
    }

    async function reassignTask(taskId) {
      // Fetch available sprites
      let sprites = [];
      try {
        const res = await fetch('/api/distributed-tasks/status');
        const data = await res.json();
        if (!data.error) {
          sprites = data.sprites.map(s => s.spriteName);
        }
      } catch (err) {
        console.error('Failed to fetch sprites:', err);
      }

      // Prompt user for new sprite name
      const newSprite = prompt(
        `Enter the sprite name to reassign this task to${sprites.length > 0 ? '\n\nAvailable sprites:\n' + sprites.join('\n') : ''}:`
      );

      if (!newSprite || newSprite.trim() === '') {
        return;
      }

      try {
        const res = await fetch(`/api/distributed-tasks/${taskId}/reassign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedTo: newSprite.trim() }),
        });

        const data = await res.json();

        if (data.error) {
          alert(`Failed to reassign task: ${data.error}`);
        } else {
          alert('Task reassigned successfully');
          loadTasks(); // Refresh the task list
        }
      } catch (err) {
        alert('Failed to reassign task');
      }
    }

    // Event delegation for task action buttons
    myTasksList.addEventListener('click', (e) => {
      if (e.target.classList.contains('cancel-btn')) {
        const taskId = e.target.getAttribute('data-task-id');
        cancelTask(taskId);
      } else if (e.target.classList.contains('reassign-btn')) {
        const taskId = e.target.getAttribute('data-task-id');
        reassignTask(taskId);
      }
    });

    allTasksList.addEventListener('click', (e) => {
      if (e.target.classList.contains('cancel-btn')) {
        const taskId = e.target.getAttribute('data-task-id');
        cancelTask(taskId);
      } else if (e.target.classList.contains('reassign-btn')) {
        const taskId = e.target.getAttribute('data-task-id');
        reassignTask(taskId);
      }
    });

    tasksBtn.addEventListener('click', openTasksModal);
    closeTasksModal.addEventListener('click', closeTasksModalFn);
    tasksModal.addEventListener('click', (e) => {
      if (e.target === tasksModal) closeTasksModalFn();
    });
    refreshTasksBtn.addEventListener('click', loadTasks);

    // External sessions modal (attach to CLI sessions)
    function openExternalSessionsModal() {
      externalSessionsModal.classList.add('open');
      loadExternalSessions();
    }

    function closeExternalSessionsModalFn() {
      externalSessionsModal.classList.remove('open');
    }

    async function loadExternalSessions() {
      externalSessionsList.innerHTML = '<div class="loading">Loading sessions...</div>';

      try {
        const res = await fetch('/api/claude-sessions');
        const cliSessions = await res.json();

        if (cliSessions.length === 0) {
          externalSessionsList.innerHTML = '<div class="empty">No CLI sessions found</div>';
          return;
        }

        externalSessionsList.innerHTML = cliSessions.map(s => `
          <div class="external-session-item" data-session-id="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd)}">
            <div class="session-preview">${escapeHtml(s.preview || 'No preview available')}</div>
            <div class="session-cwd">${escapeHtml(s.cwd)}</div>
            <div class="session-meta">
              <span>${formatTime(s.lastModified)}</span>
              <span>${formatSize(s.size)}</span>
            </div>
            <div class="session-id">${escapeHtml(s.sessionId)}</div>
          </div>
        `).join('');

        // Add click handlers
        externalSessionsList.querySelectorAll('.external-session-item').forEach(el => {
          el.addEventListener('click', () => {
            const sessionId = el.dataset.sessionId;
            const cwd = el.dataset.cwd;
            attachToExternalSession(sessionId, cwd);
          });
        });
      } catch (err) {
        console.error('Failed to load external sessions:', err);
        externalSessionsList.innerHTML = '<div class="empty">Failed to load sessions</div>';
      }
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function attachToExternalSession(claudeSessionId, cwd) {
      closeExternalSessionsModalFn();
      closeSidebar();

      // Create a new session that attaches to the external Claude session
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'CLI Session',
          cwd: cwd,
          claudeSessionId: claudeSessionId,
        }),
      });
      const session = await res.json();
      sessions.unshift(session);
      renderSessionsList();
      selectSession(session);
    }

    // External sessions modal event listeners
    attachSessionBtn.addEventListener('click', openExternalSessionsModal);
    closeExternalSessionsModal.addEventListener('click', closeExternalSessionsModalFn);
    externalSessionsModal.addEventListener('click', (e) => {
      if (e.target === externalSessionsModal) closeExternalSessionsModalFn();
    });

    let pullStartY = 0;
    let isPulling = false;
    let pullDistance = 0;
    let pullStartedOnHeader = false;
    const PULL_THRESHOLD = 80;
    const headerEl = document.querySelector('header');

    function canPullRefresh(fromHeader = false) {
      // Only allow pull refresh when sidebar/modal are closed
      if (sidebar.classList.contains('open')) return false;
      if (spritesModal.classList.contains('open')) return false;
      if (externalSessionsModal.classList.contains('open')) return false;

      // If started on header, always allow
      if (fromHeader || pullStartedOnHeader) return true;

      // Check if messages area is at top or we're in empty state
      if (messagesEl.classList.contains('active')) {
        return messagesEl.scrollTop <= 0;
      }
      return true; // Empty state, always allow
    }

    document.addEventListener('touchstart', (e) => {
      // Check if touch started on header
      pullStartedOnHeader = headerEl && headerEl.contains(e.target);

      if (!canPullRefresh(pullStartedOnHeader)) return;
      pullStartY = e.touches[0].clientY;
      isPulling = true;
      pullDistance = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isPulling || !canPullRefresh()) return;

      const currentY = e.touches[0].clientY;
      pullDistance = currentY - pullStartY;

      // Only show indicator when pulling down
      if (pullDistance > 0) {
        // Calculate indicator position (max 80px down)
        const progress = Math.min(pullDistance / PULL_THRESHOLD, 1);
        const translateY = -60 + (progress * 80);

        pullIndicator.style.transform = `translateX(-50%) translateY(${translateY}px)`;
        pullIndicator.style.transition = 'none';
        pullIndicator.classList.add('visible');

        if (pullDistance >= PULL_THRESHOLD) {
          pullIndicator.classList.add('ready');
        } else {
          pullIndicator.classList.remove('ready');
        }
      } else {
        pullIndicator.classList.remove('visible', 'ready');
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (!isPulling) return;
      isPulling = false;
      pullStartedOnHeader = false;

      pullIndicator.style.transition = '';

      if (pullDistance >= PULL_THRESHOLD) {
        // Trigger refresh
        pullIndicator.classList.remove('ready');
        pullIndicator.classList.add('refreshing');

        // Save current session before reload
        if (currentSession) {
          localStorage.setItem('lastSessionId', currentSession.id);
        }

        // Small delay for visual feedback, then reload
        setTimeout(() => {
          window.location.reload();
        }, 300);
      } else {
        // Reset indicator
        pullIndicator.classList.remove('visible', 'ready');
        pullIndicator.style.transform = '';
      }

      pullDistance = 0;
    }, { passive: true });

    // Voice input (Speech Recognition)
    const micBtn = document.getElementById('mic-btn');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      let finalTranscript = '';
      let originalInputText = '';

      recognition.onstart = () => {
        isRecording = true;
        voiceInputSent = false;
        micBtn.classList.add('recording');
        finalTranscript = '';
        // Save the original input text before we start modifying it
        originalInputText = inputEl.value;
      };

      recognition.onend = () => {
        isRecording = false;
        micBtn.classList.remove('recording');
      };

      recognition.onerror = (event) => {
        console.log('Speech recognition error:', event.error);
        isRecording = false;
        micBtn.classList.remove('recording');
        if (event.error === 'not-allowed') {
          alert('Microphone access denied. Please enable microphone permissions.');
        }
      };

      recognition.onresult = (event) => {
        // Don't update input if we already sent the message
        if (voiceInputSent) return;

        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }
        // Replace entire input with: original text + final + interim
        const spacer = originalInputText && !originalInputText.endsWith(' ') ? ' ' : '';
        inputEl.value = originalInputText + spacer + finalTranscript + interimTranscript;
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
      };

      micBtn.addEventListener('click', () => {
        if (!currentSession) return;

        if (isRecording) {
          recognition.stop();
        } else {
          finalTranscript = '';
          recognition.start();
        }
      });
    } else {
      // Hide mic button if not supported
      micBtn.classList.add('unsupported');
    }

    // Init - wake up sprite first, then load sessions
    async function init() {
      // Try to wake up the sprite (uses cached public URL if available)
      const spriteAwake = await wakeUpSprite();

      if (!spriteAwake) {
        // Sprite couldn't be reached - show error in overlay
        const wakingText = wakingOverlay.querySelector('.waking-text');
        const wakingSubtext = wakingOverlay.querySelector('.waking-subtext');
        if (wakingText) wakingText.textContent = 'Could not reach sprite';
        if (wakingSubtext) wakingSubtext.textContent = 'Check your connection and try again';

        // Keep trying in background
        setTimeout(init, 5000);
        return;
      }

      // Sprite is awake - hide overlay and load app
      hideWakingOverlay();

      // Refresh service worker cache while we have network access
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'REFRESH_CACHE' });
      }

      // Start keepalive WebSocket now that sprite is awake
      connectKeepalive();

      // Load sprites list and update current sprite's publicUrl
      await loadSprites();
      if (spritePublicUrl) {
        await updateCurrentSpritePublicUrl(spritePublicUrl);
      }

      // Now load sessions and restore state
      await loadSessions();

      // Check URL hash for session ID (e.g., #session=abc123)
      const hashMatch = location.hash.match(/^#session=(.+)$/);
      const hashSessionId = hashMatch ? hashMatch[1] : null;

      // Restore session from URL hash, or fallback to localStorage
      const lastSessionId = hashSessionId || localStorage.getItem('lastSessionId');
      if (lastSessionId) {
        localStorage.removeItem('lastSessionId');
        const session = sessions.find(s => s.id === lastSessionId);
        if (session) {
          selectSession(session);
        } else if (hashSessionId) {
          // Session from hash not found, clear the hash
          history.replaceState(null, '', location.pathname);
          notifyParentOfHashChange();
        }
      }

      // Notify parent that iframe is ready (for unauthorized detection)
      notifyParentReady();
    }

    init();
