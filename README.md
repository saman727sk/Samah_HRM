# Samah HRM — attendance, WFH, leave & payroll

<img src="web/public/logo-full.png" alt="Samah HRM" width="280" />

Multi-tenant HRM where **every business rule is data**. The code contains engines that read rules; HR changes the rules from Settings (draft → preview → publish) without a developer or redeploy.

| Workspace | What | Status |
|---|---|---|
| `server/` | Node.js (Fastify) API, PostgreSQL schema, config store, policy engines, attendance, workflows | **Phases 1-3 done** |
| `web/` | React (Vite) — dashboards, check-in, requests, approvals, HR settings panel | **Phase 3 done** |
| `mobile/` | React Native (Expo) — geofenced auto check-in, offline sync | Phase 5 |

## Quick start

Requires Node.js 22.5+ (tested on 24). No database install needed: locally the server uses **PGlite** (real Postgres running in-process).

```bash
npm install
npm run seed            # demo company, attendance since last month, payroll, pending requests (add -- --reset to start over)
npm run dev             # API on :4000 + web app on http://localhost:5300 together (Ctrl+C stops both)
# or separately: npm run dev:server / npm run dev:web
npm test                # 210 automated tests, each on a fresh in-memory Postgres
```

Demo logins (password `Passw0rd!`):

| Email | Access |
|---|---|
| `owner@hrm.test` | Super Admin (SaaS owner) |
| `hr@acme.test` | HR Admin — Sara Ahmed |
| `bilal@acme.test` | Manager, Sales — Bilal Khan |
| `usman@acme.test` | Manager, Engineering — Usman Tariq |
| `ali@acme.test` | Employee, Sales — Ali Raza |

