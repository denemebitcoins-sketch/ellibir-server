# Population Module

## 2026-09-17 Population Hotfix Candidate

Authorized deployment scope: human-table invitations, six rotating game quotas, demand/ceiling
diagnostics, admin request budgets and migrations07social/08lock-time. Keep automation OFF;
set the approved safety ceiling to60, not60 active participants. Existing5.7 clients already
send populationVersion=1 and can use the server invitation fix. Combined player-count labels,
community feed rendering and added admin capacity text require a subsequent client build.
Postrelease engine/AI changes remain outside this hotfix, including the pending51 opening-rule
work. Older UNRELEASED notes below describe development history; final deployment verification
is recorded in the active Unity project's docs/BOT_OVERHAUL_PROGRESS.md and CODEX_NOTLARI3.md.

Release candidate 5.7, 2026-09-17. Automation starts OFF. This is the first integrated
population iteration, not completion of the broader AI/mobile verification goal.

## Runtime And Controls

Production runs a coalesced 10-second director tick. Shutdown stops new work and requests
drain. GET /admin/bots and POST /admin/bots/control use the existing server-verified admin
role. Revision checks reject stale writes. Unity's existing admin panel has a Botlar tab,
active/passive control, cap, tables, characters, 24-hour economy and service diagnostics.
Persisted controls work without another build after installing this supporting client.

UNRELEASED admin protection: verified-UID per-worker cooldowns bound report refreshes (1s),
activation/limit writes (2s) and drain writes (1s). Draining has its own budget so activation
cannot delay shutdown. A successful control write permits its immediate report refresh,
matching the existing Unity callback. Rejected requests return 429 with Retry-After before
the report/control RPC; auth/role are still rechecked. Each channel expires entries and caps
its map at 1,000 verified actors; saturated reports cannot consume the drain channel.
This is not a distributed or pre-auth denial-of-service limiter. No live deploy yet.

OFF seeds once and performs recovery/progression maintenance, but starts no population.
Draining rejects new allocation/entry, preserves active matches, releases idle characters,
and changes to OFF only when global active matches, hosts and reservations are empty.
Health gates activation. Lease credentials never enter public DTOs.

100 stable UUID characters have plain names without B_, 50/50 gender metadata, 20 cosmetic
VIPs and initially varied 100,000..300,000 wallets. They are NOT auth.users/profiles rows.
Two original portrait assets are available; other characters use initials. Shared profiles
explicitly say Bot oyuncu. A character differs from AI temporarily taking over a human seat.

UNRELEASED user-trial followup: each of the six games has one showcase quota and one waiting
quota (three waiting in 51/classic, two in banko/101/Ihale, one in Tavla), plus three invite-ready
lobby characters. Baseline demand is 38, not a target to exhaust the configured max_active.
Explicit invitations use existing lobby characters and subsequent ticks replenish the reserve
within the persisted ceiling. Human-created invited rooms add demand and retire when finished.
At a low ceiling, lobby reserves precede showcases; a new showcase is not opened unless its
whole roster fits. Admin service health reports target_active, active_limit, capacity_limited.
Live read-only check around 13:00 Istanbul: OFF, max_active=25, revision=6, pool=100,
zero current reservations, 11 historical matches. No live control or deployment changed here.

Each quota keeps a stable SQL ownership key but selects an available table from 1..8.
Human rooms and other quota tables are skipped, not evicted. After a settled match, the old
roster retires, rests at least 180 seconds and the quota waits 20..60 seconds before reopening.
The provider excludes that quota's previous table number. Existing/uncertain authority is
recovered at its recorded table instead of allocating another quota; multi-owner exclusion
still uses the original SQL room key. Connected humans are preserved after retirement.
Deployed 5.7 / 05c7b51 still has two fixed showcases and requests 20 participants.
Bets 500..5000 in steps of 500. Bots-only idle seats rotate after 180..300 seconds,
then rest at least 180 seconds. Humans pin waiting occupants; running games are not interrupted.
Capacity reduction sheds idle seats first.

Invites require a verified seated human and a free seat. Only an available local lobby
character can transfer. Invites are rate limited per caller. Released 5.7 supports managed
tables only; UNRELEASED source also adopts a human-created waiting table on explicit invite.
Clients lacking populationVersion=1 cannot join managed rooms; ordinary human rooms remain
compatible and are not converted automatically.

