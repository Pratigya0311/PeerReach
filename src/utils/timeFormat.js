// src/utils/timeFormat.js
// Shared time/date formatting utilities used across screens.

/**
 * "2m ago", "3h ago", "5d ago" — used in conversation lists and device cards.
 */
export function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const diff    = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours   = Math.floor(diff / 3600000);
  const days    = Math.floor(diff / 86400000);
  if (minutes < 1)  return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24)   return `${hours}h ago`;
  if (days < 7)     return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * "Just now", "45s ago", "3m ago", "2h ago" — finer granularity for last-seen labels.
 */
export function formatLastSeen(timestamp) {
  if (!timestamp) return null;
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 30)  return 'Just now';
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * "02:30 pm" — short time for message timestamps inside chat bubbles.
 */
export function formatTime(timestamp) {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).toLowerCase();
  } catch (_e) {
    return '';
  }
}

/**
 * "Mar 18 · 02:30 pm" — used in the delivery info panel.
 */
export function formatDateTime(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );
}

/**
 * "3s", "1m", "2h" — human-readable elapsed duration between two timestamps.
 */
export function formatElapsed(fromTs, toTs) {
  if (!fromTs || !toTs) return null;
  const ms = toTs - fromTs;
  if (ms < 1000)  return '<1s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}
