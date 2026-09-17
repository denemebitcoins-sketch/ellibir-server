# Population Module

Release candidate 5.7, 2026-09-17. Automation starts OFF. This is the first integrated
population iteration, not completion of the broader AI/mobile verification goal.

## Runtime And Controls

Production runs a coalesced 10-second director tick. Shutdown stops new work and requests
drain. GET /admin/bots and POST /admin/bots/control use the existing server-verified admin
role. Revision checks reject stale writes. Unity's existing admin panel has a Botlar tab,
active/passive control, cap, tables, characters, 24-hour economy and service diagnostics.
Persisted controls work without another build after installing this supporting client.

OFF seeds once and performs recovery/progression maintenance, but starts no population.
Draining rejects new allocation/entry, preserves active matches, releases idle characters,
and changes to OFF only when global active matches, hosts and reservations are empty.
Health gates activation. Lease credentials never enter public DTOs.

100 stable UUID characters have plain names without B_, 50/50 gender metadata, 20 cosmetic
VIPs and initially varied 100,000..300,000 wallets. They are NOT auth.users/profiles rows.
Two original portrait assets are available; other characters use initials. Shared profiles
explicitly say Bot oyuncu. A character differs from AI temporarily taking over a human seat.

Default cap 24; six waiting-table plans, two showcases and three lobby slots request 20 active
characters. Bets 500..5000 in steps of 500. Bots-only idle seats rotate after 180..300 seconds,
then rest at least 180 seconds. Humans pin waiting occupants; running games are not interrupted.
Capacity reduction sheds idle seats first.

Invites require a verified seated human and a free seat on a MANAGED waiting table. Only an
available local lobby character can transfer. Invites are rate limited per caller. Arbitrary
human-created tables are not adopted. Clients lacking populationVersion=1 cannot join managed
rooms; ordinary human rooms remain compatible.

## Economy And Authority

Apply migrations 20260917_01 through _06 in order. Applied to the intended live Supabase
project on 2026-09-17 with automation OFF. Read-only catalog verification matched all 24
normalized function bodies, SECURITY DEFINER flags and execute grants; all 12 private tables
have RLS. Only public_presence is executable by authenticated clients; private RPCs require
service role internally and by grant. This is catalog evidence, not live load testing.

45-second owner/token leases fence logical tables and character seats. A stale worker cannot
renew/play through a failed fence. Expired active matches remain fenced until atomic refund
or settlement. New-worker recovery waits for ALL related leases to expire, refunds immutable
escrow and closes only the captured old room. It does not reconstruct an interrupted game.
Missing refund data blocks recovery atomically for investigation.

Entry validates an immutable full roster and charges humans AND bot wallets atomically.
Never mix legacy deductEntry/settleMatch with this ledger. Changed idempotency payloads fail.
Winner/team receives 90% of escrow, 10% is recorded as house amount, null winner refunds all.
Lost replies reconcile against receipts. Human departure does not change payout identity.
Completed net movements sum to zero across human, bot and house; refills are separate.

Idle wallets below 100,000 refill once per Europe/Istanbul day to 100,000..300,000. Waiting
or playing seats cannot refill; richer wallets remain unchanged; seed never resets money.

Migration 06 adds a durable human stats/XP outbox. Stats, XP and processed receipt commit
in one per-row subtransaction; failure rolls back and retries without repeating settlement.
Refunds enqueue nothing. Population matches never call jackpots or quests. Initial all-human
matches retain their separate eligibility even after disconnect takeover.

## Presentation And Social

Public presence expires with authority, separates human/bot counts and exposes only public
data. Unity resolves two allowlisted local portraits and filters bot IDs out of human UUID
profile queries. Admin controls use the existing theme and three aspect-ratio capture tests.
Table greetings are fixed, bounded, require a human and obey mute. Profile mute is local to
the device/account, not cloud-synchronized blocking. Community join/leave feeds and periodic
VIP lobby messages are NOT implemented yet.

## Verification And Limits

From server: npm run typecheck; npm run test:engine -- --maxWorkers=2.
Actual migrations run in pinned dev-only PGlite 0.5.8 with UUID profiles. Tests cover escrow,
refund/retry, role denial, refill, fencing, recovery, quotas, all six real room classes and
complete engine matches. Local HTTP/WebSocket SDK tests cover six games: old-client rejection
before seating, invite, entry, disconnect/reconnect and drain. External auth is isolated in
these tests; this is not live Android authentication.

PGlite serializes SQL: NOT native PostgreSQL multi-connection lock/deadlock proof. No physical
Android performance certification or live multi-human wallet game is claimed. Keep automation
OFF until supervised mobile trial. Dedicated client fence-pause presentation needs focused QA.

Broader goal work: 51 staged opening/undo parity and uncertainty, further Ihale planning,
mobile worst-case AI budgets, human-created table adoption, community events, more portraits,
cloud mute/block, admin rate limiting and legacy all-human economy race audit.

A full run during simultaneous Android compilation had one Okey simulation timeout (877 pass,
1 fail, 3 optional skips). Isolated rerun: all 68 pass, simulation 1.32 seconds. Reduced-worker
complete rerun passed: 881 total, 878 passed, zero failures, three optional skips;
bot-release-verified-20260917-tests.json. Skips are not evidence.

References: https://pglite.dev/docs/api and https://pglite.dev/docs/filesystems.
