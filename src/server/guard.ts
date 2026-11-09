import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-window rate limit per client IP, held in memory. Enough for one instance on a free host;
 * it resets on restart, which is acceptable because it only guards against bursts and spam.
 */
export function rateLimit(opts: { max: number; windowMs: number; message: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: opts.message });
    }
    next();
  };
}

/** Baseline response headers. No CSP yet: Bryntum injects inline styles and needs a tested policy first. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

export interface Limits {
  workspacesPerHour: number;
  reservationsPerHour: number;
  cancelsPerHour: number;
}

export const DEFAULT_LIMITS: Limits = { workspacesPerHour: 20, reservationsPerHour: 40, cancelsPerHour: 40 };