Adoption resolves the inviter's local server room from verified identity, never a client room
or seat field. All currently connected clients, including spectators, must advertise protocol
support; join-time session capability survives reconnect. No active/starting match, admin test
bots, unverified human seats or bet outside 500..5000 by 500 is accepted. Existing bet, rules,
team mode, seat and transport identity remain unchanged. SQL authority is claimed/published
before binding; eligibility is rechecked after async requests. Failed publication releases only
its own lease and never disconnects the original room. Failed release retries on heartbeat.

Director serialization prevents tick/invite races. Adopted tables accept only explicit bot
invitations: configured autofill quotas cannot take them over. Waiting groups left without
humans retire at their 180..300s deadline, instead of creating another showcase. Drain removes
waiting bots and detaches the extension while preserving connected humans/spectators. Active
matches keep the same immutable population escrow; no jackpot/quest eligibility is introduced.
The existing Unity /bots/invite call and populationVersion=1 handshake already support this
server change. Discovery/character transfer is local-worker only; cross-worker invitation
routing and physical mobile-network UX are not proven by the local tests.
Join support retains disconnected sessions while their human seat is reserved, even if a
different client joins before reconnect. Forgotten/departed sessions and old spectators
cannot accidentally qualify a table. This is session compatibility, not client authorization.
Final verification: bot-postrelease-adoption-reconnect-tests.json, 949 total, 946 passed,
zero failed, three optional skips; typecheck passed. Includes 20 real SDK/WebSocket cases,
three capability/identity regressions and six runtime tests. Test workers exited. This does
not supersede the explicit unreleased/local-only boundary above.

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

Public presence expires with authority and exposes only public data. UNRELEASED Unity now
shows combined main-menu/community participant counts. Bot identity stays in shared profiles,
admin analytics and labelled generated chat; neither auth identity nor ledger changes.
Unity resolves two allowlisted local portraits and filters bot IDs out of human UUID
profile queries. Admin controls use the existing theme and three aspect-ratio capture tests.
Table greetings are fixed, bounded, require a human and obey mute. Profile mute is local to
the device/account, not cloud-synchronized blocking. Released 5.7 has no community bot feed.

UNRELEASED migration 07 adds a separate private bot community feed; it does not insert into
human profiles, presence or lobby_chat and does not change human message/role policies.
Apply only in a future authorized migration sequence, after 01..06 and the existing
20260819_admin_clear_lobby_chat migration. It is NOT applied live.

The director's optional service RPC observes the existing authoritative public presence,
publishes at most one arrival/departure per 30 seconds and never emits a departure for a
character whose arrival was not announced. Expired room/character authority is excluded.
Only an online, announced, cosmetic-VIP lobby character can use a fixed greeting; a fresh
human presence is required, mode must be running, and the global budget is eight minutes.
The SQL singleton lock serializes publishers. Storage keeps at most 200/one-day events;
authenticated readers receive the last 12 events within 20 minutes, without lease secrets.
Negative bot event IDs cannot collide with positive human chat IDs. Social RPC deadline is
three seconds; failure is redacted in runtime health and cannot fail match maintenance.

The existing authorized chat-clear audit triggers bot-feed deletion and delays greetings.
Unity merges both feeds, validates bot identity, shows (Bot), opens the same MiniProfileDialog
and applies device/account mute to bot lines. Empty feeds now remove stale rendered rows.
Old clients simply do not fetch the new feed. New clients retain human chat if this RPC is
missing/unavailable. Polling is used for this private feed, not a new Realtime subscription.

## Verification And Limits

From server: npm run typecheck; npm run test:engine -- --maxWorkers=2.
Actual migrations run in pinned dev-only PGlite 0.5.8 with UUID profiles. Tests cover escrow,
refund/retry, role denial, refill, fencing, recovery, quotas, all six real room classes and
complete engine matches. Local HTTP/WebSocket SDK tests cover six games: old-client rejection
before seating, invite, entry, disconnect/reconnect and drain. External auth is isolated in
these tests; this is not live Android authentication.

PGlite serializes SQL: its results alone are NOT native multi-connection lock/deadlock proof.
The separate native PostgreSQL checks below cover specific races, not arbitrary worker failures.
No physical Android performance certification or live multi-human wallet game is claimed. Keep automation
OFF until supervised mobile trial. Dedicated client fence-pause presentation needs focused QA.

