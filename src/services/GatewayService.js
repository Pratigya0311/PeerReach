// src/services/GatewayService.js
// Crowdsourced Opportunistic Internet Gateway over BLE Mesh
import databaseService from './DatabaseService';

// ── Groq API key ──────────────────────────────────────────────────────────────
// Get your key from https://console.groq.com/ and replace the placeholder below.
const GROQ_API_KEY = '';

// Android's own connectivity check endpoint — always returns exactly 204, never redirects to captive portal pages
const CONNECTIVITY_URLS = [
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://www.google.com/generate_204',
  'https://clients3.google.com/generate_204',
];
const DEFAULT_TTL = 5;
const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may','might',
  'what','whats','who','where','when','why','how','which',
  'in','on','at','to','for','of','and','or','but','with','from',
  'me','my','i','you','your','it','its','this','that',
]);
const MAX_CACHE_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SEEN_MESSAGES_MAX = 200;
const REQUEST_TIMEOUT_MS = 30 * 1000;  // 30s before store-and-forward
const RETRY_INTERVAL_MS = 30 * 1000;   // retry queued requests every 30s

class GatewayService {
  constructor() {
    this.seenMessages = new Map();     // id → timestamp (dedup)
    this.pendingRequests = new Map();  // requestId → { resolve, reject, query, timer }
    this.pendingQueue = [];            // store-and-forward: requests waiting for internet
    this.myDeviceId = null;
    this.bridgefyService = null;       // injected via init()
    this.onQueryResultCallback = null; // called when a response arrives
    this.retryTimer = null;

    // Internet check cache — avoid hammering the network on every relay packet
    this._internetCheckResult = false;
    this._internetCheckTime   = 0;

    this._startRetryTimer();
  }

  // Called once BridgefyService is ready
  init(bridgefyService) {
    this.bridgefyService = bridgefyService;
  }

  setMyDeviceId(id) {
    this.myDeviceId = id;
  }

  // UI screens register here to receive async responses
  setOnQueryResultCallback(cb) {
    this.onQueryResultCallback = cb;
  }

  // ── Internet connectivity check ─────────────────────────────────────────────

