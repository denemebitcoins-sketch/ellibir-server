import { Router, Request } from 'express';
import { resolveClientProfileMeta, supabaseConfigured, verifyToken } from '../supabase';
import { PopulationStorage } from './storage';

export async function authorizePopulationAdmin(req: Request): Promise<string> {
  const header = req.header('authorization') ?? '';
  if (!/^Bearer \S+$/i.test(header) || header.length > 8192) throw new Error('auth_required');
  if (!supabaseConfigured()) throw new Error('server_not_configured');
  const uid = await verifyToken(header.slice(7));
  if (!uid) throw new Error('auth_required');
  const meta = await resolveClientProfileMeta(uid, {}, '');
  if (meta.role !== 'admin') throw new Error('admin_required');
  return uid;
}
export function populationAdminRouter(storage: PopulationStorage, refresh: () => Promise<void>, now = Date.now): Router {
  const router = Router();
  const recent = { report: new Map<string, number>(), running: new Map<string, number>(), draining: new Map<string, number>() };
  const admit = (uid: string, channel: 'report' | 'running' | 'draining', res: any): boolean => {
    const time = now();
    const bucket = recent[channel];
    for (const [key, expires] of bucket) if (expires <= time) bucket.delete(key);
    const expires = bucket.get(uid);
    if (expires !== undefined || bucket.size >= 1000) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(((expires ?? time + 2000) - time) / 1000))));
      res.status(429).json({ ok: false, error: 'too_many_requests' });
      return false;
    }
    // Keep draining independent so a recent activation/report cannot delay the stop command.
    bucket.set(uid, time + (channel === 'running' ? 2000 : 1000));
    return true;
  };
  const handleError = (res: any, error: unknown) => {
    const code = error instanceof Error ? error.message : '';
    const status = code === 'auth_required' ? 401 : code === 'admin_required' ? 403
      : code === 'control_revision_conflict' ? 409 : code === 'control_invalid' ? 400 : 503;
    res.status(status).json({ ok: false, error: status === 503 ? 'population_service_unavailable' : code });
  };
  router.get('/', async (req, res) => {
    try {
      const actor = await authorizePopulationAdmin(req);
      if (!admit(actor, 'report', res)) return;
      res.json(await storage.adminReport());
    }
    catch (error) { handleError(res, error); }
  });
  router.post('/control', async (req, res) => {
    try {
      const actor = await authorizePopulationAdmin(req);
      const { mode, max_active: cap, revision } = req.body ?? {};
      if (!['running','draining'].includes(mode) || !Number.isInteger(cap) || cap < 1 || cap > 100
        || !Number.isSafeInteger(revision) || revision < 0) throw new Error('control_invalid');
      if (!admit(actor, mode, res)) return;
      const control = await storage.control(revision, mode, cap, actor);
      recent.report.delete(actor);
      void refresh().catch(() => {});
      res.json({ ok: true, control });
    } catch (error) { handleError(res, error); }
  });
  return router;
}
