# BYH Flow

One app for the whole client journey, from first enquiry to sign-off. It brings together the
BYH/Stillpoint journal and practice management and the ITC contact/agreement workflow.
Roles per instance: practice manager, therapist, client. Practice identity is configured per
instance (see `.env.example`).

**Status: phase 2a (identity and access).** Sign-in, roles and an audit log, with empty landing screens
per role. Clients, sessions, journal and the enquiry pipeline come in later phases.

## Access model

- **Practice manager:** enquiries, bookings, sources, schedules. Never clinical content.
- **Therapist:** the only role that sees clinical data. One person can hold both roles but acts in one at a time
  (they choose after signing in; the choice is audited).
- **Client:** their own record only.
- **Staff sign in** with a 6-digit emailed code (10 minutes, 5 attempts). **Clients** use an emailed link (15 minutes,
  single use, with a confirm button so mail scanners can't use it up), and an installed phone app can complete its own
  sign-in. Sessions: 30 minutes idle, 12 hours maximum. All secrets are stored hashed. Sign-ins and role choices are logged.
- Staff and clients are added with `scripts/create-staff.js` and `scripts/create-client.js` until the admin screens exist:
  `docker compose exec app node scripts/create-staff.js "Name" email --therapist --practice-manager`

## Stack

Node 22 / Express, Postgres 18, encrypted document storage on a Docker volume, nginx in front.
Everything runs as one isolated Docker Compose stack, configured only by environment variables,
so it can move to another VPS by redeploying and restoring data.

## Data areas

Postgres schemas, linked only by internal ID (`migrations/001_schemas.sql`, `002_identity.sql`):
`core` (staff, sessions, sign-in tokens, audit log),
`engagement` (enquiries, source tracking), `clinical` (clients, sessions, journal, consent),
`documents` (document metadata), `commerce` (reserved: bookings, vouchers, payments).

## Deploy on VPS2 (review before applying)

Target: `practice.betteryouhypnotherapy.co.uk`, app on `127.0.0.1:8100`.

1. **DNS (Fasthosts, BYH domain):** add an `A` record `practice` -> VPS2's IP. Use a low TTL.
2. **Code:** `git clone` this repo to `/opt/byh-flow` and check out the branch.
3. **Secrets:** `cp .env.example .env && chmod 600 .env`, then fill in `SESSION_SECRET` (`openssl rand -hex 32`),
   the Graph values and `GRAPH_SENDER`, and:
   - `POSTGRES_PASSWORD`: `openssl rand -hex 24` (hex only: it goes into a connection URL, so avoid base64)
   - `FILE_ENCRYPTION_KEY`: `openssl rand -base64 32`. **Store a copy away from this server and
     its backups.** Lose it and stored documents are unreadable.
4. **Start:** `docker compose up -d --build`, then `curl -s localhost:8100/healthz` -> `{"status":"ok"}`.
5. **nginx:** copy `deploy/nginx/*.conf` to `/etc/nginx/sites-available/`, symlink into
   `sites-enabled/`, `nginx -t && systemctl reload nginx`, then
   `certbot --nginx -d practice.betteryouhypnotherapy.co.uk`.
6. **Backups:** schedule `deploy/backup/pg_backup.sh` (see the script header). Add the Docker
   volume holding documents to the Acronis critical-folder list.
7. **Firewall:** only 22/80/443 should be reachable from outside. Postgres has no published port.

Only test data goes in until cutover is agreed. The instance is `noindex` and unlinked.

## Not in this phase

Roles and login, clients/sessions/journal (from BYH), enquiry pipeline and agreements (from ITC),
reminders, reporting, online booking and payments. See `docs/DECISIONS.md`.
