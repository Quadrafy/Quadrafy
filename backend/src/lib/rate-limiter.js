import { ApiError } from "./http.js";

const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_CLEANUP_INTERVAL_MS = 60_000;

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function rateLimitError(retryAfter) {
  const error = new ApiError(
    429,
    "rate_limited",
    "Muitas tentativas. Aguarde um pouco e tente novamente.",
  );
  error.retryAfter = retryAfter;
  return error;
}

export class RateLimiter {
  constructor({ limit, windowMs, maxEntries = DEFAULT_MAX_ENTRIES }) {
    this.limit = positiveSafeInteger(limit, "limit");
    this.windowMs = positiveSafeInteger(windowMs, "windowMs");
    this.maxEntries = positiveSafeInteger(maxEntries, "maxEntries");
    this.entries = new Map();
    this.cleanupIntervalMs = Math.min(this.windowMs, MAX_CLEANUP_INTERVAL_MS);
    this.nextCleanupAt = Date.now() + this.cleanupIntervalMs;
    this.nextExpiryAt = Number.POSITIVE_INFINITY;
  }

  cleanupExpired(now) {
    let nextExpiryAt = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      } else {
        nextExpiryAt = Math.min(nextExpiryAt, entry.resetAt);
      }
    }

    this.nextExpiryAt = nextExpiryAt;
    this.nextCleanupAt = now + this.cleanupIntervalMs;
  }

  consume(key) {
    const now = Date.now();
    if (now >= this.nextCleanupAt || now >= this.nextExpiryAt) {
      this.cleanupExpired(now);
    }

    const current = this.entries.get(key);
    let entry = current;

    if (!entry || entry.resetAt <= now) {
      if (entry) this.entries.delete(key);
      if (this.entries.size >= this.maxEntries) {
        const retryAt = Number.isFinite(this.nextExpiryAt)
          ? this.nextExpiryAt
          : now + this.windowMs;
        const retryAfter = Math.max(1, Math.ceil((retryAt - now) / 1000));
        throw rateLimitError(retryAfter);
      }

      entry = { count: 0, resetAt: now + this.windowMs };
      this.nextExpiryAt = Math.min(this.nextExpiryAt, entry.resetAt);
    }

    entry.count += 1;
    this.entries.set(key, entry);
    if (entry.count > this.limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw rateLimitError(retryAfter);
    }
  }

  clear(key) {
    this.entries.delete(key);
  }
}
