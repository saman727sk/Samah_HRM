# Samah HRM: gaps, suggestions and security review

For the product owner. Not for customers.
Based on the code as of 15 Nov 2026: a read of every page, plus a security review of the server.

**How sure each item is:**
- **(checked)**: confirmed in the code by me.
- **(review)**: found by the security reviewer reading the code, not tried against a running app.
- **(to check)**: needs a closer look before acting.

---

## 1. Fix first

| # | Problem | Why it matters | Suggested fix | Effort |
|---|---|---|---|---|
| 1 | **Managers can see their team's net pay.** (checked) Opening a team member's dashboard (`GET /api/dashboard/employee?employeeId=…`) returns their payslips, with net pay for the last 12 locked months. `server/src/services/dashboard.js:41-44` | Salary is private. The payslip page itself says "Managers never". | Return `payslips` only to the employee themself, HR and payroll staff. | Small |
| 2 | **Unsafe if `NODE_ENV` is not `production`.** (review) Without `JWT_SECRET` the server uses a fixed, public secret. Without email set up, the API puts reset links and sign-in codes in its responses. `npm run dev` and `npm run share` (the tunnels) never set `NODE_ENV`. `server/src/index.js:40`, `api/routes/auth.js` | If someone removes `JWT_SECRET` or the Resend key from `.env` while the app is shared, anyone can take over the owner account. Today your `.env` has both, so you are safe for now. | Refuse to start without `JWT_SECRET`. Show dev links and codes only with an explicit flag, and only to localhost. | Small |
| 3 | **One payroll person can pay themselves.** (review) Someone with the Payroll right can't change their own pay, but can change a colleague's IBAN to their own account, then approve, lock and export the bank file alone. The "different approver" rule is off by default and only compares against the person who created the run. | Fraud risk. This is the classic payroll attack. | Turn on two-person approval by default. Block approval by anyone who changed salaries or bank details that month. Notify the employee when their bank details change. | Medium |
| 4 | **The Payroll right opens everyone's personal records.** (review) `canView` lets payroll staff see every employee's attendance, leave, devices, work logs and files, HR admins' included. `server/src/services/access.js:33` | Too wide: payroll needs pay data, not task files. | Limit the payroll exception to the payroll and salary pages. | Small |
| 5 | **Rate limits break behind a tunnel or proxy.** (review) Behind Cloudflare or ngrok, every visitor looks like the same IP. One person can then use up the sign-in code limit for everyone, or spread password guesses across many emails. | Lock-out and password guessing. | Set `TRUST_PROXY` correctly when shared. Add per-account and overall login limits. | Small |
| 6 | **No backups.** (checked) All data lives in one embedded database folder (`server/.data/samah-db`). | A disk failure, a deleted folder or a bad update loses every company's data. | Run real PostgreSQL for production (the app supports it) with daily automatic backups, or at least copy the data folder every night to another machine or cloud storage. | Small to medium |

## 2. Security: worth doing soon

| Problem | Suggested fix |
|---|---|
| **No forced password change.** (checked) People keep the password HR gave them (e.g. 12345678), and HR knows it. | Add "must change password at first sign-in", and refuse very common passwords (12345678, password…). |
| **Weak password rules.** (checked) Only 8 characters are required, everywhere. | Check against a list of common or leaked passwords and show a strength meter. |
| **Changing a login email is silent.** (review) Nothing is sent to the old address and open sessions stay valid. One HR admin can also reset another HR admin's email and password: a quiet takeover between HR admins. | Notify the old email when the address changes, and end the sessions. Require a second HR admin, or the owner, to change another HR admin's login. |
| **Too many code guesses.** (review) Asking for a new sign-in code resets the wrong-guess counter, so one sign-in allows about 25 guesses. `services/loginOtp.js:118` | Keep the counter across resends. |
| **Login timing shows which emails exist.** (review) A wrong email answers faster than a wrong password. | Always run one password check, even when the email doesn't exist. |
| **Employees can read any company rule.** (review) An employee can read any setting resolved for themselves, including payroll formulas and tax rules. `services/settings.js:56` | Allow non-HR users only the keys they need. To check: whether those rules count as sensitive. |
| **Rights are not checked everywhere.** (review) A manager whose "Approve requests" right was removed can still grant WFH overrides and file requests for team members. | Check the right in those places too. |
| **Sign-in tokens stay valid too long.** (review) Tokens are kept in browser storage, last 12 hours, and there is no server-side sign-out. | Shorter tokens, or a cookie the page can't read, plus sign-out that ends the token on the server. |
| **No security headers.** (review) No CSP, HSTS or frame-ancestors on the web app or the API. | Add `@fastify/helmet` and set the headers on the web server. |
| **Old sessions survive a CLI password reset.** (review) `seed/reset-password.js` doesn't end existing sessions. The demo seed creates `owner@hrm.test` / `Passw0rd!`. | Increase `session_version` in the reset script, and refuse `--demo` when `NODE_ENV=production`. |
| **Firebase mode doesn't end sessions** on a password change. (review) | Revoke Firebase refresh tokens when the password changes. |

