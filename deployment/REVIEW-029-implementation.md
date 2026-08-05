# REVIEW-029: SPEC-029 implementation reviews

> Convention per `docs/specs/README.md`: this file is amended with a new dated
> section per review pass, never replaced. Reviewer for SPEC-029 is Claude CLI
> (role flip vs SPEC-028 — Codex implements, Claude reviews).

## First-Pass Review (PR 1 — Documenso deployment prep) — 2026-07-02

**Reviewer**: Claude CLI first-pass review
**Base reviewed**: `0988a9e` (spec + detailed design commit)
**Tip reviewed**: `908e3f3` (`docs(spec-029): translate documenso deployment runbook`) — local only, see S7
**Diff command**: `git diff 0988a9e..908e3f3`
**Spec**: `docs/specs/SPEC-029-documenso-integration.md`
**Method**: 3-way parallel verification (cert script empirical test · runbook claims vs Documenso 2.14 source at `/opt/apps/Perri/documenso/documenso` · ERP doc-chain consistency) + adversarial re-check of every non-note finding + live-host checks (DNS, nginx vhosts, docker ps).

### Final Verdict

**REQUEST_CHANGES.**

The runbook structure, the cert helper script, and the doc chain (DEC-055 /
CURRENT-STATE / README / PRD rows) are solid — the cert script in particular
was verified empirically (its exact OpenSSL sequence produces a p12 that
Documenso 2.14's actual loader `@libpdf/core` parses AND signs with; container
uid 1001 read permissions line up). But three of the runbook's operator-facing
values are wrong in ways that guarantee first-run failure, and one domain used
in ERP-facing URLs does not exist in DNS.

Two of the must-fix items originate in the spec itself, not in Codex's
execution — the spec locked a PascalCase team slug without checking Documenso's
validator, and seeded the `app.fantasycaravan.com.au` domain from a stale
`.env.example` value. The spec will be amended alongside the fixes; Codex
should treat the corrected values in this review as authoritative.

### Must Fix

#### H1. Team slug `FantasyCaravan` is impossible — Documenso forces lowercase slugs

Documenso's team URL validator (`packages/trpc/server/team-router/schema.ts:22-33`,
`ZTeamUrlSchema`) applies `.toLowerCase()` as a zod transform and then enforces
`/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/`. Typing `FantasyCaravan` in the UI silently
creates slug `fantasycaravan`. Any ERP path built from
`DOCUMENSO_TEAM_URL="FantasyCaravan"` will never match the real team.

Fix in every location:
- `docs/deployment/documenso-selfhost.md:18, 198, 212, 270`
- `.env.example:63`
- `docs/specs/SPEC-029-documenso-integration.md:41, 83, 112, 124, 146`

All should read `fantasycaravan`. (Spec-origin error — the /grill-me locked
the owner's PascalCase pick without checking the validator. Owner display name
"Fantasy Caravan" is unaffected; only the URL slug is constrained.)

#### H2. API smoke-test URL is 404 — `/api/v2/envelopes` does not exist

Runbook line 244 curls `GET /api/v2/envelopes?perPage=1` and line 247 expects
HTTP 200. The find-envelopes endpoint is declared `GET /envelope` (singular) in
`packages/trpc/server/envelope-router/find-envelopes.types.ts:10-11`, mounted
under `/api/v2` in `apps/remix/server/router.ts:126-139`. All 20 envelope
OpenAPI paths are singular; the plural form 404s and the token verification
step always fails, misleading the operator into suspecting the token.

Correct command: `GET /api/v2/envelope?perPage=1`. Side-claims verified OK:
`perPage` is a valid coerced param (1..100) and `Authorization: Bearer` is
accepted (`packages/trpc/server/trpc.ts:85-92` supports both `Bearer api_xxx`
and bare `api_xxx`). Also fix the same example in the spec's PR 1 verification
section.

#### H3. Domain `app.fantasycaravan.com.au` does not exist — real ERP prod domain is `query.fantasycaravan.com.au`

`dig app.fantasycaravan.com.au` returns nothing. The production ERP is served
at `query.fantasycaravan.com.au` (Cloudflare-proxied; nginx vhost
`/etc/nginx/sites-enabled/fantasy-search` with `server_name
query.fantasycaravan.com.au`, TLS cert at
`/etc/letsencrypt/live/query.fantasycaravan.com.au/`, ERP proxied at
`/vehicle-query` → `127.0.0.1:3000`).

Affected values:
- Runbook line 203 (webhook URL): `https://app.fantasycaravan.com.au/vehicle-query/api/documenso/webhook`
- Runbook line 215 (`DOCUMENSO_ENVELOPE_REDIRECT_URL`): `https://app.fantasycaravan.com.au/vehicle-query`
- `.env.example:66` (redirect URL example comment)
- Spec line 127 (redirect URL example)

