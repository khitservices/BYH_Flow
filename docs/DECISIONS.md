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
  2. Booking and schedule (done). 3. Therapist account page (done). 4. Practice management (move clients, statistics, clean-up).
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

## Step 4: practice management
- The practice manager's statistics page (`/practice/stats`) is counts only: per therapist (named, as staff) the number of active clients, upcoming sessions, sessions delivered and cancelled in the last 30 days and pending change requests, plus practice totals. Client names, emails and notes are never queried for this page. Enquiry counts by route and stage arrive with the enquiries step.
- BYH hid small numbers (fewer than 5) and showed no per-therapist breakdown. Kev asked for counts by therapist and the Team page already shows each therapist's client count, so exact counts are shown. Revisit if a larger practice wants suppression.
- Moving clients between therapists needed no new tool: handover (therapist account page) and removal-reassignment (Team page) already cover it.
- BYH's `/admin/cleanse` web route is replaced by `scripts/cleanse.js`, run on the server only: `keepteam` clears clients, sessions and enquiries, `full` also clears therapists; practice managers and settings are always kept. It needs `--confirm ERASE`. There is deliberately no web page for it.

## Step 5a: enquiries (documents follow as 5b)
- Every enquiry belongs to one therapist from the moment it arrives; the practice manager sees counts only (by route and by stage, on the statistics page).
- Routes: `website`, `therapist_page`, `google`, `facebook`, `phone`. The practice form (`/enquire`) asks which therapist (Kev's choice; preselected when there is only one). A therapist's own page is `/enquire/t/<12-hex slug>`; `?src=google` or `?src=facebook` on either link records that route. Website is link-only for now (no embed).
- The public form takes name, email and/or phone, and "for a child under 16" with the child's name. It never asks why the person is enquiring. A hidden field catches bots, and accepted enquiries are limited to 5 per connection per hour.
- The therapist is emailed "you have a new enquiry" with no personal details in the message.
- Phone capture is a form inside the signed-in therapist's Enquiries page.
- Stages: new, consultation set, proceeding, not proceeding, now a client. Setting a consultation date emails the enquirer a calendar file (when they gave an email); moving it replaces the entry; "not proceeding" or deleting cancels it.
- "Turn into a client" pre-fills the add-client form (for a child: the child's name, and the parent as guardian). Saving marks the enquiry converted. Consent for under-16s is still recorded by the therapist as before.
- Open enquiries move with the clients when a therapist is removed (a taker is now required if they have open enquiries) and when "hand over all" is used.
- Deliberately not in 5a: no acknowledgement email to the enquirer; consultations do not yet appear on the schedule or calendar feed; ITC's agreement stages (agreement ready, sent, signed), booking letter and agreement documents, and follow-up prompts belong to 5b.
- Added (Kev): the full enquiry form the therapist completes themselves, as in the ITC contact app (`/therapist/enquiries/new`): adult or child, first and last name, email, telephone, address, enquiry date, optional consultation date and time, parent or guardian name, relationship, email and telephone for a child, and notes. It replaces the short phone form. Route is recorded as "Entered by therapist".
- The enquiry record now follows ITC's meaning: `name` is always the person the therapy is for (the child, for a child) and the parent or guardian has their own fields. A child enquiry from the public form puts the parent's details in the guardian fields. Calendar and consultation emails for a child go to the guardian's email (else the contact email), as in ITC.
- Differences from ITC to confirm: ITC makes email, telephone and enquiry date compulsory; here a name and at least one way to reach them are needed, because phone enquiries often have only a number. ITC's address is stored but not yet used until the documents step.

## Programmes and fixed-price sessions (Kev, step 5)
- The practice manager keeps a list of named programmes (`/practice/programmes`): name, number of sessions, optional price. A single fixed-price session such as smoking cessation is a programme of 1 session. The existing 6, 8, 10 and 12 session lengths are seeded with no price; no prices are invented.
- The therapist chooses a programme when adding a client, and when reopening a client whose earlier programme has lapsed. The client keeps a copy of the programme's name, sessions and price from then, so changing or retiring a programme never alters an existing client. Programmes are retired, never deleted.
- Prices are recorded and shown to the therapist only. No payments or invoicing here (commerce is parked). Showing the price to the client is a later choice.
- A one-session programme starts with weekly reminders off. "Extend programme" still adds 6, 8, 10 or 12 sessions.
- Not yet done: choosing a programme on an enquiry (ITC's fee per session belongs with the agreement documents, step 5b).

## Weekly "how I feel" score (Kev, step 6 and 7)
- The client enters a score from 1 to 10 for how they feel, once a week, in the client area.
- The therapist can see each client's scores week on week (a trend), so this is clinical data: visible to that client's therapist only, never to the practice manager (statistics may show a count of scores entered, never values).
- It is part of the weekly reminder cycle (step 7): the weekly reminder asks for the score along with the journal. One-off (1-session) programmes have reminders off by default.
- Open for step 6: whether the score is entered with a journal entry or on its own, and whether a missed week is simply blank on the trend.

## Step 5b: forms, signing and the client folder (Kev)
- Workflow: client reaches out → enquiry → consultation booked (calendar file emailed, using ITC's booking-letter wording) → therapist marks **attended** and picks a form, fee per session and in person or online → the form is emailed as a **link** → the signer reads and signs **inside the app** (no attachments to chase) → the signed copy is stored for the therapist, in the enquiry and then the client folder. Sent and received entirely in the app; email only carries the link and a copy.
- Signature: typed full name plus a tick to agree. The app records the time, the connection address and a SHA-256 fingerprint of the exact text signed, and seals a PDF with all of it. Typed name only is not enough on its own; the tick is required.
- Forms are **templates held as data** (`core.form_templates`): sections, which signer details to ask for (address, phone, relationship), yes/no and tick choices, and merge fields ({{therapist_name}}, {{fee}}, {{session_format}} and so on). The ITC adult agreement and the ITC parental-consent form (2025 wording, lifted from Katrina's Word templates) are seeded as the defaults. The practice manager can add, edit, preview and retire templates (`/practice/forms`), so another practice or a standalone practitioner can have their own wording.
- A sent form stores the exact text shown. Editing or retiring a template later never alters a form already sent or signed.
- Adult forms are signed by the client. For a child the parental-consent form goes to the parent or guardian (guardian email, else the contact email) and they sign through the emailed link. A child's client area shows only its status.
- Signing links last 30 days, are single use, and a resend voids the earlier link. The signed PDF is encrypted at rest in the file store (key FILE_ENCRYPTION_KEY, separate from SECRETS_KEY).
- Visibility: a therapist sees and opens only their own enquiries' and clients' forms; another therapist gets 404, the practice manager gets 403 and never sees signed forms. Opening a signed form is audited. The therapist is told a form was signed with no personal details in the email.
- When an enquiry becomes a client, its forms move into the client folder. A therapist can also send a form from a client record (for clients added directly).
- The therapist's own details used on forms (qualifications, address, postcode, phone, usual fee) are on their account page.
- Differences from ITC's Word flow: the wellbeing-tracker Yes/No and newsletter choices are made by the signer, not pre-set by the therapist; the fee is entered at "attended" (defaulting to the therapist's usual fee); address and phone are asked of the signer rather than copied from the enquiry. Booking letter: the "[day, date] 52 Longleaf Drive" address line is not used because the venue is not recorded; the rest of ITC's wording is.
- Not yet: reminders for unsigned forms (step 7), drawn signatures, a form builder beyond the text format, and automatic forms on other triggers.
- IMPORTANT: FILE_ENCRYPTION_KEY now protects signed forms. If it is lost they cannot be read. It must be backed up away from the server, alongside the byh-flow_files volume.

## Layout and landing pages (Kev)
- This is not strictly a mobile app: working pages now use the screen. Three widths: narrow (sign-in, public enquiry form), "read" (forms and settings, 700px) and "wide" (working pages, up to 1040px, with cards and two-column lists). Under 700px everything stacks full-screen, so the phone still works.
- Each user type has a landing page with a top bar (name, Home, Sign out):
  - Therapist (`/therapist`): today's sessions, new enquiries and consultations coming up, active clients and any who have asked to change a session, forms waiting to be signed, account.
  - Practice manager (`/practice`): numbers only. Team, clients and sessions, enquiries by stage, programmes, forms, set-up. Warns if email is not set up or a therapist has asked to close their account. Never a name or detail.
  - Client (`/journal`): next session and where they are in the programme, forms to sign or open, relaxation link, and a placeholder for the journal and weekly score (step 6).
- Enquiries: "Mark as proceeding" removed (it changed a label but created no client). An enquiry that is not yet a client has a clear "Add as a client" button; once converted the card links to the client record.

## Enquiry → client (decided 17 Nov 2026)
- **Booking the initial consultation (IC) ends the enquiry.** The person becomes a client at once, status **Consultation booked** → **Attended** → **Active**. Enquiries hold only people not yet booked.
- At IC booking: client record created, booking email with calendar file sent, and an invitation to the client area sent (needs an email; for a child with none of their own, the parent or guardian's address is used). A phone-only enquiry cannot be booked until an email is added.
- Programme (and price) is chosen when they proceed after the IC; that makes them Active and starts session counting. For under-16s consent is attested at that point (database refuses an Active under-16 without it).
- After the IC the therapist marks Attended and sends the forms from the client record, or records that they are going ahead.
- Clients at the consultation stage can sign in (forms, consultation date); programme, reminders and sessions are not offered until Active.
- **Archive.** Enquiries archived by hand or untouched for 60 days, and clients marked **Did not proceed**, are kept (not deleted) and leave the working lists. A returning person (same email or phone) is matched against the *same therapist's* archive only; the therapist confirms with one click and the old record is restored (no duplicate). Archived clients cannot sign in. The manager sees archive counts only.
- Parked: auto-archive of long-quiet Consultation-stage clients; practice-wide matching across therapists (deliberately not done: would reveal one therapist's records to another).

## Blocks of sessions (decided 17 Nov 2026)
- A client can book a block, then further blocks, or a standalone single session (a 1-session programme). Each is a distinct **block** (own programme name, session count, price, history); **one is current at a time**. No new forms by default.
- Starting a further block needs the current one finished, or "end it early" ticked. Earlier blocks are kept; sessions booked afterwards belong to the new block, and "session N of M" counts within the current block only.
- Therapist record lists every block; the client area shows the current block and the names of earlier ones.
- Practice manager sees counts only by programme name: blocks started, sessions delivered, clients on a second or later block, standalone single sessions. No names, no per-client prices. (Income totals: not wanted for now.)
- Parked: two blocks running at once.