```bash
curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ali@acme.test","password":"Passw0rd!"}'          # -> { token }
curl -s localhost:4000/api/leave/balances -H "authorization: Bearer <token>"
curl -s -X POST localhost:4000/api/wfh/check -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"dates":["2026-11-02","2026-11-03"]}'
```

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Use a real PostgreSQL (15+) instead of PGlite |
| `PGLITE_DIR` | `./.data/pglite` | Where embedded data is stored |
| `JWT_SECRET` | dev value | **Required** when `NODE_ENV=production` |
| `JWT_TTL` | `12h` | Session length |
| `PORT` | `4000` | API port |
| `BCRYPT_ROUNDS` | `10` | Password hashing cost |
| `JOBS_INTERVAL_S` | `300` | Background jobs (auto-close, escalation, email); `0` turns them off |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Send emails over SMTP (see [Email](#email-smtp)); without `SMTP_HOST` emails are only logged |

### PostgreSQL (production)

Locally nothing is needed (PGlite). For production, or to try a real server, use PostgreSQL **15 or newer**.

1. **Install.** Windows: download the installer from postgresql.org/download/windows (or `choco install postgresql16`) and remember the `postgres` password you choose. Or use a hosted database (Neon, Supabase, Render, AWS RDS) and copy its connection string.
2. **Create a database and an app user** (in *SQL Shell (psql)* or pgAdmin, signed in as `postgres`):
   ```sql
   create user hrm_app with password 'choose-a-long-password';
   create database hrm owner hrm_app;
   ```
3. **Point the API at it** in `server/.env`:
   ```
   DATABASE_URL=postgres://hrm_app:choose-a-long-password@localhost:5432/hrm
   JWT_SECRET=<a long random string>
   ```
   Hosted databases usually need `?sslmode=require` at the end of the URL.
4. **Create the tables and demo data:** `npm run seed` (or `npm run migrate -w server` for tables only). `npm run dev` also applies new migrations on start.
5. **Backups:** `pg_dump -Fc -d "$DATABASE_URL" -f hrm-YYYYMMDD.dump`, restore with `pg_restore`. Hosted providers offer automatic backups; switch them on.

With `DATABASE_URL` set, Firebase (if configured) is used for **sign-in only**; the data lives in PostgreSQL and the Realtime Database sync is off. The embedded data in `server/.data` is not copied over: seed the new database or re-enter the data.

## Architecture

```
server/
  src/db/migrations/001_init.sql   full schema (36 tables), append-only triggers
  src/config/                      configuration engine
    registry.js                    shape + validation of each setting key (no values)
    resolver.js                    effective rule for employee + date, layered, cached
    store.js                       draft / validate / publish / history / diff / restore / retire
  src/engines/                     pure policy engines (no DB): wfh.js, leave.js, calendar.js
  src/services/                    data loading, RBAC, persistence, preview/simulation
  src/api/                         Fastify routes
  seed/defaults.json               default data copied into every new company
  seed/demo.js                     demo company "Acme Technologies"
  test/                            node:test suites
```

### How a rule is resolved

A setting is `(key, subject, scope)`, e.g. `('leave.type', <Annual>, department=Sales)`. Each has numbered **versions** (`draft | published | archived`) with `effective_from / effective_to`.

For an employee on a date, the engine stacks published layers, lowest priority first, and higher layers override field by field:

`company → department → employment type → role → employee` (and above all of these, temporary overrides such as `wfh_overrides`).

Overrides store only the fields they change (`{ "allowedWeekdays": [1,5] }`). The response says which version supplied each layer, and requests and ledger rows store the version ids they used.

### Guardrails

- **No retroactive changes.** `effective_from` must be today or later (tenant timezone) and outside approved/locked payroll periods. Publishing closes the running version the day before and archives superseded future versions. Past leave years are frozen.
- **Validation** runs on save and publish, with plain-language errors and warnings (`"The monthly limit (3) is lower than the weekly limit (4)…"`). It also flags unknown fields and validates overrides after merging with the inherited rule.
- **Lookups** (departments, leave types, shifts…) can't be deleted while referenced (disable instead). Leave type and shift codes are immutable.
- **Append-only** `attendance_events`, `leave_ledger` and `audit_log` are enforced by a DB trigger. Every change is audited with old and new values.
- **Cache:** resolved setting lists are cached per process and invalidated on publish. With multiple API instances, broadcast invalidation (Redis or `LISTEN/NOTIFY`).
- **Tenancy:** the tenant comes from the signed token, and every query filters on `tenant_id`. Ids sent by the browser (employee, department, leave type, manager…) are checked to belong to the caller's company before anything is stored, and composite foreign keys `(tenant_id, x_id) → (tenant_id, id)` make the database itself refuse a row that points into another company (migration `005_tenant_integrity.sql`).

### Setting keys (Phase 1)

| Key | Subject | Scopes |
|---|---|---|
| `attendance.calendar` | — | company, department, employee (weekend days, week start) |
| `wfh.policy` | — | all |
| `leave.year` | — | company (calendar or fiscal year start) |
| `leave.rules` | — | company, department (clash threshold, hours per day) |
| `leave.type` | leave type | all (entitlement, accrual, pro-rating, probation, tenure, carry-forward/expiry, encashment, notice, backdating, certificates, half-day/hourly, weekend/holiday counting, insufficient-balance handling) |
| `shift.rules` | shift | company (used in Phase 2) |

Payroll formulas, rules and the tax table are `payroll.*` keys too (see Phase 4), so they get versioning, preview and rollback for free.

> **Verify with your accountant / HR policy.** Leave quotas, statutory leave and the 2026 Pakistan holiday list in `seed/defaults.json` are examples. Islamic holiday dates are approximate (moon sighting). The payroll tax table and statutory rates are examples too (see Phase 4).

## API (Phase 1)

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Area | Routes |
|---|---|
| Auth | `POST /auth/login`, `GET /me` |
| Admin (super admin) | `GET/POST /admin/tenants` (new tenants are provisioned from `defaults.json`) |
| Lookups (HR) | `GET/POST /lookups/:entity`, `PATCH/DELETE /lookups/:entity/:id`. Entities: `departments, roles, employment-types, locations, shifts, leave-types, holiday-calendars, holidays, salary-components, custom-fields, translations` |
| Employees | `GET /employees` (scoped by role), `GET/PATCH /employees/:id`, `POST /employees` |
| Settings (HR) | `GET /settings/definitions`, `GET /settings?key=`, `GET /settings/resolve?key&subjectId&employeeId&date`, `GET /settings/templates`, `POST /settings/templates/:id/draft`, `GET /settings/:id/versions`, `POST /settings/:id/retire` |
| Versions (HR) | `POST /setting-versions`, `GET/PATCH/DELETE /setting-versions/:id`, `POST …/:id/validate`, `…/:id/preview`, `…/:id/publish`, `…/:id/restore`, `GET …/:id/diff?against=` |
| WFH | `POST /wfh/check`, `POST /wfh/requests`, `POST /wfh/requests/:groupId/decision`, `GET /wfh/quota`, `POST /wfh/overrides` |
| Leave | `GET /leave/types`, `GET /leave/balances`, `GET /leave/ledger`, `POST /leave/check`, `POST /leave/requests`, `POST /leave/requests/:id/decision`, `POST /leave/adjustments` |
| Other | `GET/PUT /features/:module`, `GET /audit`, `GET /i18n/:locale` |

Policy violations return `422` with `details.reasons: [{ code, params, message }]`. Messages come from the `translations` table in the caller's language (`Accept-Language`, e.g. `ur`), falling back to English.

## Phase 2: attendance & workflows

### Check-in / check-out (`POST /api/attendance/punch`)
- **Server time only.** `punch_time` is the server clock. `device_time` is stored alongside, and a difference above `attendance.rules.maxClockSkewMinutes` flags the punch `time_verified = false`.
- **Office punches** (`office_manual`, `office_auto`) must fall inside an office geofence (`locations.lat/lng/radius_m`). Location consent is required first, and location is captured only at punch time. `office_auto` also needs the `auto_checkin` module.
- **WFH punches** need an approved WFH day or an active override. Verification comes from `wfh.policy.verification`: `none`, `selfie` (needs the `selfie_verification` module plus selfie consent, with a **registered device always accepted as the non-biometric alternative**), or `ip_device`.
- **Offline (mobile):** the app stores a server-signed anchor from `GET /api/attendance/time-anchor` and sends `offline: { anchorToken, elapsedMs }` with each queued punch, giving a verified time. Without an anchor the device time is used and flagged `offline_unverified`. `clientPunchId` makes repeated syncs idempotent.
- **One open session** per employee. A forgotten session is auto-closed at `attendance.rules.autoCloseTime`, flagged `missed_checkout`, and the employee is notified. It counts only until shift end, never as overtime.
- **Daily status** (`GET /api/attendance/days`, `/today`): `present | wfh | on_leave | absent | holiday | weekend | not_yet | not_employed`. Flags include `late`, `half_day`, `short_hours`, `insufficient_hours`, `overtime`, `missed_checkout`, `unverified_time` and `corrected`. All of these come from the effective-dated `shift.rules`, so changing grace minutes never rewrites past days.
- **Corrections** are new rows plus an approval. On approval a `correction` event is appended and the replaced event is ignored, never edited or deleted. Corrections are blocked inside approved or locked payroll periods.

### Approval workflows (`workflow.leave`, `workflow.wfh`, `workflow.attendance_correction`)
Versioned settings that can be scoped like any other rule (company → … → employee). Each defines:
- `steps`: 1-5 of `manager`, `skip_level_manager`, `hr`. Missing or self approvers are skipped; with no approver left, the request goes to HR.
- `autoApprove`: leave only, e.g. `{ enabled, maxDays: 1, leaveTypeIds: [Casual] }`. WFH auto-approval stays in the WFH policy.
- `escalation`: `{ afterDays, to: hr | skip_level_manager }`, run by the job scheduler.
- `notify`: channels (`in_app`, `email`) and recipients for submit, decision and escalation.

The resolved workflow is snapshotted on the tasks, so editing a workflow never changes requests in flight. HR can decide any step or pass `override: true` to finish a request. Nobody approves their own request; the only exception is a company with a single HR admin, and that is audited. Approved leave that hasn't started can be cancelled, and the days return through a `usage_reversal` ledger line.

| Area | Routes |
|---|---|
| Attendance | `POST /attendance/punch`, `GET /attendance/today`, `GET /attendance/days?from&to`, `GET /attendance/time-anchor`, `GET/POST /attendance/corrections`, `POST /attendance/corrections/:id/cancel`, `POST /attendance/jobs/run` (HR) |
| Approvals | `GET /approvals` (my inbox; HR `?all=true`), `POST /approvals/:taskId/decision` `{ decision, comment, override }` |
| Requests | `POST /leave/requests/:id/cancel`, `POST /wfh/requests/:groupId/cancel`, `GET /team/calendar?from&to` |
| Privacy | `GET/POST /consents`, `GET/POST /devices`, `DELETE /devices/:id` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read` (texts come from `notify.*` translations, so HR can reword them) |

### Email (Resend or SMTP)

Emails are queued as notifications and sent by the background job. Without email settings they are only written to the server log.

**Resend** ([resend.com](https://resend.com), sends over HTTPS, so it works where SMTP ports are blocked). It takes priority over SMTP when set:

```
RESEND_API_KEY=re_xxxxxxxx                      # resend.com > API Keys (Sending access)
RESEND_FROM="Samah HRM <no-reply@yourdomain.com>" # a domain verified at resend.com/domains
```

Until a domain is verified, Resend only accepts `onboarding@resend.dev` as the sender and delivers only to the email of your Resend account. Verify your domain (add the DNS records Resend shows) before real companies use the system.

**SMTP** instead (Gmail, Outlook, Zoho, your host):

```
SMTP_HOST=smtp.gmail.com        # Outlook: smtp.office365.com · Zoho: smtp.zoho.com
SMTP_PORT=587                   # 465 with SMTP_SECURE=true
SMTP_USER=hr@yourcompany.com
SMTP_PASS=your-app-password     # Gmail: an App Password, not your normal password
SMTP_FROM="HRM <hr@yourcompany.com>"
```

Then check it with `npm run email:test -w server -- you@example.com` and restart the API. Failed sends are logged and the notification is marked `failed`.

## Phase 3: web app

Run `npm run dev:server` and `npm run dev:web`, open http://localhost:5300 and sign in with a demo login.

| Who | Screens |
|---|---|
| Everyone | **My dashboard**: today's status, the Check In / Check Out button (browser location plus a consent screen; WFH check-in on approved days), month calendar, WFH quota, leave balances, recent requests, payslips. **My attendance**: day-by-day times, flags and correction requests. **Leave & WFH**: apply with a *live policy check* (e.g. "2 of 2 WFH days used this week"), single dates or a weekly pattern, and cancel. |
| Managers | **Team dashboard**: who is in, WFH, on leave, absent or late today, and a team leave/WFH calendar with clash days marked. **Approvals** inbox with comments. |
| HR | **HR dashboard**: today's counts, attendance by department (chart plus table view), WFH and leave usage, unverified-time and missed-check-out alerts, pending approvals, payroll status, CSV export (daily or monthly summary) and PDF via print. **Employees**: add, edit and deactivate (also disables the login), with custom fields and an optional sign-in account. |
| HR settings | **Policies & rules**: one editor for every rule. Pick a scope (company, or an override for a department, role, employment type or employee), edit a draft, see plain-language validation, **preview who is affected and how** ("Ali Raza: WFH days left this week 1 → 2"), publish with an effective date, view history and diff, restore as draft. Starts from templates. **Lists & offices**: every lookup list, with a map pin and radius for office geofences. **Modules**, **Import / export** (JSON, dry run first, rules arrive as drafts), **Audit log**. |

The settings forms are not hand-built: the server derives each form from the same validator that checks it (`describeFields` in `config/checker.js`), so a new rule field appears in the UI automatically.

Screen texts go through the translations table, so HR can rename any term under *Lists → Labels & translations*. Urdu switches the layout to right-to-left. Light and dark mode follow the OS until toggled.

## Phase 4: payroll

Payroll works from the same data as everything else: attendance day summaries, approved leave (paid and unpaid days per date), approved overtime claims, loan installments and each employee's effective-dated salary.

### Rules are data
| Key | Subject | What it holds |
|---|---|---|
| `payroll.component` | salary component | `enabled`, `calculation` (`structure` takes the amount from the employee's salary; `formula` works it out), `formula`, `proRate`, `taxable`, `showIfZero`. All scopes, e.g. contract staff have EOBI switched off. |
| `payroll.rules` | — | `ruleDate` (`period_end`: a rule published mid-month applies to that month; `period_start`: from the next month), `proRateBasis` (calendar or working days), `variables` (named formulas such as `DAILY_RATE = MONTHLY_SALARY / CALENDAR_DAYS`, or numbers like `MIN_WAGE`), overtime (`requireApproval`, `minMinutes`), `approval.requireDifferentApprover` (maker-checker) |
| `payroll.tax` | — | annual tax slabs `{ above, fixed, rate }`, used by `tax()` in formulas |
| `workflow.overtime` | — | approval steps for overtime claims, like the other workflows |

### Formula engine (`engines/formula.js`, `engines/payroll.js`)
- **Sandboxed.** A small parser turns a formula into a tree, which is evaluated with only numbers, variables and whitelisted functions: `min max round floor ceil abs clamp if tax`. There is no `eval` and no property access. Length and complexity are capped, and division by zero is an error.
- **Values available:** attendance (`ABSENT_DAYS`, `HALF_DAYS`, `LATE_COUNT`, `LATE_MINUTES`, `PRESENT_DAYS`, `WORKING_DAYS`, `CALENDAR_DAYS`…), leave (`PAID_LEAVE_DAYS`, `UNPAID_LEAVE_DAYS`), `OT_HOURS` and `OT_OFFDAY_HOURS`, `PRORATE`, `MONTHLY_SALARY`, `STRUCT_<CODE>`, `LOAN_INSTALLMENT`, `MONTHS_OF_SERVICE`, every component code, the totals `GROSS`, `TAXABLE_EARNINGS` and `TOTAL_DEDUCTIONS`, and the payroll variables.
- **Dependency order.** Formulas may refer to each other in any order. A loop (`HRA → GROSS → HRA`) or an unknown name is reported in plain language **when publishing**, so a broken rule can never go live.
- **Formula builder** (Policies → Payroll): click to insert values and functions, then *Test formula* against a real employee and month ("= 6,420 for Ali Raza, 2026-09"). Previewing a draft shows each affected employee's net pay before and after, plus the total payroll impact.
- **Traceable.** Every payslip line stores its formula, the values it used and the setting versions it came from.

### Seeded components (all editable)
`BASIC`, `HRA` and `MEDICAL` come from the salary and are pro-rated for joiners and leavers. The rest are formulas:

| Component | Formula |
|---|---|
| `ABSENT` | `round((ABSENT_DAYS + HALF_DAYS * 0.5) * DAILY_RATE)` |
| `LATE` | `round(floor(LATE_COUNT / 3) * DAILY_RATE)` (every 3 late arrivals cost a day) |
| `UNPAID_LEAVE` | `round(UNPAID_LEAVE_DAYS * DAILY_RATE)` |
| `OVERTIME` | `round(OT_HOURS * HOURLY_RATE * 1.5 + OT_OFFDAY_HOURS * HOURLY_RATE * 2)` |
| `TAX` | slab tax on the projected annual taxable pay |
| `EOBI` | employee share |
| `EOBI_ER` | employer share (an employer contribution: counts in department cost, not in net pay) |
| `LOAN` | loan / advance recovery |
| `PF` | provident fund (disabled by default) |

> **Verify with your accountant.** The tax slabs (Pakistan, tax year 2026, salaried, without the surcharge above Rs 10M), the minimum wage, EOBI and every formula are **examples**. Check them against the current Finance Act and your policies before running real payroll.

### Payroll runs: Draft → In review → Approved → Locked
- **Draft:** calculated from live data. *Recalculate* any number of times. Employees without a salary, open check-ins, unverified punches, days not yet worked (counted as worked) and missing IBANs are listed as warnings.
- **Approved:** database triggers freeze the payslips. Attendance corrections, leave changes, overtime claims, salary revisions, new loans and rule changes dated inside the month are refused. The bank file and cost report can be exported. *Reopen* (with a reason) goes back to draft.
- **Locked:** permanent, enforced by a trigger on `payroll_runs`. Loan installments are marked as deducted, and employees are notified (in app and by email) that their payslip is ready. Corrections go into the next month.
- **A new rule applies from the next payroll.** Publishing can't be backdated into an approved or locked month, and locked payslips are stored values, never recalculated.

### Exports and screens
- **Payslip PDF** (server-rendered with pdfkit): `GET /api/payroll/payslips/:id/pdf`. Employees see only their own, and only once the month is locked. Managers never see salary data.
- **Bank transfer CSV** (approved or locked runs) and **department cost** CSV/JSON. CSVs are protected against formula injection.
- **Web:** HR gets **Payroll** (runs, steps, warnings, cost by department, payslips with "how each line is worked out") and **Salaries & loans** (revision history, bank details with an IBAN checksum, loan schedules with *skip*). Employees get **My payslips** and an **overtime claim** tab, and managers see overtime claims in **Approvals**.

| Area | Routes |
|---|---|
| Runs (HR) | `GET/POST /payroll/runs`, `GET/DELETE /payroll/runs/:id`, `POST /payroll/runs/:id/{recalculate,submit,approve,lock,reopen}`, `GET /payroll/runs/:id/bank.csv`, `GET /payroll/runs/:id/department-cost[.csv]` |
| Payslips | `GET /payroll/payslips/mine`, `GET /payroll/payslips/:id`, `GET /payroll/payslips/:id/pdf` |
| Salary (HR) | `GET/POST /payroll/employees/:id/salary`, `DELETE /payroll/salary-structures/:id`, `PUT /payroll/employees/:id/payment`, `GET/POST /payroll/loans`, `POST /payroll/loans/:id/cancel`, `POST /payroll/loan-installments/:id/skip` |
| Formulas (HR) | `GET /payroll/formula/meta`, `POST /payroll/formula/test` |
| Overtime | `GET/POST /overtime/claims`, `POST /overtime/claims/:id/cancel` (decisions go through `/approvals`) |

The demo seed gives everyone a salary, gives all but one employee bank details, switches on overtime and loans, adds a salary advance and an overtime claim waiting for approval, and runs and locks last month's payroll.

## Firebase (Authentication + Realtime Database)

The server runs in one of two modes, chosen by `server/.env`:

| | Local mode (default) | Firebase mode |
|---|---|---|
| Sign-in | API checks bcrypt passwords, issues its own JWT | **Firebase Authentication** (email/password). The browser signs in with Firebase; the API verifies the Firebase ID token and matches the user by Firebase UID |
| Creating users | password hashed into `users` | HR creates the employee's login as a **Firebase user** (password never stored by the HRM). Deactivating an employee disables the Firebase user. *Forgot password?* sends Firebase's reset email |
| Data | embedded Postgres in `server/.data` | **Realtime Database is the system of record**: every row of every table lives at `/hrm/tables/<table>/<id>` |

**How Firebase mode keeps the rules safe.** All business rules still run in the API. It keeps a local copy of the data as its query engine, which is how payroll, ledgers, reports and the database triggers that freeze locked payroll keep working unchanged.
- Every change is written to Firebase as one atomic update, and the version counter at `/hrm/_meta/version` goes up by one.
- Unsent changes are kept on disk, so a crash or lost connection never loses them.
- On startup, the API reloads from Firebase whenever Firebase has a newer version, for example on a new machine. If Firebase is empty, the local data is uploaded once.
- A writer lease (`/hrm/_meta/writer`) stops a second API instance from writing to the same database at the same time.
- Password hashes are never uploaded.

**Setup**
1. **Lock the database first.** It is currently in test mode, which means anyone can read and write it. In the Firebase console go to *Realtime Database → Rules*, paste [`database.rules.json`](database.rules.json) (deny everything; the API uses the Admin SDK, which bypasses rules) and publish. With the Firebase CLI: `firebase deploy --only database`.
2. *Authentication → Settings → User actions*: turn off **Enable create (sign-up)**, so only HR can create accounts.
3. *Project settings → Service accounts → Generate new private key*. Save the file as `server/firebase-service-account.json` (git-ignored) and uncomment `FIREBASE_SERVICE_ACCOUNT` in `server/.env`. `FIREBASE_DATABASE_URL` is already set.
4. Stop the API, run `npm run seed -- --reset`, then `npm run dev`. The reset **deletes everything under `/hrm`** and the local copy. It creates the demo logins as Firebase users and uploads the demo data.
5. The web app reads its Firebase config from `web/.env` (see `web/.env.example`).

Run **one** API instance per database; the lease refuses a second one. To run several, move the queries to a shared Postgres (`DATABASE_URL`) and keep Firebase for Authentication: with `DATABASE_URL` set, the service account alone switches on Firebase sign-in and the Realtime Database sync stays off (see [PostgreSQL](#postgresql-production)).

## Subscriptions & billing (super admin)

Sign in as `owner@hrm.test`. The super admin panel has **Dashboard** (companies, MRR/ARR, money collected and awaiting payment, renewals, charts), **Companies** (search, detail, change plan, custom limits, extend trial, cancel, suspend), **Plans**, **Billing** (all invoices and payments) and **Settings** (billing rules, payment instructions, platform audit log). Company HR admins see **Settings → Subscription**: plan, usage, invoices and how to pay.

| Status | Meaning | Access |
|---|---|---|
| `trialing` | free until the trial end (new companies start on the plan chosen in Billing settings) | full |
| `active` | paid up | full |
| `past_due` | an invoice is past its due date | full, with a warning banner |
| `unpaid` | still unpaid after the grace period | **paused**: only the Subscription page |
| `expired` / `cancelled` | trial ended / cancelled | **paused** until a plan is assigned |

- **Enforced on the server:** paused companies get `402 subscription_inactive` on every API call except `/me`, `/billing`, notifications and texts. Employee and HR-admin limits are checked when people are added (`402 plan_limit`), and a module outside the plan can't be switched on and counts as off.
- **Prices are copied** onto the subscription when a plan is assigned; editing a plan later doesn't change what existing companies pay. Changing plan starts a new period today and voids unpaid invoices of the old plan (no proration).
- **Daily job** (with the other background jobs): trial reminders and expiry, renewals, past due, unpaid. It is idempotent: one renewal invoice per subscription period (unique index) and dedupe keys on reminders. *Billing → Run billing check now* runs it on demand.
- **Payments are recorded manually** (bank transfer, cash, cheque…) against invoices; refunds are new rows, and payments can't be edited or deleted. Card numbers are never stored. Card payments through Stripe are recorded automatically (see [Online payments](#online-payments-stripe)).
- The example plans and PKR prices in migration `006_subscriptions.sql` are placeholders: edit them under *Plans*.

## Company branding

Samah HRM is the software; each company appears under **its own name and logo**.
- HR admins set them in **Settings → Company profile**: name, email, phone, address and logo (PNG or JPEG up to 512 KB, recognised from the file's content; SVG is refused because it can carry script).
- Staff see the company's logo and name in the header (its initials until a logo is uploaded). Payslips, on screen and as PDF, are printed on the company's letterhead: logo, name, address, phone. The platform is named only in a small "Powered by Samah HRM" line at the bottom of the app, never on payslips.
- Logos are stored per company (`tenant_logos`) and served from `/api/logos/<company id>?v=<version>` (public, so `<img>` tags and PDFs can load them; versioned, so browsers cache them until the logo changes).
- The sign-in page and the super admin panel show the Samah HRM logo.

## Same email in several companies

An email is unique **within a company**, not across the platform: two companies may each have a login `ali@gmail.com` (the same person or two people). Each is a separate account with its own password and data.
- **Signing in:** if the email and password match one company, it signs in directly. If they match several, the sign-in page asks **"Which company?"** and lists only the companies that password opens; the chosen company's name is shown in the header afterwards.
- **The super admin** (`owner@hrm.test`, the software owner) always signs in directly; that email can't be used for a company login.
- Firebase sign-in has one Firebase account per email, so in Firebase mode an email can belong to one login only.

## Test companies

`npm run seed` also adds dummy companies in every subscription situation (it skips ones that already exist), built by running the real billing code at past dates. Password for every login: `Passw0rd!`.

| Login | Company | Situation |
|---|---|---|
| `owner@hrm.test` | — | **Super admin** |
| `hr@acme.test`, `ali@acme.test` | Acme Technologies | Professional, 3 months paid (revenue chart data) |
| `hr@globex.test` | Globex Trading | Starter, invoice overdue: past due, still working |
| `hr@umbrella.test` | Umbrella Pharma | Professional, unpaid after the grace period: paused |
| `hr@stark.test` | Stark Industries | Enterprise yearly, paid |
| `hr@initech.test` | Initech Software | Free trial ending in 3 days (banner) |
| `hr@hooli.test` | Hooli Labs | Free trial ended: paused |
| `hr@wayne.test` | Wayne Enterprises | Signed up, waiting for approval (can't sign in) |
| `hr@cyberdyne.test` | Cyberdyne Systems | Suspended by the super admin |

Each company also has `staff@<slug>.test` (an employee). Delete them before going live (or start a fresh database).

## Public sign-up

The sign-in page links to **Create a company account** (`#/signup`) while *Settings → Billing → Companies can sign up* is on.

**You decide which companies may use Samah HRM.** With *New sign-ups need my approval* on (the default), a company that confirms its email is created as **pending**: nobody can sign in ("waiting for approval"), and the support email set in Billing settings gets a notice. In *Companies → Awaiting approval* the super admin **approves** it (its free trial starts that day and the owner is emailed) or **rejects** it (it stays blocked; the reason is kept in the audit log). Companies the super admin creates are active at once, and any company can be suspended or reactivated later.

1. The form (company, owner name, work email, password, phone, country, time zone, currency) sends a confirmation email. **Nothing is created yet**: the request waits in `signup_requests` with the password already hashed (Firebase mode: a disabled Firebase account) and only a SHA-256 hash of the link's token.
2. The link (`APP_URL/#/verify?token=…`) works once and for 24 hours. Opening it creates the company on the trial plan and the owner as its HR admin, then signs them in.
- An email that already has an account gets a "you already have an account" email; the form answers the same either way, so it can't be used to find out who is registered.
- Rate limits per network address: 5 sign-ups an hour, 10 sign-in attempts per 15 minutes per email. Unverified requests are deleted a week after their link expires.
- Without SMTP, the emails (with the link) are printed in the API log while `NODE_ENV` isn't `production`.

## Payments reported by companies

For payments made outside the system (bank transfer, JazzCash/EasyPaisa, cheque, cash):
1. The company's HR admin presses **I've paid** on an open invoice (or **Choose** on a plan, to buy it) on *Settings → Subscription*, and sends the amount, method, transaction ID, date and an optional receipt (PNG/JPEG/PDF, up to 2 MB, checked by content).
2. The super admin sees it under *Billing → To verify* (and on the dashboard), opens the receipt, and **confirms** it (the payment is recorded: the invoice becomes *Paid*; a plan purchase starts the plan) or **rejects** it with a reason the company sees.
3. The company is notified in the app and by email at each step; *Payments you reported* shows *Waiting for confirmation / Confirmed / Not confirmed*.

**Who creates invoices:** the system. When the super admin assigns a paid plan, when a renewal date arrives (daily job), or when a reported plan payment is confirmed. They appear at once on the company's Subscription page, with a notification and an email.

**Cleared means:** the invoice shows *Paid* (nothing *Due now*), the payment appears under *Payments received*, and the subscription is *Active*.

## Forgot password

*Forgot password?* on the sign-in page (`#/forgot`) emails a link to choose a new password (`#/reset?token=…`).
- The link works **once, for 1 hour**; only the newest link works. The token is stored only as a SHA-256 hash (`password_resets`).
- The answer is the same whether or not the email has an account. An email that signs in to several companies gets one link per company; each resets only that login.
- Resetting **signs the user out everywhere**: every local token carries the user's `session_version`, which the reset raises.
- Rate limits: 5 requests per 15 minutes per email and network address. The reset is written to the audit log.
- Firebase sign-in uses Firebase's own reset email instead.
- Without SMTP (outside production) the page shows the link itself for testing. **For real use, set the `SMTP_*` lines and `APP_URL`** (the address people open the app at, used in the link) in `server/.env`, and `NODE_ENV=production` on the live server.

Every password box has a show / hide button; new passwords show a strength meter and the rules they meet.

## Sign-in code (OTP)

After the right password, a **6-digit code is emailed** and must be entered before the user is signed in (all roles, the super admin too). Turn it on or off under **Settings → Joining & signing in**.
- The code works **once, for 10 minutes**; 5 wrong codes end the attempt (sign in again). *Resend code* is allowed every 30 seconds, at most 5 times. Only hashes of the code and of the browser's challenge token are stored (`login_challenges`).
- A wrong password never sends a code. Successful sign-ins with a code are written to the audit log.
- Without SMTP (outside production) the page shows the code for testing. In production without SMTP, sign-in stays password-only, since nobody could receive a code.
- **Emergency switch:** `LOGIN_OTP=off` in `server/.env` (then restart) turns the code off for everyone, e.g. if email stops working and you are locked out.
- Every account needs a **real inbox**, including the super admin's (`owner@hrm.test` is not one).

## Online payments (Stripe)

With `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set (see `server/.env.example`), the company's **Subscription** page gets **Pay now by card** on open invoices and **Choose** on paid plans. Both open Stripe Checkout, Stripe's own hosted card page, so card details never reach this server.

- **Nothing changes until Stripe's webhook confirms the payment.** `POST /api/billing/webhook` checks Stripe's signature on the raw body, stores every event once (`payment_webhook_events`, unique per event id) and applies it once: a plan purchase assigns the plan and records the payment against its invoice; an invoice payment records the payment. Redelivered events and repeated sessions are no-ops; the payment's Stripe id is unique in `payments`.
- A payment that can't be applied (the invoice was meanwhile paid by bank, a different currency, the plan no longer fits) is kept on the checkout with a note to refund it in the Stripe dashboard. Refunds made in Stripe are recorded in the super admin's *Billing → Refund* like any other refund.
- Without Stripe keys everything works as before: bank transfer with *payment instructions*, recorded by the super admin.
- Local testing: `stripe listen --forward-to localhost:4000/api/billing/webhook` (Stripe CLI) and card `4242 4242 4242 4242`.
- Payments are one-off per invoice: renewals issue an invoice that the company pays with *Pay now* (no saved card or automatic charging yet).

## Known simplifications (to revisit)

- Scope matching uses the employee's *current* department/role, not effective-dated job history.
- A leave request may not cross the leave-year end (the user is asked to split it).
- Changing an entitlement mid-year applies the new full-year quota to the current year (not pro-rated by change date).
- Selfie images are referenced by `selfie_ref` only. Storage and the HR-set retention purge come with the mobile app (Phase 5).
- Payroll periods are calendar months. Arrears for a locked month are entered as an adjustment in a later month, not recalculated.
- Payslip PDFs use pdfkit's built-in Latin fonts. Urdu names need an embedded font such as Noto Nastaliq.
- Dashboards compute from per-employee daily summaries. That is fine for hundreds of staff; for thousands, add a nightly summary table.
- PDF export of dashboards uses the browser's print-to-PDF. Payslips are real server-generated PDFs.
- The in-process cache and job scheduler assume one API instance. For several, use Redis or `LISTEN/NOTIFY` and a single worker.

## Roadmap

1. ✅ Schema, config store, API, WFH and leave engines, tests
2. ✅ Check-in/out (server time, geofence, WFH verification, offline), corrections, approval workflows, notifications, one month of demo attendance
3. ✅ HR Settings panel, employee/manager/HR dashboards, settings import/export, CSV/PDF export (light/dark, Urdu/RTL)
4. ✅ Payroll engine, sandboxed formula builder, salary structures, overtime claims, loans, runs (Draft → Review → Approved → Locked), payslip PDF, bank CSV, department cost
5. Mobile app: background geofencing and offline punch queue