  async checkInternet() {
    // Return cached result if fresh — prevents hammering the network on every incoming relay packet
    if (Date.now() - this._internetCheckTime < 10000) {
      return this._internetCheckResult;
    }

    // Try each URL in order — first 204 response wins.
    // Strictly checking status === 204 prevents captive portal login pages (which return 200) from
    // being mistaken for real internet connectivity.
    let result = false;
    for (const url of CONNECTIVITY_URLS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
          console.log('[Gateway] checkInternet →', url, 'status:', res.status);
          if (res.status === 204) { result = true; break; }
        } finally {
          clearTimeout(timeout);
        }
      } catch (_e) {
        // This URL failed — try the next one
      }
    }

    this._internetCheckResult = result;
    this._internetCheckTime   = Date.now();
    console.log('[Gateway] checkInternet → cached result:', result);
    return result;
  }

  // ── Query type detection ────────────────────────────────────────────────────

  _isWeatherQuery(query) {
    return /\b(weather|forecast|temperature|temp|rain|sunny|cloudy|humid|wind|climate|hot|cold)\b/i.test(query);
  }

  _extractLocation(query) {
    // Strip weather keywords to get the city/location
    return query
      .replace(/^(what[''\u2018\u2019]?s|what is|how is|how[''\u2018\u2019]?s|tell me|show me)\s+/i, '')
      .replace(/\b(weather|forecast|temperature|temp|rain|sunny|cloudy|humid|wind|climate|hot|cold|in|at|for|the|of|current|today|tomorrow)\b/gi, '')
      .replace(/[^\w\s]/g, '')
      .trim()
      .replace(/\s+/g, ' ') || 'auto';
  }

  // ── Query normalization for cache key ───────────────────────────────────────
  // Strips stop words and punctuation so "what is the capital of France" and
  // "capital france" both hit the same cache entry.

  _normalizeQuery(query) {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 0 && !STOP_WORDS.has(w))
      .join(' ')
      .trim();
  }

  // ── Individual API fetchers ─────────────────────────────────────────────────

  _makeSignal(ms) {
    // AbortSignal.timeout() is the clean built-in (no timer to leak).
    // Fall back to the manual approach on older Hermes builds.
    if (typeof AbortSignal?.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  // Standard browser-like headers to avoid WAF/bot challenges
  get _headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/json',
    };
  }

  _toKeywords(query) {
    // Strip question prefixes and filler words to get the core topic noun phrase.
    // "how to survive in mountains" → "survive mountains"
    // "what is the capital of france" → "capital france"
    return query
      .replace(/^(how (do|does|to|can|should|would)|what (is|are|was|were|does)|who (is|was|are)|where (is|are)|when (did|is|was)|why (does|is|did)|explain|define|tell me about)\s+/i, '')
      .replace(/\b(the|a|an|in|on|at|of|for|to|from|with|by|about|and|or|do|does|did|is|are|was|were|be|being|been|i|you|we|they|he|she|it|its|my|your)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  async _wikiSummary(title) {
    // Fetch plain-text summary for a given Wikipedia article title.
    const slug = encodeURIComponent(title.replace(/ /g, '_'));
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
      signal: this._makeSignal(10000),
      headers: this._headers,
    });
    const text = await res.text();
    const json = JSON.parse(text);
    const extract = json?.extract?.trim();
    if (!extract || extract.length < 20) throw new Error('extract too short');
    return extract.length > 600 ? extract.substring(0, 597) + '...' : extract;
  }

  async _wikiOpenSearch(query) {
    // Returns the best matching article title via Wikipedia OpenSearch.
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`,
      { signal: this._makeSignal(10000), headers: this._headers }
    );
    const json = JSON.parse(await res.text());
    const titles = json[1];
    if (!titles || titles.length === 0) return null;
    return titles[0];
  }

  async _wikiFullTextSearch(query) {
    // Full-text search — finds articles that MENTION the query, not just title matches.
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`,
      { signal: this._makeSignal(10000), headers: this._headers }
    );
    const json = JSON.parse(await res.text());
    const hits = json?.query?.search;
    if (!hits || hits.length === 0) return null;
    return hits[0].title;
  }

  async _fetchWikipedia(query) {
    try {
      // Strategy 1: opensearch with full query
      let title = await this._wikiOpenSearch(query);

      // Strategy 2: opensearch with keywords stripped (handles "how to...", "what is...")
      if (!title) {
        const keywords = this._toKeywords(query);
        if (keywords && keywords !== query) title = await this._wikiOpenSearch(keywords);
      }

      // Strategy 3: full-text search finds articles that mention the topic
      if (!title) title = await this._wikiFullTextSearch(query);

      if (!title) throw new Error('No Wikipedia article found');

      const extract = await this._wikiSummary(title);
      console.log('📖 Wikipedia answer from:', title);
      return extract;
    } catch (e) {
      console.log('❌ Wikipedia failed:', e.message);
      throw e;
    }
  }

  async _fetchGroq(query) {
    console.log('[Groq] Starting request for query:', query);

    if (!GROQ_API_KEY || GROQ_API_KEY === '') {
      console.error('[Groq] ❌ API key is missing or not configured');
      throw new Error('Groq API key not configured');
    }
    console.log('[Groq] API key present, length:', GROQ_API_KEY.length, 'prefix:', GROQ_API_KEY.substring(0, 6));

    const requestBody = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Answer concisely in 2-3 sentences. No markdown, no bullet points.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 250,
    };
    console.log('[Groq] Sending to https://api.groq.com/openai/v1/chat/completions, model:', requestBody.model);

    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: this._makeSignal(25000),
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': this._headers['User-Agent'],
        },
        body: JSON.stringify(requestBody),
      });
    } catch (fetchErr) {
      // AbortError = timeout — fall through to Wikipedia silently
      if (fetchErr.name === 'AbortError') {
        console.warn('[Groq] ⏱ Request timed out, falling back to Wikipedia');
      } else {
        console.warn('[Groq] ⚠️ Network error:', fetchErr.message);
      }
      throw fetchErr;
    }

    console.log('[Groq] HTTP status:', res.status, res.statusText);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read body)');
      console.error('[Groq] ❌ Non-OK response. Status:', res.status, '| Body:', errBody.substring(0, 300));
      throw new Error(`Groq ${res.status}: ${errBody.substring(0, 80)}`);
    }

    let json;
    try {
      json = await res.json();
    } catch (parseErr) {
      console.error('[Groq] ❌ Failed to parse JSON response:', parseErr.message);
      throw parseErr;
    }

    console.log('[Groq] Response structure — choices:', json?.choices?.length, '| finish_reason:', json?.choices?.[0]?.finish_reason);

    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content || content.length < 5) {
      console.error('[Groq] ❌ Empty or too-short content. Full response:', JSON.stringify(json).substring(0, 300));
      throw new Error('Empty Groq response');
    }

    console.log('[Groq] ✅ Got answer, length:', content.length);
    return content.length > 800 ? content.substring(0, 797) + '...' : content;
  }

  async _fetchWeather(location) {
    // wttr.in returns a single compact line e.g. "Bangalore: +28C"
    // format=3 is the shortest format — well within BLE payload limits.
    // No location (or 'auto') → omit the path segment so wttr.in uses IP-based detection.
    const weatherUrl =
      location && location !== 'auto'
        ? `https://wttr.in/${encodeURIComponent(location)}?format=3`
        : 'https://wttr.in/?format=3';
    try {
      const res = await fetch(weatherUrl, {
        signal: this._makeSignal(10000),
        headers: this._headers,
      });
      if (!res.ok) throw new Error('wttr.in failed');
      const text = (await res.text()).trim();
      if (!text || text.includes('Unknown location')) throw new Error('Unknown location');
      return text;
    } catch (e) {
      console.log('❌ Weather failed:', e.message);
      throw e;
    }
  }

  // ── Query execution ─────────────────────────────────────────────────────────

  async executeQuery(query) {
    const normalizedKey = this._normalizeQuery(query);
    console.log('[Gateway] executeQuery — raw:', query, '| normalized key:', normalizedKey);

    // Cache-first (use normalized key)
    const cached = await this._getCached(normalizedKey);
    if (cached) {
      console.log('[Gateway] 💾 Cache hit for:', query);
      return { result: cached, source: 'cache' };
    }
    console.log('[Gateway] No cache hit, fetching live...');

    let result = null;

    // Weather queries → wttr.in only (Groq/Wikipedia have stale weather data — don't use them)
    if (this._isWeatherQuery(query)) {
      const location = this._extractLocation(query);
      console.log('[Gateway] Weather query detected, location:', location);
      try {
        result = await this._fetchWeather(location);
        console.log('[Gateway] 🌤️ Weather answer:', result);
      } catch (weatherErr) {
        console.warn('[Gateway] ⚠️ Weather fetch failed:', weatherErr.message);
        result = 'Weather information is currently unavailable. Try again later.';
      }
    }

    // General queries: Groq → Wikipedia (in priority order; skipped for weather)
    if (!result) {
      console.log('[Gateway] Trying Groq...');
      try {
        result = await this._fetchGroq(query);
        console.log('[Gateway] 🤖 Groq answer obtained');
      } catch (groqErr) {
        console.warn('[Gateway] ⚠️ Groq unavailable:', groqErr.message);
      }
    }

    if (!result) {
      console.log('[Gateway] Groq failed or skipped — trying Wikipedia...');
      try {
        result = await this._fetchWikipedia(query);
        console.log('[Gateway] 📖 Wikipedia answer obtained');
      } catch (wikiErr) {
        console.warn('[Gateway] ⚠️ Wikipedia failed:', wikiErr.message);
      }
    }

    if (!result) {
      result = `No answer found for "${query}". Try rephrasing or ask something else.`;
    }

    // Keep under ~800 chars to stay well within BLE payload limits
    if (result.length > 800) {
      result = result.substring(0, 797) + '...';
    }

    // Only cache and share real answers — don't persist the "no result" fallback string
    // so future requests still try the network instead of returning a cached error.
    const isFallback = result.startsWith('No answer found for');
    if (!isFallback) {
      await this._saveCache(normalizedKey, result);
      // Share this answer with nearby mesh nodes so they can answer later without internet
      this._broadcastCacheShare(normalizedKey, result);
    }

    return { result, source: 'internet' };
  }

  // ── Public: send a query (called from MeshQueryScreen) ─────────────────────

  // onStatus(hasInternet: bool) — called once connectivity is known, before waiting for result.
  // This lets the screen update its loading label without doing a second checkInternet() call.
  async sendQuery(query, onStatus) {
    if (!this.bridgefyService) {
      throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    }

    const hasInternet = await this.checkInternet();
    if (onStatus) onStatus(hasInternet);

    if (hasInternet) {
      // I have internet — answer locally, no mesh needed
      const { result, source } = await this.executeQuery(query);
      return { result, source, hops: 0 };
    }

    // No internet — broadcast request through the mesh
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        // Store for later (store-and-forward) — cap at 10, evict oldest
        if (this.pendingQueue.length >= 10) {
          this.pendingQueue.sort((a, b) => a.timestamp - b.timestamp);
          this.pendingQueue.shift();
        }
        this.pendingQueue.push({ requestId, query, timestamp: Date.now(), ttl: DEFAULT_TTL });
        reject(new Error('NO_GATEWAY_NEARBY'));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, query, timer });

      const packet = {
        type: 'internet_request',
        request_id: requestId,
        source: this.myDeviceId,
        query,
        ttl: DEFAULT_TTL,
        timestamp: Date.now(),
      };

      this.bridgefyService
        .sendBroadcast(JSON.stringify(packet))
        .catch(() => {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          reject(new Error('Failed to broadcast request over mesh'));
        });
    });
  }

  // ── Called by BridgefyService when a gateway-type message arrives ───────────

  async handleIncomingGatewayMessage(parsed, _senderId) {
    if (parsed.type === 'internet_request') {
      await this._handleRequest(parsed);
    } else if (parsed.type === 'internet_response') {
      this._handleResponse(parsed);
    } else if (parsed.type === 'cache_share') {
      await this._handleCacheShare(parsed);
    }
  }

  // ── Internal: handle an internet_request packet ─────────────────────────────

  async _handleRequest(message) {
    const { request_id, source, query, ttl, timestamp } = message;

    // Dedup
    if (this._seen(request_id)) return;
    this._markSeen(request_id);

    // Ignore stale requests (older than 5 minutes)
    if (Date.now() - timestamp > 5 * 60 * 1000) return;

    // Don't relay my own broadcasts back to myself
    if (source === this.myDeviceId) return;

    // Answer from cache — no internet needed
    const normalizedKey = this._normalizeQuery(query);
    const cached = await this._getCached(normalizedKey);
    if (cached) {
      console.log('💾 Answering from cache for peer:', query);
      this._sendResponse(request_id, source, cached, ttl);
      return;
    }

    // I have internet — act as gateway
    const hasInternet = await this.checkInternet();
    if (hasInternet) {
      try {
        console.log('🌐 Acting as gateway for peer query:', query);
        const { result } = await this.executeQuery(query);
        this._sendResponse(request_id, source, result, ttl);
      } catch (e) {
        console.error('Gateway query failed:', e.message);
      }
      return;
    }

    // No internet and no cache — relay with TTL decrement (Spray-and-Wait)
    if (ttl > 1) {
      const relay = { ...message, ttl: ttl - 1 };
      this.bridgefyService.sendBroadcast(JSON.stringify(relay)).catch(() => {});
    }
  }

  // ── Internal: handle an internet_response packet ────────────────────────────

  _handleResponse(message) {
    const { request_id, destination, result } = message;

    // Ignore responses not addressed to this device
    if (destination !== this.myDeviceId) return;

    // Dedup responses
    if (this._seen(`resp_${request_id}`)) return;
    this._markSeen(`resp_${request_id}`);

    // Resolve waiting promise
    const pending = this.pendingRequests.get(request_id);

    // Find in pending queue (covers case where 30s timer fired but mesh gateway responded anyway)
    const queueIdx = this.pendingQueue.findIndex(item => item.requestId === request_id);
    const queueItem = queueIdx >= 0 ? this.pendingQueue[queueIdx] : null;

    // Recover the original query text from whichever store still has it
    const queryText = pending?.query || queueItem?.query || '';

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(request_id);
      pending.resolve({ result, source: 'mesh', hops: DEFAULT_TTL - (message.ttl_remaining || 0) });
    }

    // Remove from queue if mesh answered before the retry loop ran
    if (queueItem) {
      this.pendingQueue.splice(queueIdx, 1);
    }

    // Notify screen via callback (handles the case where promise already timed out).
    // delayed=true when the 30s promise already rejected — screen must surface this as an async result.
    // delayed=false when the promise is still live — screen gets the result via the resolved promise,
    // so the callback is informational only and the screen should ignore it.
    if (this.onQueryResultCallback) {
      this.onQueryResultCallback({ request_id, result, query: queryText, delayed: !pending });
    }
  }

  _sendResponse(requestId, destination, result, ttlRemaining = DEFAULT_TTL) {
    const packet = {
      type: 'internet_response',
      request_id: requestId,
      destination,
      result,
      gateway: this.myDeviceId,
      ttl_remaining: ttlRemaining,
      timestamp: Date.now(),
    };
    // Direct delivery — don't broadcast query results to every nearby device (privacy)
    this.bridgefyService.sendDirectProtocol(destination, JSON.stringify(packet)).catch(() => {});
  }

  // ── Mesh cache sharing ──────────────────────────────────────────────────────
  // When this device fetches a fresh answer from the internet it broadcasts
  // the result to all nearby nodes. Any node that hears the share stores it
  // locally so future requests can be answered without reaching out again.

  _broadcastCacheShare(normalizedQuery, result) {
    if (!this.bridgefyService) return;
    const packet = {
      type: 'cache_share',
      query: normalizedQuery,
      result,
      source: this.myDeviceId,
      timestamp: Date.now(),
    };
    this.bridgefyService.sendBroadcast(JSON.stringify(packet)).catch(() => {});
  }

  async _handleCacheShare(message) {
    const { query, result, source, timestamp } = message;

    // Ignore our own shares (we already saved them in executeQuery)
    if (source === this.myDeviceId) return;

    // Dedup
    const dedupKey = `share_${query}_${timestamp}`;
    if (this._seen(dedupKey)) return;
    this._markSeen(dedupKey);

    // Ignore stale shares (older than 30 minutes — same as cache TTL)
    if (Date.now() - timestamp > MAX_CACHE_AGE_MS) return;

    // Save to our own cache so we can answer future requests
    await this._saveCache(query, result);
    console.log('📡 Cached from mesh share:', query);
  }

  // ── Store-and-Forward retry loop ────────────────────────────────────────────

  _startRetryTimer() {
    this.retryTimer = setInterval(async () => {
      if (this.pendingQueue.length === 0) return;

      const hasInternet = await this.checkInternet();
      if (!hasInternet) return;

      // Evict stale items before processing (no point answering a query from 30+ min ago)
      const now = Date.now();
      this.pendingQueue = this.pendingQueue.filter(
        item => (now - item.timestamp) < MAX_CACHE_AGE_MS
      );

      const toProcess = [...this.pendingQueue];
      this.pendingQueue = [];

      for (const item of toProcess) {
        try {
          const { result } = await this.executeQuery(item.query);
          if (this.onQueryResultCallback) {
            this.onQueryResultCallback({
              request_id: item.requestId,
              result,
              query: item.query,
              delayed: true,
            });
          }
        } catch (_e) {
          // Still failing — put back, but respect the cap
          if (this.pendingQueue.length < 10) {
            this.pendingQueue.push(item);
          }
        }
      }
    }, RETRY_INTERVAL_MS);
  }

  // ── Deduplication helpers ───────────────────────────────────────────────────

  _seen(id) {
    return this.seenMessages.has(id);
  }

  _markSeen(id) {
    this.seenMessages.set(id, Date.now());
    if (this.seenMessages.size > SEEN_MESSAGES_MAX) {
      // First pass: remove entries older than 5 minutes
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, ts] of this.seenMessages) {
        if (ts < cutoff) this.seenMessages.delete(k);
      }
      // If still over cap (all entries are recent), trim oldest by insertion order
      while (this.seenMessages.size > SEEN_MESSAGES_MAX) {
        this.seenMessages.delete(this.seenMessages.keys().next().value);
      }
    }
  }

  // ── Cache helpers (SQLite via DatabaseService) ──────────────────────────────

  async _getCached(query) {
    try {
      const rows = await databaseService.executeQuery(
        'SELECT result FROM gateway_cache WHERE query = ? AND timestamp > ?',
        [query.toLowerCase().trim(), Date.now() - MAX_CACHE_AGE_MS]
      );
      return rows.rows.length > 0 ? rows.rows.item(0).result : null;
    } catch (_e) {
      return null;
    }
  }

  async _saveCache(query, result) {
    try {
      await databaseService.executeQuery(
        'INSERT OR REPLACE INTO gateway_cache (query, result, timestamp) VALUES (?, ?, ?)',
        [query.toLowerCase().trim(), result, Date.now()]
      );
    } catch (_e) {
      // Non-critical — ignore
    }
  }

  // Called from MeshQueryScreen to show recent cache history
  async getCacheHistory() {
    try {
      const rows = await databaseService.executeQuery(
        'SELECT query, result, timestamp FROM gateway_cache ORDER BY timestamp DESC LIMIT 30',
        []
      );
      const items = [];
      for (let i = 0; i < rows.rows.length; i++) {
        items.push(rows.rows.item(i));
      }
      return items;
    } catch (_e) {
      return [];
    }
  }

  getPendingQueueCount() {
    return this.pendingQueue.length;
  }

  destroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }
}

export default new GatewayService();
