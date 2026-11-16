# Decisions and backlog

## Decisions (2026-11-13)

- **New app, new repo.** Seeded from the BYH repo (auth, journal, sessions, Graph mail, reminders,
  brand config) with the ITC pipeline and document logic ported in. Neither existing app changes.
- **Live BYH on Render is left alone** until a cutover is agreed. This instance runs silently with
  test data until then. Whether ITC continues is undecided.
- **Hosting:** VPS2 for now, under a BYH-domain subdomain (`practice.`), fully isolated from the
  KHIT apps (own containers, network, Postgres, volumes, secrets, backups). Moves to a dedicated
  VPS later. Hosting client data on KHIT infrastructure needs processor/hosting paperwork before
  real data goes in.
- **ITC baseline:** v34.7 logic (enquiry statuses, follow-up timings, the three Word templates and
  fill logic). The v34.7 zip is the file-based desktop build; phone enquiry form, emailed login
  code and in-house signing are built new to the spec.
- **Documents:** encrypted at rest (AES-256-GCM), key held outside the database and volume, served
  only through an auth-checked route. OneDrive filing is an optional export, not the primary store.
  Local volume now behind a small interface so S3-compatible storage can replace it.
- **Separation:** engagement / clinical / documents / commerce schemas, linked by internal ID only.
- **Roles:** practice manager, therapist, client. (BYH's current `admin` is a platform operator who
  never sees client data; practice manager is new.)

- **Access (2026-11-13):** practice managers never see clinical data; only therapists do. (How one person holds
  both is in "Accounts and onboarding" below.) Staff sign in with an emailed passcode; clients with an emailed link.
  (The earlier plan to send login emails from `notifications@khitservices.co.uk` is superseded by the mail
  decisions below.)
- **Phase 2 split:** 2a identity, access and in-app mail settings; 2b clinical core (clients, programmes/sessions,
  calendar, journal, files); 2c reminders (weekly journal, appointment reminders, daily digest).

## Mail (2026-11-14)

- **One channel for everything.** Staff login codes, client links, appointment reminders, journal nudges, enquiry
  follow-ups, and consent and agreement requests all send through the practice's own configured mailbox. No
  KHIT notifications address and no mail secrets in `.env`.
- **Configured in the app at setup, not in `.env`.** Modelled on SMART's settings page (DB-backed, password
  sealed with a key held in the server environment, read fresh on every send, send-test-email button that
  tests unsaved values). The secrets key is separate from the document key.
- **Plain SMTP only.** One settings form: server, port, username, password, send-from address and name. No
  Microsoft Graph and no provider-specific code (decided 2026-11-14; an earlier note here proposed a Graph
  provider and is withdrawn). The connection must be encrypted (TLS from the start, or STARTTLS) or the app
  will not send. A practice whose mailbox provider does not allow password SMTP uses a mailbox or sending
  service that does.
- **Sole therapist:** one mailbox, everything sends from it.
- **Group practice:** the practice manager configures the provider and the practice email domain once. A therapist
  who signs in with an address on that domain gets it as their default sender; client emails send from the
  client's assigned therapist. Sender addresses are restricted to the configured domain. A therapist off the
  domain (or whose mailbox has gone) falls back to a practice default address. Per-therapist sending depends on
  the SMTP host allowing one login to send as other addresses on the domain; where it does not, the practice
  sends from one shared address. Not built yet: 2a has the single mailbox only.
- **Content rule.** No clinical detail in any email: a link and minimum wording only. Consent and agreement
  requests are links to the signing page, never attachments; no open-tracking pixels.
- **Every send is recorded** in an outbox (type, recipient, sending mailbox, form and version, status, retries,
  last error), never the link token. Practice managers see a not-delivered list. Login emails send
  immediately; other mail is queued with retries. Consent links last days and are single-use with a signing
  step that confirms identity. Under-16 consent goes to a parent or guardian with no account.
