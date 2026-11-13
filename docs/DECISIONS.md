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

## Open items before real data

- Consent wording for under-16s and the controller/processor position (data-protection adviser).
- Processor/hosting paperwork for VPS2.
- Firewall check on VPS2 (MySQL on 3306 and a node process on 8090 were listening on all interfaces).
