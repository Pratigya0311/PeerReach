// src/services/LogService.js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Share } from 'react-native';

const MAX_LOGS     = 400;
const STORAGE_KEY  = '@peerreach_logs';

const _logs = [];
let _flushTimer = null;
const _lastSeen = new Map(); // message -> timestamp (rate limit)
const RATE_LIMIT_MS = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  const d = new Date();
  return (
    d.getHours().toString().padStart(2, '0') + ':' +
    d.getMinutes().toString().padStart(2, '0') + ':' +
    d.getSeconds().toString().padStart(2, '0') + '.' +
    d.getMilliseconds().toString().padStart(3, '0')
  );
}

function fmt(args) {
  return args.map(a => {
    if (a === null)      return 'null';
    if (a === undefined) return 'undefined';
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_e) { return String(a); } }
    return String(a);
  }).join(' ');
}

function add(level, args) {
  const entry = `[${ts()}] ${level} ${fmt(args)}`;
  const key = `${level}:${entry.slice(0, 200)}`;
  const now = Date.now();
  const last = _lastSeen.get(key) || 0;
  if (now - last < RATE_LIMIT_MS) return;
  _lastSeen.set(key, now);
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift();
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_logs.slice(-MAX_LOGS))).catch(() => {});
  }, 1500);
}

// ─── Keep originals so the screen console still works ────────────────────────
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
const _origInfo  = console.info  ? console.info.bind(console) : _origLog;

// ─── Public API ──────────────────────────────────────────────────────────────

const LogService = {
  /** Call once at app entry point (index.js) — before anything else. */
  init() {
    // Restore any logs from last session
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) {
        try {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved)) {
            // Prepend saved logs so newest are at the bottom
            _logs.unshift(...saved.slice(-MAX_LOGS));
          }
        } catch (_e) {}
      }
    }).catch(() => {});

    add('SYS', [`=== App started === ${new Date().toISOString()}`]);

    console.log   = (...a) => { add('LOG', a); _origLog(...a);   };
    console.warn  = (...a) => { add('WRN', a); _origWarn(...a);  };
    console.error = (...a) => { add('ERR', a); _origError(...a); };
    console.info  = (...a) => { add('INF', a); _origInfo(...a);  };
  },

  getLogs() {
    return [..._logs];
  },

  async shareLogs() {
    const text = `PeerReach Logs — ${new Date().toISOString()}\n${'─'.repeat(60)}\n${_logs.join('\n')}`;
    try {
      await Share.share({ message: text, title: 'PeerReach Logs' });
    } catch (e) {
      _origError('LogService.shareLogs error:', e);
    }
  },

  async clearLogs() {
    _logs.length = 0;
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },
};

export default LogService;
