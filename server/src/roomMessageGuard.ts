export class RoomMessageGuard {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  allow(sessionId: string, channel: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (!sessionId || !channel || limit <= 0 || windowMs <= 0) return false;
    const key = `${sessionId}\u0000${channel}`;
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= windowMs || now < current.startedAt) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  forget(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) this.buckets.delete(key);
    }
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

export function payloadWithinLimit(raw: unknown, maxBytes: number): boolean {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  try {
    const encoded = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof encoded !== 'string') return false;
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}