- **Calendar file on appointment emails:** included (provider-neutral).
- **First run and recovery.** `scripts/signin-code.js` prints a one-time sign-in code on the server (30 minutes,
  single use, audited). The owner signs in with it, then sets up and tests the mailbox in Settings. The same
  command is the way back in if a settings change stops codes arriving. An emailed code only replaces an
  earlier code once it has actually been sent.
- **Test case.** `katrina@betteryouhypnotherapy.co.uk`, a standard IMAP/SMTP mailbox (moved off Microsoft 365
  on 2026-11-16), is the sole-therapist test mailbox. Its password is entered in Settings, never in chat or `.env`.
- **Built in 2a:** settings page, sealed password (`SECRETS_KEY`), test email, printed sign-in code. **Still to
  build:** outbox with retries and the not-delivered list, group-practice senders, consent send records.

## Setup (2026-11-16)

- **`.env` holds secrets and the address only**, and nobody edits it by hand: `scripts/init-env.sh` creates it and
  generates the database password, session secret, secrets key and document key. The keys stay out of the database
  on purpose (a database copy alone must not be enough to read documents or the mailbox password).
- **Practice name and colour are set in the app** (Settings > Practice details), with the mailbox (Settings > Email).
- New practice: run the script, start the stack, add the owner, print a sign-in code, then set details and email in Settings.

## Accounts and onboarding (2026-11-16)

- **A practice manager account and a therapist account are separate accounts.** One person may have both under
  the same email address: one emailed code, then they choose which account to enter, and sign out to use the
  other. No switching inside a session. (Replaces the earlier "one account, choose a role" model.)
- **Onboarding order.** First use is the practice manager account: set name and colour, set up email, add the
  team. Each person added gets an invitation email (no password; they sign in with an emailed code) and arrives
  in a clean therapist area. A therapist creates their clients, and each client then gets a sign-in to the client
  area (2b). Every enquiry and booking belongs to a specific therapist (phase 3).
- **The practice manager's part is small:** practice details, email, and adding, changing, suspending and removing
  accounts on the Team page. No client records, ever; where a therapist has clients the manager sees only a count.
- **Guards.** A manager cannot suspend or remove the account they are signed in with, so a practice always has a
  working manager. Suspending or removing someone signs them out at once. Removing a therapist who has clients
  requires choosing the therapist who takes them over; the move is audited and shows no client details.
- **Manager sees practice statistics, never patient detail** (confirmed 2026-11-16): counts by channel, stage and
  therapist. No names, contact details or anything a person wrote. The mock-up's manager screen (enquiry list,
  follow-ups) is out of date.

## Enquiry routes (2026-11-16, phase 3)

- **One enquiry form, reached four ways:** the practice website, a therapist's own page, a Google ad link, and
  Facebook. Phone capture by the therapist stays as the fifth route.
- **Each therapist either runs their own contact set-up or uses the practice default.** Every enquiry still ends
  up belonging to one therapist.
- **Proposed:** each route is a link that carries the therapist (or "practice default") and the channel, so the
  channel is recorded automatically and feeds the manager's statistics; the person is not asked how they heard.
- **Open:** how a practice-default enquiry reaches a therapist without the manager seeing who enquired; what
  "contact set-up" covers beyond the links (follow-up wording and timings?); whether the website shows the form
  embedded or links to it; whether ad click identifiers are kept (data-protection adviser).

## Build-out from the existing apps (2026-11-16)

- **Order:** therapist section and practice management first, using the BYH and ITC apps as the starting point;
  then the client area, which is close to a lift and shift from BYH.
  1. Client record (done): programme in sessions, sessions had before joining, under-16 consent, reminder settings.
  2. Booking and schedule (done). 3. Therapist account page. 4. Practice management (move clients, statistics, clean-up).
  5. Enquiries and documents (BYH enquiries plus the ITC pipeline). 6. Client area. 7. Reminders and daily digest.
