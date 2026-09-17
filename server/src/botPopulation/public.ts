import { Router } from 'express';
import { supabaseConfigured, verifyToken } from '../supabase';

export function populationPublicRouter(invite: (uid: string, character: string) => Promise<void>): Router {
  const router = Router();
  const recent = new Map<string, number>();
  router.post('/invite', async (req,res) => {
    try {
      const header = req.header('authorization') ?? '';
      if (!/^Bearer \S+$/i.test(header) || header.length > 8192) { res.status(401).json({ok:false}); return; }
      if (!supabaseConfigured()) { res.status(503).json({ok:false}); return; }
      const uid = await verifyToken(header.slice(7));
      if (!uid) { res.status(401).json({ok:false}); return; }
      const character = req.body?.character;
      if (typeof character !== 'string' || !/^b0700000-0000-4000-8000-\d{12}$/.test(character)) {
        res.status(400).json({ok:false}); return;
      }
      const now = Date.now();
      for (const [key,time] of recent) if (time <= now-3000) recent.delete(key);
      if (recent.has(uid) || recent.size >= 1000) { res.status(429).json({ok:false}); return; }
      recent.set(uid,now);
      await invite(uid,character);
      res.json({ok:true});
    } catch { res.status(409).json({ok:false,error:'population_invite_unavailable'}); }
  });
  return router;
}