Root cause: `.env.example:27` has carried `NEXT_PUBLIC_SITE_URL=https://app.fantasycaravan.com.au`
as a stale aspirational example since before SPEC-029; the spec + runbook
propagated it. Unless the owner explicitly commissions an `app.` subdomain
(new DNS + cert + nginx vhost — out of PR 1 scope), all four locations should
use `query.fantasycaravan.com.au`.

Interaction with S2 (webhook SSRF guard): the corrected domain resolves to
Cloudflare public IPs, which passes Documenso's private-IP webhook guard —
delivery hairpins through the Cloudflare edge back to this host. Do NOT
work around the dead domain with `/etc/hosts` or `extra_hosts` pointing at
127.0.0.1: the SSRF guard would then reject every webhook delivery (see S2).

#### H4. Runbook compose snippet binds 0.0.0.0 — must be loopback

Runbook section 2 (lines 66-67) instructs `ports: - "3010:3000"`, which Docker
publishes on `0.0.0.0` (and bypasses ufw via iptables). This contradicts (a)
the runbook's own topology table (line 12: 宿主机监听 `127.0.0.1:3010`), (b)
the section-4 nginx `proxy_pass http://127.0.0.1:3010`, and (c) the live
deployment (`docker ps`: `127.0.0.1:3010->3000/tcp`). An operator copy-pasting
the snippet exposes plain-HTTP Documenso on the public interface, bypassing the
nginx TLS boundary.

Fix the snippet to `- "127.0.0.1:3010:3000"`. Also align the spec's PR 1
section (lines ~108/138 use the non-loopback form). Same-section drift: the
snippet says to add `PORT=3000` under environment, but compose already has
`PORT=${PORT:-3000}` — the env edit is redundant; drop it from the snippet.

### Should Fix

#### S1. `NEXT_PRIVATE_SMTP_TRANSPORT=smtp` is a non-canonical value

Runbook line 97 sets `smtp`. Valid values in `packages/email/mailer.ts` are
`smtp-auth` (default), `smtp-api`, `resend`, `mailchannels`. The unknown value
`smtp` happens to fall through to the final `smtp-auth`-shaped branch, so it
works today by accident — but a future Documenso version that validates the
enum would hard-fail. Use the canonical `smtp-auth`.

#### S2. Webhook SSRF guard constraint is undocumented — and the bypass env var isn't plumbed through compose

Every webhook delivery runs `assertNotPrivateUrl`
(`packages/lib/server-only/webhooks/execute-webhook-call.ts:31` →
`assert-webhook-url.ts:86-137`): the hostname is DNS-resolved via the OS
resolver and delivery throws if any resolved address is private/loopback. The
failure is silent (recorded as `success:false` in `WebhookCall`). Since
Documenso and the ERP share one host, the tempting workarounds for H3
(`/etc/hosts`, `extra_hosts`, split-horizon DNS → 127.0.0.1) would break ALL
webhook deliveries. The escape hatch `NEXT_PRIVATE_WEBHOOK_SSRF_BYPASS_HOSTS`
(`assert-webhook-url.ts:36-52`) is NOT in the compose `environment` list, so
setting it in `.env.production` alone does nothing.

Document the constraint next to the webhook step (runbook §5 step 6): the
webhook URL must resolve to a public IP (Cloudflare-proxied
`query.fantasycaravan.com.au` qualifies); if a loopback shortcut is ever
needed, both the env var AND a compose `environment` entry are required.

#### S3. Floating `documenso/documenso:latest` image tag

`compose.yml:19` uses `:latest` and the runbook's `docker compose pull` can
silently jump major versions (surprise Prisma migrations on `up -d`; drift
from the source checkout this runbook was verified against — v2.14.0-10-g562d78e2d).
Pin an explicit tag (e.g. `documenso/documenso:2.14.0`) or digest in the
compose, state the pinned version in the runbook, and add a one-paragraph
upgrade procedure. Note: the cert-script cipher compatibility conclusion (see
Notes) also depends on the image being v2.x (`@libpdf/core` loader) — a
node-forge-era image would reject the OpenSSL 3.x default-cipher p12.

#### S4. Compose port remap is an uncommitted local modification in the Documenso checkout

`git status` in `/opt/apps/Perri/documenso/documenso` shows
`M docker/production/compose.yml`; upstream HEAD still has
`${PORT:-3000}:${PORT:-3000}` (0.0.0.0:3000). A fresh clone or `git checkout .`
silently reverts to the unsafe binding. The runbook must state this edit is
required on every fresh checkout (or maintain the edit as a committed overlay/
fork).

#### S5. Health-check section exports every ERP secret into the shell

Runbook lines 238-240: `set -a; . /opt/apps/Perri/Fantasy_web_main/.env; set +a`
just to read `$DOCUMENSO_API_TOKEN` — this exports DATABASE_URL, the Supabase
service-role key, admin session secret, etc. into the interactive shell and all
child processes. Replace with a single-var extraction:
`DOCUMENSO_API_TOKEN=$(grep -m1 '^DOCUMENSO_API_TOKEN=' .env | cut -d= -f2- | tr -d '"')`.

