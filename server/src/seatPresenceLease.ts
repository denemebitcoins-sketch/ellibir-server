import { clearSeatPresence, keepSeatPresence } from './supabase';
import type { Client } from '@colyseus/core';

export function hasOpenTransport(client: Client): boolean {
  // WebSocketClient exposes this getter; Colyseus' public Client interface does not.
  return (client as Client & { readonly readyState?: number }).readyState === 1;
}

export class SeatPresenceLeases {
  private leases = new Map<string, { timer: ReturnType<typeof setInterval>; token: object }>();

  reserve(session: string, uid: string | undefined, table: number, mode: string, started: boolean): object {
    this.stop(session);
    const token = {};
    void keepSeatPresence(uid, table, mode, false, started);
    const timer = setInterval(() => { void keepSeatPresence(uid, table, mode, false, started); }, 50000);
    this.leases.set(session, { timer, token });
    return token;
  }

  owns(session: string, token: object): boolean { return this.leases.get(session)?.token === token; }

  restore(session: string, uid: string | undefined, table: number, mode: string, started: boolean): void {
    this.stop(session);
    void keepSeatPresence(uid, table, mode, true, started);
  }

  release(session: string, uid: string | undefined, table: number, mode: string): void {
    this.stop(session);
    void clearSeatPresence(uid, table, mode);
  }

  stop(session: string): void {
    const lease = this.leases.get(session);
    if (lease) clearInterval(lease.timer);
    this.leases.delete(session);
  }

  dispose(): void { for (const session of this.leases.keys()) this.stop(session); }
}