Broader goal work: 51 staged opening/undo parity and uncertainty, further Ihale planning,
mobile worst-case AI budgets, cross-worker invitation routing, more portraits,
cloud mute/block, distributed admin abuse protection and legacy all-human economy race audit.

A full run during simultaneous Android compilation had one Okey simulation timeout (877 pass,
1 fail, 3 optional skips). Isolated rerun: all 68 pass, simulation 1.32 seconds. Reduced-worker
complete rerun passed: 881 total, 878 passed, zero failures, three optional skips;
bot-release-verified-20260917-tests.json. Skips are not evidence.

Latest local post-release run: bot-postrelease-rotation-memory-final-tests.json, 915 total,
912 passed, zero failed, three optional skips; typecheck passed. Three new room tests cover
three-bot waiting, idle rotation, first-human start/pinning and drain through settlement.
These tests and the newer 51/Ihale policy changes are NOT part of released 5.7 binaries.

Admin limiter: 13 HTTP tests pass, including six new cooldown/concurrency/stop/identity/
failure/capacity scenarios. Verified 1,000 report actors cannot block the next actor's drain.
Final local suite after these changes: bot-postrelease-admin-limit-final-tests.json,
921 total, 918 passed, zero failures, three optional skips; typecheck/diff check passed.
No additional Unity runtime edits, build, SQL, commit/push, deploy or live switch change.

Later local community checkpoint: eight executable SQL tests cover actual presence, sparse
arrivals/departures, repeated calls, expiry, VIP/human/off gating, private grants, retention
and the existing admin clear RPC. Runtime tests cover optional failure redaction/deadline.
bot-postrelease-community-tests.json: 931 total, 928 passed, zero failed, three optional skips.
Unity PopulationCommunityAudit: 12 captures (four states, three ratios), real shared-profile
click, merge/dedup, human retention and mute/empty-feed cleanup passed; fixture data only.
Physical Android/live feed latency remains unverified; native concurrency was checked separately below.
Final social/runtime rerun after explicit offline-human exclusion: 13 passed, zero failed,
bot-community-social-final-tests.json. A fresh timestamp alone does not count an offline user.
Unity's existing HardeningAudit and Bot51MemoryAudit also passed after the client changes.

### Native PostgreSQL Authority Regression (Unreleased)

scripts/bot-native-concurrency.ts runs unchanged migrations 01..06 plus local 07/08 in a new,
isolated PostgreSQL 16.15 cluster. Set BOT_POPULATION_NATIVE_BIN to the directory containing
postgres/initdb/pg_ctl/psql, then run npx ts-node --transpile-only scripts/bot-native-concurrency.ts
from server. It accepts no existing database URL. Random loopback port, fresh data directory,
throwaway SCRAM password, explicit data-directory verification and finally-stop keep the test
separate from existing databases/services. Temporary test data remains outside the app build.

Independent psql sessions are held behind a real SQL row lock. An observer verifies distinct
backend PIDs, Lock waits and pg_blocking_pids before releasing the barrier. Ten checks cover
room ownership, global cap, duplicate entry/payout, payout-versus-refund, daily refill, social
publication, room/character expiry while queued, and orphan recovery racing settlement.

Before the fix, bot-native-concurrency-before-fence-fix.json records seven passes and a real
failure: a queued room renewal used a pre-lock timestamp and revived expired authority.
UNAPPLIED migration 08 evaluates expiry after acquiring locks and assigns new TTLs at mutation
time. It also evaluates the Istanbul refill day after wallet/control locks; actual midnight
crossing was code-audited, not reproduced by changing the machine clock. Existing grants,
accounting and applied migrations are preserved. This migration does not activate automation.

bot-native-concurrency-results.json records the native result and cluster-stop status. This is
local PostgreSQL with auth/XP fixtures, not Supabase infrastructure or physical Android proof.
No live SQL, commit, deploy, new AAB or additional Play submission accompanies this correction.
Final native result: ten passed, zero failed, owned cluster stopped. Expiry tests assert the
specific lease_lost/room_lease_lost rejection, not just any error. Final full suite with 08:
bot-postrelease-lock-time-final-tests.json, 931 total, 928 passed, zero failed, three optional
skips. Typecheck passed. No postgres process was left running; existing unrelated service
postgresql-minierp stayed stopped. No clock/date override was used.

References: https://pglite.dev/docs/api and https://pglite.dev/docs/filesystems.
