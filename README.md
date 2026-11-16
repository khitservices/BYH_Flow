# BYH Flow

One app for the whole client journey, from first enquiry to sign-off. It brings together the
BYH/Stillpoint journal and practice management and the ITC contact/agreement workflow.
Roles per instance: practice manager, therapist, client. Practice identity is configured per
instance (see `.env.example`).

**Status: phase 2a (identity and access).** Sign-in, roles and an audit log, with empty landing screens
per role. Clients, sessions, journal and the enquiry pipeline come in later phases.

## Access model

- **Practice manager account:** practice details, email settings and the team. Never client records.
- **Therapist account:** the only kind that sees clinical data. A person can have both kinds under one email
  address, but they are separate accounts: after the emailed code they choose one, and sign out to use the other.
- **Client:** their own record only.
- **Staff sign in** with a 6-digit emailed code (10 minutes, 5 attempts). **Clients** use an emailed link (15 minutes,
  single use, with a confirm button so mail scanners can't use it up), and an installed phone app can complete its own
  sign-in. Sessions: 30 minutes idle, 12 hours maximum. All secrets are stored hashed. Sign-ins and role choices are logged.
- **The first practice manager** is added on the server:
  `docker compose exec app node scripts/create-staff.js "Name" email --practice-manager` (add `--therapist` to
  create their separate therapist account too). Everyone after that is added on the Team page, which emails them
  an invitation. Clients are added with `scripts/create-client.js` until the client screens exist.
- **Practice name and colour** are set in the app (Settings > Practice details).
- **Email** is set up in the app, not in `.env`: a practice manager opens Settings > Email and enters the practice
  mailbox's outgoing (SMTP) server, port, username and password, sends a test, then saves. Everything the app sends
  goes out from that mailbox. The password is stored sealed with `SECRETS_KEY` and is never shown again.
- **First sign-in, and the way back in if email stops working:**
  `docker compose exec app node scripts/signin-code.js email` prints a one-time code (30 minutes) on the server.

## Stack

Node 22 / Express, Postgres 18, encrypted document storage on a Docker volume, nginx in front.
Everything runs as one isolated Docker Compose stack, with secrets in one generated `.env` file and everything else set in the app,
so it can move to another VPS by redeploying and restoring data.

## Data areas

Postgres schemas, linked only by internal ID (`migrations/001_schemas.sql`, `002_identity.sql`, `003_mail_settings.sql`, `004_practice_settings.sql`, `005_separate_accounts.sql`):
`core` (staff, sessions, sign-in tokens, audit log, email and practice settings),
`engagement` (enquiries, source tracking), `clinical` (clients, sessions, journal, consent),
`documents` (document metadata), `commerce` (reserved: bookings, vouchers, payments).

## Deploy on VPS2 (review before applying)

Target: `practice.betteryouhypnotherapy.co.uk`, app on `127.0.0.1:8100`.

1. **DNS (Fasthosts, BYH domain):** add an `A` record `practice` -> VPS2's IP. Use a low TTL.
2. **Code:** `git clone` this repo to `/opt/byh-flow` and check out the branch.
3. **Secrets:** `./scripts/init-env.sh https://practice.betteryouhypnotherapy.co.uk`. It creates `.env` (or fills in
   whatever an existing one is missing), generates every secret, changes nothing already set and prints no secret.
   **Copy the `FILE_ENCRYPTION_KEY` line somewhere away from this server and its backups.** Lose it and stored
   documents are unreadable. Nothing else goes in `.env`: the practice name, colour and mailbox are set in the app.
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