**Already done well** (review):
- Every query is scoped to the signed-in company. No route was found that reaches another company's data.
- SQL always uses parameters, never text built from the request.
- Reset, invite and sign-up tokens are random, stored only as hashes, used once and expire.
- Exported CSV files are protected against formula injection.
- Uploads are checked by their content and served as downloads.
- No HTML from users is shown on pages.
- `.env` and keys are not in git.
- Nobody can approve their own request, change their own access, or change their own pay.

---

## 3. Missing or unfinished features

| Area | What's missing | Suggestion |
|---|---|---|
| Attendance | "Auto check-out after leaving the office" can be edited in Policies but nothing uses it. (checked) | Build it in the mobile app, or hide the setting. |
| Attendance | Employees can't cancel a pending correction from the web page, although the server supports it. (checked) | Add a **Cancel** button. |
| Attendance | Auto check-in and selfie check-in refer to a **mobile app**. (to check) Whether that app exists is outside this code. | If there is no app, hide those modules or label them "coming soon". |
| Leave | The medical certificate is typed text, not a file upload. | Allow uploading a file, as tasks already do. |
| HR dashboard | With no payroll runs it says "payroll arrives in Phase 4": leftover development wording. (checked) | Change it to "No payroll runs yet". |
| Payroll | The "different approver" error still says "Another HR admin" although payroll staff can approve. | Reword it, and see item 3 in section 1. |
| Payroll | The tax table and minimum wage are examples (Pakistan 2026). | Have an accountant confirm them, and note who checked them and when. |
| Language | Many screens have no Urdu text, and the payslip PDF can't print Urdu names. | Translate the main screens, and add an Urdu-capable font to the PDF. |
| Tasks | Assigned tasks have no file attachments, no repeating tasks (e.g. every Monday) and no sub-tasks. | Add attachments (reuse the work-log file storage) and repeating tasks. |
| Help desk | No attachments; no assigning a request to one staff member; no reply-time tracking. | Add attachments, **Assign to**, and "waiting since". |
| Rota | No shift-swap requests; no warnings for too few people on a shift. | Let people request swaps, and set a minimum number of staff per shift. |
| Notifications | In-app and email only. | Add WhatsApp or SMS for urgent items (approvals, payslip ready). |
| Reports | Attendance CSV and payroll exports exist, but no leave report, headcount or turnover report, or tasks report. | Add a Reports page with these. |
| Employee self-service | Employees can't update their phone, address or emergency contact, or download letters (salary certificate, experience letter). | Add "My profile" and letter templates. |
| Documents | Employee documents (CNIC, contract, degree) can't be stored. | Add a documents section per employee with expiry reminders. |
| Onboarding and offboarding | No checklists (laptop, accounts, clearance). | Add simple checklists that use assigned tasks. |
| Performance | No goals or reviews. | Later: goals and yearly reviews. |
| Mobile | The web app works on phones, but check-in by location is less reliable in a browser. | Turn the web app into an installable PWA, or build the mobile app. |

---

## 4. Suggested order

1. **This week:** fix 1 (managers seeing pay), fix 2 (unsafe dev settings), and set up backups (6). Change the "Phase 4" text.
2. **Next:** two-person payroll approval with bank-change alerts (3), a narrower payroll right (4), forced password change and common-password check, and rate limits behind tunnels (5).
3. **Then:** security headers, email-change alerts, the remaining review items, and the cancel-correction button.
4. **Product:** reports page, employee documents and letters, task attachments and repeating tasks, help desk assignment, Urdu translation.