- **Client area addition (step 6):** alongside the journal entry, the client can record a score from 1 to 10 for
  how they feel. Open: whether it is optional on each entry, and whether the therapist sees the scores as a trend
  (BYH lets the therapist see only how often a client writes, never what they wrote).
- **No Graph in this phase; revisit later.** BYH created Microsoft calendar meetings for sessions and had "send as"
  and calendar sync. Not carried over. Instead: appointment emails carry a calendar file, the therapist gets a
  private calendar feed to subscribe to, and changes send an updated file. Lost for now: clients accepting or
  declining from their calendar, and instant updates in the therapist's calendar.
- **Booking details.** A session is 60 minutes. Dates and times are entered and shown in UK time (fixed for now;
  becomes a practice setting when needed). A date in the past records a delivered session and sends no email.
  Appointment emails give the date and time only. In the therapist's own calendar a session shows as the client's
  first name and initial. The private calendar link is shown once and only its hash is stored. Cancelled sessions
  are kept on record; "remove" is for mistakes.
- **Under-16 consent follows BYH:** given in person and attested by the therapist when adding the client; the record
  cannot be created without it; the young person signs in with their own email; nothing is emailed to the guardian.
  (An earlier idea in this project of a consent link to the guardian is not built.)
- **Reopening a closed record** follows BYH: within four weeks the same programme carries on; after that a new
  programme starts and the earlier one is kept separately.
- **Read-only clients can sign in and read** (fixed: sign-in previously refused them).

## Phases

1. Foundations (this branch)
2. Carry over from BYH: roles, login, clients, sessions, journal, Graph email, reminders
3. Engagement module: structured enquiry, public phone form, pipeline and automated follow-ups, convert to client
4. Documents: server-side Word generation, secure storage, in-house signing
5. Reporting: enquiries, bookings, attendance by source
6. Cutover: data migration and DNS

## Backlog (captured, not scheduled)

- **Ratings and feedback.** Public side: Google Ads (spend/clicks/conversions via API) and Google
  Business Profile reviews (API, needs Google approval); directory and social likely manual. Private
  side: client feedback after sign-off, stored in the clinical area, never mixed with marketing data.
  Any review request goes to every client (no filtering who is asked).
- **AI-assisted automation.** Tier 1 automatic, no client content (reminder scheduling, follow-up
  timing, source tagging, monthly aggregate summary). Tier 2 AI drafts, practitioner approves before
  sending. Tier 3 human only (clinical, take-on decisions). Optional later: enquiry assistant limited
  to practical questions with hand-off. Identifiable data to an AI service needs a DPA and suitable
  hosting; default is aggregated/de-identified only.
- **Online booking and payments.** Website booking for the initial consultation and session blocks;
  bulk discounts, offers, gift vouchers as configurable rules; one practice calendar (Microsoft 365
  via Graph, with availability checks and short holds); payments via the provider's hosted checkout so
  card data never touches this app. Open: voucher liability/VAT (accountant), refunds on blocks.

- **Calendar provider.** The same provider question applies to calendars (Google, Outlook or none); touches 2b and
  online booking. Not decided.
- **"Connect Microsoft / Connect Google" sign-in** as an alternative to app registrations and app passwords for
  sole therapists. Needs a vendor-owned app registration and, for Google, app verification. Not decided.

## Enquiries (2026-11-14, from the mock-up)

- Two ways in, one queue: phone capture by the therapist (name, how heard, phone and email all optional except
  how heard) and a public self-service form (phone or email required). Each enquiry records which route it came by.
- New enquiries and contacts lead both staff landing screens, with a single "+ New enquiry" button.
- Open: whether the public form asks what the person wants help with (health information, so therapist-only if
  asked; default is that it does not). Open: whether phone capture sits behind the therapist's sign-in.

## Open items before real data

- Consent wording for under-16s and the controller/processor position (data-protection adviser).
- Processor/hosting paperwork for VPS2.
- Firewall check on VPS2 (MySQL on 3306 and a node process on 8090 were listening on all interfaces).