#### S6. `DOCUMENSO_ENVELOPE_REDIRECT_URL` example drifts across three documents

Three different values for the same var (beyond the H3 domain error):
- Spec line 127: `.../orders/complete-signing` (missing the `/vehicle-query` basePath)
- `.env.example:66`: `.../vehicle-query/orders/complete-signing` (basePath-prefixed — the correct shape)
- Runbook line 215: bare `.../vehicle-query` (no completion path — dumps signers on the ERP public landing page)

Canonical value once H3 is fixed:
`https://query.fantasycaravan.com.au/vehicle-query/orders/complete-signing`.
The completion page itself arrives in PR 2; the runbook should note the value
becomes functional at PR 2 rollout (until then Documenso would redirect to a
404 — acceptable pre-PR-2 since no envelopes are being created yet, but say so
explicitly).

#### S7. Neither PR 1 commit is pushed to origin

`git ls-remote origin spec-029-documenso-integration` returns `0988a9e`
(spec-only). Both `9ef1d69` and `908e3f3` exist only locally. Push before the
next review pass — remote-side review or merge currently sees none of PR 1.

### Notes (verified OK / minor)

- **Cert script is sound — empirically tested.** The exact OpenSSL sequence in
  `scripts/generate-documenso-cert.sh` was executed on this host (OpenSSL 3.5.5),
  and the resulting modern-cipher p12 was loaded AND used to produce a 256-byte
  RSA signature via `@libpdf/core@0.4.0` — the same loader Documenso 2.14 uses
  (`packages/signing/transports/local.ts:28`). `-legacy` is correctly omitted.
  Passphrase via `env:` avoids ps exposure; `sudo --preserve-env` delivers the
  var on this host's sudoers; `install -m 0400` + `chown 1001:1001` matches the
  container user (`Dockerfile:103` `adduser --system --uid 1001`); idempotency
  guard + `--force` + `set -euo pipefail` + `mktemp`/trap + `umask 077` all
  present.
- Minor cert-script polish (optional): `umask 077` leaves a fresh
  `/opt/documenso` dir 0700 root:root (container unaffected; host tooling can't
  list it); `--force` rotation while the container runs keeps the old inode
  bind-mounted until `up -d --force-recreate`; arg parser ignores trailing args;
  a post-generation `openssl pkcs12 -info -noout` self-check would prove
  round-trip.
- Health endpoints verified: `GET /api/health` + `GET /api/certificate-status`
  both exist (`apps/remix/app/routes/api+/health.ts`, `certificate-status.ts`).
  Nuance: `/api/health` returns 200 even when the signing cert is missing
  (downgrades to `warning`) — assert on the JSON body or on
  `certificate-status.isAvailable`, not just HTTP 200.
- `docker compose --env-file` interpolation verified; the runbook's
  `.env.production` template covers all 11 `:?err`-required compose vars.
- Signup flags verified: `NEXT_PUBLIC_DISABLE_SIGNUP=true` blocks server-side
  (`packages/auth/server/routes/email-password.ts:194-199`) and is read at
  container runtime — the flip-and-restart procedure works without rebuild.
- Webhook secret header verified: `X-Documenso-Secret`
  (`execute-webhook-call.ts:40`). The secret is nullable and sent as empty
  string when unset — the PR 2 ERP receiver must do a non-empty exact match,
  not just header presence.
- Wording nit: runbook line 196 says "创建第一个 admin account" — Documenso's
  first signup creates a regular USER (`User.roles` defaults `[USER]`; nothing
  auto-promotes). All runbook steps only need the org-owner account, so not
  blocking; reword to "第一个账号（organisation owner）" or document the manual
  role promotion.
- `.env.example` block matches the spec template except one dropped comment on
  `DOCUMENSO_TEAM_URL` (trivial).
- DEC-055 + CURRENT-STATE + README + PRD rows are internally consistent
  ("PR 1 implemented, PR 2/3 pending"); identity posture correctly states
  anonymous recipients. All spec PR 1 deliverables are present.
- One candidate finding was refuted in verification: the implementation-summary
  header does not violate any repo convention (SPEC-028's elaborate header is a
  10-review-round artifact, not a standard; SPEC-029's header is richer than
  most predecessors).

### Verification

- Workflow: 3 parallel finders (cert-script empirical audit / runbook-vs-Documenso-source / ERP doc chain) + adversarial verify per finding; 14 agents total. 9 findings confirmed, 1 refuted.
- Live-host checks: `dig` (app. does not resolve; query. resolves via Cloudflare; sign. not yet created — expected), `/etc/nginx/sites-enabled/fantasy-search` (server_name + proxy topology), `docker ps` (documenso already running at `127.0.0.1:3010->3000`; prod ERP at `:3000`; test ERP at `:3001`).
- Documenso source checks pinned to the actual checkout `/opt/apps/Perri/documenso/documenso` at v2.14.0-10-g562d78e2d.
