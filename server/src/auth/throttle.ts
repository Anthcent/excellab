import { AppError } from "../http/errors.js";

/** Fixed-window, in-memory attempt limiter. Good enough for a single app instance. */
export class Throttle {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  hit(key: string, now = Date.now()) {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.windows.size > 10_000) this.prune(now);
      return;
    }
    current.count += 1;
    if (current.count > this.limit) {
      throw new AppError(429, "TOO_MANY_ATTEMPTS", "Demasiados intentos. Espera un minuto e inténtalo de nuevo.");
    }
  }

  reset(key: string) {
    this.windows.delete(key);
  }

  prune(now = Date.now()) {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}
