# Samah HRM User Manual

For everyone who uses Samah HRM: employees, managers and team leads, help desk and payroll staff, HR admins, and the platform owner.

Each part of the manual is for one kind of user. Read **Part 1** first, then the part for your role. Managers should also read the employee part, and HR admins should read everything. Owner billing is covered in full in the separate [Billing Manual](billing-manual.md).

---

## Contents

1. [Getting started (everyone)](#part-1-getting-started-everyone)
2. [Employee guide](#part-2-employee-guide)
3. [Manager and team lead guide](#part-3-manager-and-team-lead-guide)
4. [Help desk staff and payroll staff](#part-4-help-desk-staff-and-payroll-staff)
5. [HR admin guide](#part-5-hr-admin-guide)
6. [Platform owner guide](#part-6-platform-owner-guide)
7. [What happens automatically](#part-7-what-happens-automatically)
8. [Troubleshooting and FAQ](#part-8-troubleshooting-and-faq)
9. [Cheat sheet](#part-9-cheat-sheet)

---

## Part 1. Getting started (everyone)

### 1.1 Who can do what

Everyone signs in with a **login**: an email and a password. Each login has one of four **levels**:

| Level | Sees | Typical person |
|---|---|---|
| **Employee** | Only their own attendance, leave, WFH, tasks, payslips and help desk requests | Most staff |
| **Manager / team lead** | Their own data, plus everyone who works under them, directly or through a team lead below them | Department heads, team leads |
| **HR admin** | Everyone in the company, plus all settings | HR team |
| **Owner (super admin)** | Every company on the platform: approvals, plans, billing | The company that runs Samah HRM |

On top of the level, HR can give a person extra **rights** on the **Teams & access** page:

| Right | What it allows | Who has it by default |
|---|---|---|
| Approve requests | Approve their team's leave, WFH, attendance corrections and overtime | Managers |
| Plan the rota | Set their team's shifts and days off | Managers |
| Assign tasks | Give their team tasks and read their work logs | Managers |
| Record attendance | Enter a check-in or check-out for someone in their team | Managers |
| Choose team features | Switch features on or off for each person in their team | Nobody (HR gives it) |
| Help desk | Read and answer everyone's help desk requests, like HR | Nobody (HR gives it) |
| Payroll | Run payroll and manage salaries and loans for everyone | Nobody (HR gives it) |

HR admins always have every right. The menu only shows what you are allowed to use. If you open a page you can't use, you see "This page doesn't exist or you don't have access to it."

### 1.2 Features (modules)

Each part of the app is a **module**: Attendance, Leave, Work from home (WFH), Daily tasks, Payroll (payslips), Overtime, Loans, Auto check-in and Selfie check-in. A module works for you only when all three of these are true:

1. HR switched it on for the company.
2. The company's plan includes it.
3. Nobody switched it off for you personally. HR, or a manager with the "Choose team features" right, can do that for Attendance, Leave, WFH, Daily tasks and Payslips.

If a module is off, its menu item disappears.

### 1.3 Signing in

1. Open the app and enter your **Email** and **Password**. Click **Sign in**.
2. If your email has a login in more than one company, the app asks **Which company?** Click the one you want.
3. If two-step sign-in is switched on, you see **Check your email**: a 6-digit code was sent to you.
   - Type or paste the code. It submits by itself.
   - The code works once and expires after 10 minutes.
   - You can use **Resend code** after 30 seconds, up to 5 times. Only the newest code works.
   - After 5 wrong codes you must sign in again.

Your login comes from HR, who tells you your email and starting password. Change the password after your first sign-in (see 1.5).

Common messages:
- **"Email or password is incorrect."**: check both. After 10 failed tries you must wait 15 minutes.
- **"… is waiting for approval"**: your company's sign-up hasn't been approved by the owner yet.
- **"… account is suspended"**: contact the owner.

### 1.4 Forgot your password

- **Ask HR.** HR can set a new password for you (People > Edit > Sign-in account > New password > Save).
- **Or use the sign-in page.** Click **Forgot password?**, enter your email and click **Send reset link**. You get an email with a link that works once, for 1 hour. Choose a new password (at least 8 characters). You are then signed out on every other device.

### 1.5 Change your password

Click the **lock** button next to your name at the bottom of the sidebar. Enter your **Current password** and the **New password** twice; the new one must be at least 8 characters and different from the old one. You stay signed in on this device and are signed out everywhere else.

### 1.6 Language, theme and the menu

- **Language:** the select box at the top switches between English and اردو (Urdu, shown right-to-left). Some screens are not translated yet and appear in English.
- **Theme:** the moon or sun button switches between dark and light mode.
- **Menu:** the sidebar is grouped into **Menu** (your own things), **Team** (managers), **Payroll** (payroll staff), **HR** and **Settings** (HR admins). On a phone, open it with the menu button at the top left.
- **Sign out:** the arrow button next to your name.

### 1.7 Notifications

The **bell** at the top shows your last 50 notifications. A red dot means some are unread. Click one to open the page it is about: a request, a task, a help desk reply, your payslip, and so on. Some events also send an email; see Part 7.

---

## Part 2. Employee guide

### 2.1 Your dashboard

Your home page shows:

- **Today**: a live clock, your shift (e.g. 09:00–18:00) and the **Check in** / **Check out** buttons (see 2.2).
- **Stats** for the month: days in office, WFH days, leave days, late arrivals, and WFH days left this week.
- **My tasks for today**: tasks your manager gave you, due today or overdue (see 2.5).
- **My shifts: next 7 days**: your shift each day, "Off" days, and holidays. Days your manager changed on the rota carry a **Rota** badge.
- **Month calendar**: each day marked Office, WFH, Leave, Absent or Holiday, plus a count of problems such as late arrivals or missed check-outs.
- **Today's work log**, **Leave balances** and **Recent requests**.

### 2.2 Checking in and out

The server records the time, not your phone or computer.

- **Check in (office):** the first time, you agree to **Location consent**. Location is read only when you check in or out, never in the background. Your browser must share your location, and you must be within the office's radius (for example 100 m). If you're too far, the message tells you the distance.
- **Check in (WFH):** appears only on a day your WFH was approved. Your registered browser or device is used to confirm it's you.
- **Check out:** at the end of the day.
- **Can't check in on:** weekends, holidays, days you're on leave, or days in a payroll month that is already approved or locked.
- **Forgot to check out?** At 23:30 (company setting) the system closes your session and notifies you ("Missed check-out"). The day then counts only up to your shift end. Request a correction if it's wrong.

How your day is judged, with the default settings (your company may differ):

| Result | When |
|---|---|
| **Late** | First check-in more than 15 minutes after your shift starts |
| **Half day** | More than 120 minutes late, or fewer than 8 hours worked |
| **Absent** | Fewer than 4 hours worked |
| **Overtime** | Time worked beyond your shift. Every minute on a weekend or holiday counts. |

If your manager put you on a different shift on the rota, lateness is judged against that shift. A rota **Off** day counts like a weekend.

### 2.3 Your attendance and corrections

Open **Attendance** to see each day of the month: status, in and out times, worked time, minutes late and notes.

If a time is wrong, click **Correct** on that day:
1. Choose **Check-in** or **Check-out** and enter the **Correct time**.
2. Write a **Reason** (required) and click **Send**.
3. Your manager approves or rejects it. Once approved, the correction is added and the day is marked "corrected". Your original punches stay on record.

You can't correct a future time, or a date in an approved or locked payroll month. Ask HR to adjust it in the next payroll instead.

### 2.4 Leave, work from home and overtime

Open **Leave & WFH**.

**Apply for leave:**
1. Choose the **Leave type** and **Duration**: full day(s), half day, or hours.
2. Choose the dates and add a **Reason**.
3. A green or red box shows straight away whether the request fits the rules, how many days it counts, and your balance afterwards. If it's red, the reasons are listed and you can't send it.
4. Click **Send request**. Your manager is notified. Days come off your balance only when it is approved.

Rules the app checks for you (your HR sets the values): notice period, how far back you can apply, maximum days in a row, probation, overlaps with other leave, enough balance, and medical certificate after N sick days. Leave can't cross the end of the leave year; split it into two requests. If several teammates are already off on those dates, you see a warning but can still send.

**Request WFH:** pick **Specific dates**, or a **Weekly pattern** (e.g. every Monday and Wednesday between two dates). A table checks each date: OK, or why not (weekend, already requested, over your weekly or monthly limit, not enough notice, and so on). Some companies approve WFH automatically within the limits.

**Claim overtime** (if your company uses it): choose the date and the minutes, up to what attendance recorded that day, and add a reason. One claim per day; very short overtime (under 30 minutes by default) isn't paid.

**Cancelling:** **My requests** on the right lists everything you sent.
- You can cancel pending requests, and approved leave that hasn't started yet. Cancelled approved leave is added back to your balance.
- Leave that has already started can only be cancelled by HR.

### 2.5 Daily tasks

Open **Daily tasks**. It has two tabs.

**Assigned tasks**: work your manager gave you.
- The list shows each task's due date ("Today", "Tomorrow", or red "Overdue") and priority (Low, Normal, High, Urgent).
- Click a task to open it:
  - **Start** marks it in progress.
  - **Mark as done** when it's finished.
  - **I'm blocked** asks what is blocking you, and your manager is notified.
  - **Discussion**: chat with your manager about this task. Ctrl + Enter sends.
- You're notified when a task is assigned or changed, and each morning (from 08:00) you get one **"Your tasks for today"** reminder listing what's due and overdue.

**Work log**: what you did each day.
1. Click **Log a daily task** and enter the date (today or earlier), title, hours, status, description, links and files.
   - Statuses: Completed, In progress, Blocked.
   - Files: PDF, Office documents, images or ZIP; up to 10 MB each, 10 per task.
2. If you mark it **Blocked**, say why: your manager is notified.

### 2.6 Payslips

Open **Payslips** (or the card on your dashboard). A month appears only after HR has **locked** its payroll. Click **View** to see earnings, deductions, net pay and your attendance for the month. Click **Download PDF** for a copy.

### 2.7 Help desk: ask HR

Open **Help desk** and click **Ask HR**:
1. Choose the topic: Salary & payslips, Leave, Attendance, IT & access, Letters & documents, or Other.
2. Write a subject and your question, then send.

Only HR and help desk staff can read it. You're notified (and emailed) when they reply. Reply in the same thread. When it's sorted, click **Close, it's sorted**. Replying to a closed request opens it again.

---

## Part 3. Manager and team lead guide

You see everything in the employee guide for yourself, plus the **Team** section in the menu. What you can do for your team depends on your rights (see 1.1). If a button is missing, ask HR for that right. Your **team** is everyone who works under you, directly or through a team lead below you; HR sets it up on **Teams & access**.

### 3.1 Team dashboard

**Team** shows:
- **Team today**: who is in the office, working from home, on leave, absent, not yet in, or late, with first check-in times.
- **Team calendar**: a month grid. **L** means leave (dashed while pending) and **W** means WFH. A red date means many people are off that day.
- Buttons: **Record attendance**, **Work reports**, **Team features** and **Approvals (N)**, depending on your rights.

### 3.2 Approvals

**Approvals** lists requests waiting for you: leave, WFH, attendance corrections and overtime. Each card shows who asked, what they asked for, and the step ("Step 1 · manager").

- Add an optional **Comment**, then click **Approve** or **Reject**. The employee is notified.
- A rejected request can't be reopened; they must apply again.
- Some requests need more than one approver (e.g. you, then HR). After you approve, it moves to the next person.
- If you don't decide in time (default 1 to 2 days), the request **escalates** to HR.
- You can never approve your own requests.

### 3.3 Rota

**Rota** shows your people as rows and the 7 days of the week as columns.

1. In each cell choose **Usual** (their normal shift), another shift, or **Off**.
2. Changed cells are highlighted. Click **Save rota (N)**.
3. Everyone whose rota changed is notified.

- **Copy last week** fills the week from the previous one; adjust it afterwards.
- Use **‹ This week ›** to move between weeks.
- A rota shift is what attendance uses that day: lateness is judged against it, and **Off** counts as a rest day.
- Days inside an approved payroll month are locked.
- To have more shifts to choose from, ask HR to add them (Lists & offices > Shifts).

### 3.4 Assigning tasks

On **Daily tasks** > **Assigned tasks**, click **Assign a task**:
1. Tick one or more people. Search and **Select all** help with big teams. Each person gets their own copy to update.
2. Enter the **Task** and a **Description** of what needs doing and what "done" looks like.
3. Pick the **Due date** (today by default) and **Priority**.
4. Click **Assign**. They're notified in the app and by email, and reminded on the morning it's due.

Switch to **Assigned by me / my team** to follow progress:
- Counters show overdue, due today, upcoming and done.
- A red note lists blocked tasks.
- Search by task, person or task number.
- Open a task to read and reply in its **Discussion**, **Edit** it (they're notified), **Reopen** it or **Delete** it.

If the list of people is empty, nobody works under you yet: ask HR to add people to your team.

**Work reports** (Team > Work reports) shows your team's work logs, hours and blockers.

### 3.5 Recording attendance for someone

For someone who couldn't check in themselves: **Team > Record attendance**.
1. Choose the person and the date.
2. Enter the check-in and check-out times. A check-out earlier than the check-in means the next morning.
3. Write a **Reason** (required) and save.

The person is notified, and the entry is marked "Entered manually" and kept in the audit log. You can't enter future times, times in a locked payroll month, or times that overlap existing ones.

### 3.6 Team features

With the "Choose team features" right, **Team > Team features** shows your people against the features: Attendance, Leave, Work from home, Payslips and Daily tasks.
- Untick a box to switch that feature off for that person; their menu hides it straight away and they're notified.
- **Turn all on** restores everything for that person.
- You can't change your own features.

---

## Part 4. Help desk staff and payroll staff

These are rights HR can give to anyone, not only managers.

**Help desk staff** (e.g. a support manager):
- Your **Help desk** page works like HR's: everyone's requests, a red count of those needing a reply, search, and the tabs Needs reply / Answered / Closed / All.
- You're notified of new requests.
- Your replies mark a request **Answered** and notify the employee.

**Payroll staff** (e.g. a payroll manager):
- A **Payroll** section appears in your menu with **Payroll** and **Salaries & loans**. They work exactly as described in 5.6 and 5.7.
- You can't change your own salary, bank details or loans; HR must do that.

---

## Part 5. HR admin guide

HR admins can do everything in Parts 2 to 4 for everyone, plus the HR and Settings pages.

### 5.1 HR dashboard

**HR dashboard** shows, for the chosen month:
- **Today**: the whole company's board: in office, WFH, leave, absent, not yet in, late.
- **Attendance days by department** (chart).
- **Approvals & payroll**: pending leave, WFH and corrections, and the payroll runs with their status.
- **WFH and leave usage by department**.
- **Alerts for the last 14 days**: missed check-outs and unverified times.
- Buttons:
  - **CSV (daily)** and **CSV (summary)** download the month's attendance.
  - **PDF / print**.
  - **Record attendance** for anyone.

### 5.2 People: employees and their logins

**People** lists active employees. Turn on **Show inactive** to include inactive and exited people. A yellow **No login** badge marks people who can't sign in yet. A grey **Limited access** badge means some features are switched off for that person.

**Add employee:**
1. Fill in code (filled in automatically), name, **Email**, phone, department, role, employment type, **Manager**, shift, office, joining date and probation end.
2. In **Module access**, untick any feature this person shouldn't have.
3. In **Sign-in account**, keep **Give them a login** on, choose **Access** (Employee, Manager / team lead, or HR admin) and type a **Password** of at least 8 characters.
4. Click **Save**, then give the person their email and password. No email is sent.

**Edit an employee:** change anything and click **Save**.
- **Email is the sign-in email.** Changing it changes the email they sign in with, and an email used by another login is refused.
- **Sign-in account:**
  - If they have a login, it shows the sign-in email and level. Type a **New password** (optional) to reset a forgotten one; they are signed out everywhere when you save.
  - If they have no login, choose **Access**, type a **Password** and click **Save** to create one.
- **Status:** setting **Inactive** or **Exited** stops their sign-in straight away. Their history is kept, and you can reactivate them later.

**Delete:** only for someone added by mistake, such as a duplicate or a wrong import row.
- People with history (attendance, requests, payroll, tasks, help desk requests) can't be deleted; you're offered **Mark as exited** instead.
- People who manage others must have their team moved first.
- You can't delete yourself.

**Give logins to everyone (N):** creates an Employee login for every active person without one, with one **starting password** you choose. People without an email are skipped and listed. Tell each person their email and the starting password, and ask them to change it.

**Import from CSV**, for adding many people at once:
1. Click **Download template** to get the column headings: Employee code, Full name, Email, Phone, Department, Role, Manager (code or email), Joining date, Status, Create login, Access level, and more.
2. Fill it in Excel or Google Sheets and save as **CSV**. Dates such as 2025-02-01, 01/02/2025 or 1 Feb 2025 all work. For a PDF list, copy it into a sheet first.
3. Pick the file. A preview shows what will be added or updated, problem rows and their reasons, and any new departments or roles it will create.
4. Click **Import**. Existing employee codes are updated, not duplicated.
5. Then use **Give logins to everyone** to set a starting password for them.

**Export CSV** downloads everyone in the same columns, ready to edit and import back.

### 5.3 Teams & access

**HR > Teams & access** is where you build the company's structure.

- **Add a manager / team lead:** pick a person (search the list) and click **Make manager**. If they have no login, enter their email and a password and one is created. They get the default manager rights.
- **Managers & teams tab:** click a manager on the left.
  - **Change rights**: tick what they may do (see 1.1). **Use manager defaults** resets it. Taking away "Approve requests" sends their pending approvals to HR.
  - **Add people**: tick people (with search and **Select all**) to put them under this manager. People who already have a manager move across.
  - **Remove**: takes a person out of the team.
  - You can't create a loop, such as putting someone's own boss under them.
- **Everyone tab:** everyone with their level, manager and rights.
  - **Access** gives anyone help desk or payroll rights.
  - **Give login** creates a login for one person.
- The banner at the top says how many people have no login, with **Give logins to everyone**.

People are notified when their access or team changes.

### 5.4 Help desk inbox

**Help desk** lists every employee request. The sidebar shows a red count of those needing a reply. Search by name, subject or number. Open a request to read the thread, reply (the employee gets a notification and an email), and **Close** or **Reopen** it.

### 5.5 Approvals as HR

HR sees its own approval steps. Turn on **Show every pending step (HR)** to see all open steps in the company. **HR override (finish all steps)** approves every remaining step at once; it is recorded in the audit log. If a manager doesn't decide in time, the request escalates to HR.

### 5.6 Payroll

**Payroll**: run one month at a time.
1. Pick the month and click **Run ‹month›**. Every active employee's payslip is calculated from attendance, leave, overtime, salary, loans and the payroll rules.
2. **Review.** The **N things to check** list shows warnings: no salary set, no IBAN for the bank file, open check-ins, unverified times, deductions above earnings. Click a name to see the payslip, with **Show how each line is worked out**.
   - Fix data, then **Recalculate** (draft only).
3. **Send for review** → **Approve.**
   - Approving freezes the month: corrections, leave, overtime and salary changes dated in it are refused.
   - The **Bank transfer (CSV)** file becomes available, with code, name, account title, bank, IBAN, amount, currency and reference.
4. **Lock payroll.** This is permanent. Payslips are published to employees (notification and email), and loan installments are marked deducted. Any later fix goes into next month.

Other actions:
- **Reopen** (from In review or Approved) needs a reason and returns the run to Draft.
- **Delete** is allowed only before approval.
- **Department cost (CSV)** shows the cost per department.

Payroll rules (pro-rating, overtime, tax slabs) live in **Policies & rules > Payroll**. The included tax table is an example: check it with your accountant.

### 5.7 Salaries & loans

Pick an employee at the top.

**Salary:**
- **New revision**: choose **Effective from** and enter an amount per component (Basic, HRA, Medical, and so on). A revision starting mid-month is pro-rated.
- You can't backdate into an approved or locked month.
- Only the latest revision can be removed.

**Bank details:** Bank, Account title and **IBAN**. The IBAN is checked. Only HR and payroll exports can read it.

**Loans & advances** (Loans module):
- **New**: choose loan or salary advance, first deduction month, amount and monthly installment. A preview shows the schedule (at most 120 installments).
- **skip** moves an installment one month later.
- **Stop** ends a loan.

### 5.8 Settings

**Policies & rules:** every rule has a date it takes effect from.
- **Areas:** work week, attendance rules, shift timings, WFH policy, leave types, leave year, payroll rules, tax table, and approval workflows for leave, WFH, corrections and overtime.
- **Company default and overrides:** a rule can differ by department, employment type, role or a single employee. A more specific override wins.
- **Changing a rule:**
  1. **Edit (create draft)**.
  2. **Preview impact** shows who is affected.
  3. **Publish…** with an **Effective from** date (today or later) and a change note.
- **History & rollback:** compare versions, or **Restore as draft**.

**Lists & offices:** departments, roles, employment types, **offices**, **shifts**, leave types, holiday calendars and public holidays, salary components, custom fields, and labels & translations.
- **Offices** need latitude, longitude and a check-in radius. **Use my current location** fills them in; a map shows the area.
- Codes can't be changed. Items in use can't be deleted; switch them off instead.

**Modules:** switch each module on or off for the company. Switching off hides it for everyone but keeps its data. Modules outside your plan need a plan upgrade.

**Import / export:** **Download settings** saves every list and rule as a file. Import shows a dry run first, and imported rules arrive as drafts to publish.

**Audit log:** every important change: who, what, when, with old and new values. It can't be edited or deleted.

**Company profile:** logo (PNG or JPEG up to 512 KB), name, email, phone, address, country and currency. These appear on payslips. Currency is fixed after the first payroll run.

### 5.9 Subscription

**Subscription** (HR only) shows:
- **Current plan**, its dates and the modules it includes.
- **Usage** against the plan's limits: active employees and HR admin logins.
- **Invoices:** **Pay by card** (if available), or **I've paid** to report a bank transfer with a receipt.
- **Plans:** choose monthly or yearly.

If the subscription is paused (trial ended, invoice unpaid or cancelled), employees see "The HRM is paused" and HR sees only this page until it's paid. Details are in the [Billing Manual](billing-manual.md), chapter 8.

---

## Part 6. Platform owner guide

The owner runs the platform for all companies. In short:

- **Platform dashboard:** companies, trials, paying subscriptions, monthly and yearly revenue (MRR and ARR), money collected and overdue, renewals coming up, and **Run billing check now**.
- **Companies:** search and filter, **Review** new sign-ups (**Approve** or **Reject** with a reason), add a company yourself, edit company details and HR admin logins, suspend or reactivate, delete a company (type its name to confirm), and manage its subscription.
- **Plans:** prices (monthly and yearly), trial days, employee and HR admin limits, and included modules. Existing companies keep their current price until a plan is assigned again.
- **Billing:** **To verify** (confirm or reject payments companies reported), **Invoices** (void with a reason) and **Payments & refunds**.
- **Platform settings:**
  - **Sign-up and sign-in:** self sign-up, approving companies first, and the email code at sign-in (two-step).
  - **Trials, invoices and tax:** trial plan and reminders, days to pay, grace days, tax.
  - **Getting paid:** support email and payment instructions.
  - **Audit log.**

Everything is explained step by step in the [Billing Manual](billing-manual.md).

---

## Part 7. What happens automatically

A background job runs about every 5 minutes. Each run it:

| What | When |
|---|---|
| Closes forgotten check-ins and notifies the person | Sessions still open at 23:30 (company setting) |
| Escalates undecided approvals | After 1 to 2 days, depending on the request type |
| Sends "Your tasks for today" | Once a day, from 08:00 company time |
| Billing: trials ending, renewals, overdue and paused companies | Every run |
| Removes unconfirmed company sign-ups | After 24 hours |
| Sends queued emails | Every run |

**Emails that go out:**

| Who gets it | Email |
|---|---|
| Employees | Task assigned or changed, the daily task reminder, task messages, a task marked blocked, help desk replies and closing, payslip ready, leave decisions (default) |
| Managers and HR | Leave requests to approve (default), new help desk requests (to HR and help desk staff), task messages from their team |
| Anyone signing in | The sign-in code, if two-step sign-in is on; a password reset link, if they ask for one |
| Companies | Sign-up confirmation, approval, invoices and payment confirmations |

Creating logins never sends an email: HR gives people their password.

---

## Part 8. Troubleshooting and FAQ

**I can't sign in with the email and password HR gave me.**
- Check you use the **sign-in email** shown in your record (People > Edit > Sign-in account). The record's Email is the sign-in email.
- Passwords are case-sensitive.
- After 10 wrong tries, wait 15 minutes.
- If the page asks for a code, look in your email: two-step sign-in is on.

**An employee shows "No login".** They were added without one. Edit them, set **Access** and a **Password**, and click **Save**. Or use **Give logins to everyone**.

**The "Who should do it?" list is empty when assigning a task.** Nobody works under that manager yet. HR: Teams & access > the manager > **Add people**, or set **Manager** on each employee's record.

**I typed a new password in the edit form but it didn't change.** The password is saved with the main **Save** button, and must be at least 8 characters.

**Check-in says I'm too far from the office.** Turn on precise location, or try near a window. Laptops can be hundreds of metres off. HR can widen the office radius in Lists & offices.

**Check in (WFH) is missing.** It appears only on days with approved WFH.

**My payslip isn't there.** It appears only after HR locks that month's payroll.

**I can't change something in last month.** That month's payroll is approved or locked. Ask HR to adjust it in the next payroll.

**A manager can't see the Rota or Approvals page.** HR took that right away, or the Attendance module is off. Check Teams & access > Change rights.

**A request is stuck with a manager who left.** HR can approve it with **HR override**. Taking away a manager's "Approve requests" right moves their pending approvals to HR.

---

## Part 9. Cheat sheet

| I want to… | Go to |
|---|---|
| Check in or out | Dashboard > Today |
| Fix a wrong time | Attendance > Correct |
| Apply for leave, WFH or overtime | Leave & WFH |
| See or update my tasks | Daily tasks > Assigned tasks |
| Log what I did today | Daily tasks > Work log > Log a daily task |
| See my payslip | Payslips |
| Ask HR something | Help desk > Ask HR |
| Change my password | Lock button next to my name |
| Approve my team's requests | Team > Approvals |
| Plan shifts | Team > Rota |
| Give my team a task | Daily tasks > Assign a task |
| Switch a feature off for a team member | Team > Team features |
| Add an employee with a login | HR > People > Add employee |
| Give everyone a login | HR > People > Give logins to everyone |
| Reset someone's password | HR > People > Edit > Sign-in account > New password > Save |
| Make someone a manager and give them a team | HR > Teams & access |
| Give someone help desk or payroll rights | HR > Teams & access > Everyone > Access |
| Run payroll | HR > Payroll > Run ‹month› → Send for review → Approve → Lock |
| Change a rule (leave, WFH, shifts, payroll) | Settings > Policies & rules |
| Add an office, shift or holiday | Settings > Lists & offices |
| Switch a module on or off | Settings > Modules |
| See who changed what | Settings > Audit log |
| Pay the subscription | Settings > Subscription |
