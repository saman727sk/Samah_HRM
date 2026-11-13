/**
 * Registry of setting keys the engines understand.
 *
 * This file describes the SHAPE of each rule (what fields exist, valid
 * ranges, which scopes may override it). It contains no business values:
 * every number/limit comes from setting_versions rows (seeded from
 * seed/defaults.json and edited by HR).
 *
 * validate(c, { full }) receives a checker; `full` is true when validating
 * the merged, effective value (all required fields must be present).
 */
import { checker, dayName, describeFields } from './checker.js';
import { isReservedName, payrollFunctions } from '../engines/payroll.js';

const ALL_SCOPES = ['company', 'department', 'employment_type', 'role', 'employee'];

export const SCOPE_TABLES = {
  department: 'departments',
  employment_type: 'employment_types',
  role: 'roles',
  employee: 'employees',
};

export const PUNCH_METHODS = ['office_auto', 'office_manual', 'wfh'];
export const APPROVER_KINDS = ['manager', 'skip_level_manager', 'hr'];
export const RECIPIENTS = ['approver', 'requester', 'manager', 'hr'];

/** Shared shape of 'workflow.<request type>' settings. */
function workflowDefinition(label, { autoApproveHere }) {
  return {
    label,
    scopes: ALL_SCOPES,
    form: {
      refs: { 'autoApprove.leaveTypeIds': 'leave-types' },
      listItems: { steps: [{ key: 'approver', label: 'Approver', type: 'select', options: APPROVER_KINDS }] },
    },
    validate(c) {
      c.allowKeys('', ['steps', 'autoApprove', 'escalation', 'notify']);
      c.allowKeys('autoApprove', ['enabled', 'maxDays', 'leaveTypeIds']);
      c.allowKeys('escalation', ['afterDays', 'to']);
      c.allowKeys('notify', ['channels', 'onSubmit', 'onDecision', 'onEscalation']);
      c.list('steps', 'Approval steps', (s) =>
        s && APPROVER_KINDS.includes(s.approver) && Object.keys(s).length === 1
          ? null : `each step needs one approver: ${APPROVER_KINDS.join(', ')}.`);
      const steps = c.get('steps');
      c.rule(!Array.isArray(steps) || (steps.length >= 1 && steps.length <= 5), 'steps', 'Add between 1 and 5 approval steps.');
      c.object('autoApprove', 'Auto-approval');
      c.bool('autoApprove.enabled', 'Auto-approve');
      c.num('autoApprove.maxDays', 'Auto-approve up to (days)', { min: 0, max: 366, nullable: true });
      c.ids('autoApprove.leaveTypeIds', 'Auto-approve only these leave types');
      c.object('escalation', 'Escalation');
      c.int('escalation.afterDays', 'Escalate when undecided after (days)', { min: 1, max: 60, nullable: true });
      c.oneOf('escalation.to', 'Escalate to', ['hr', 'skip_level_manager']);
      c.object('notify', 'Notifications');
      c.subset('notify.channels', 'Notification channels', ['in_app', 'email']);
      c.subset('notify.onSubmit', 'Notify on submit', RECIPIENTS);
      c.subset('notify.onDecision', 'Notify on decision', RECIPIENTS);
      c.subset('notify.onEscalation', 'Notify on escalation', RECIPIENTS);
      if (autoApproveHere) {
        c.warn(c.get('autoApprove.enabled') === true && c.get('autoApprove.maxDays') == null, 'autoApprove.maxDays',
          'Auto-approve is on with no day limit, so every request of the selected types is approved automatically.');
      } else {
        c.warn(c.get('autoApprove.enabled') === true, 'autoApprove.enabled',
          'Auto-approval for this request type is not used here (WFH auto-approval is part of the WFH policy).');
      }
    },
  };
}

const registry = {
  'attendance.rules': {
    label: 'Attendance rules',
    scopes: ['company', 'department', 'employee'],
    validate(c) {
      c.allowKeys('', ['autoCloseTime', 'maxClockSkewMinutes', 'requireLocationConsent', 'allowedMethods', 'exitGraceMinutes', 'maxOfflineDays']);
      c.time('autoCloseTime', 'Auto-close open sessions at');
      c.int('maxClockSkewMinutes', 'Allowed device clock difference (minutes)', { min: 0, max: 120 });
      c.bool('requireLocationConsent', 'Require location consent');
      c.subset('allowedMethods', 'Allowed check-in methods', PUNCH_METHODS, { min: 1 });
      c.int('exitGraceMinutes', 'Auto check-out after leaving the office for (minutes)', { min: 0, max: 240 });
      c.int('maxOfflineDays', 'Accept offline punches up to (days old)', { min: 0, max: 30 });
    },
  },

  'workflow.leave': workflowDefinition('Leave approval workflow', { autoApproveHere: true }),
  'workflow.wfh': workflowDefinition('WFH approval workflow', { autoApproveHere: false }),
  'workflow.attendance_correction': workflowDefinition('Attendance correction workflow', { autoApproveHere: false }),
  'workflow.overtime': workflowDefinition('Overtime approval workflow', { autoApproveHere: false }),

  'attendance.calendar': {
    label: 'Work week',
    scopes: ['company', 'department', 'employee'],
    validate(c) {
      c.allowKeys('', ['weekendDays', 'weekStartsOn']);
      c.weekdays('weekendDays', 'Weekend days');
      c.int('weekStartsOn', 'First day of the week', { min: 0, max: 6 });
      const w = c.get('weekendDays');
      c.rule(!Array.isArray(w) || w.length < 7, 'weekendDays', 'At least one day of the week must be a working day.');
    },
  },

  'wfh.policy': {
    label: 'Work-from-home policy',
    scopes: ALL_SCOPES,
    form: {
      refs: { 'eligibility.allowedRoleIds': 'roles' },
      listItems: { blackoutDates: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reason', label: 'Reason', type: 'text' }] },
      help: { 'eligibility.allowedRoleIds': 'Leave empty to allow every role.', verification: 'How a WFH check-in is verified.' },
    },
    validate(c) {
      c.allowKeys('', ['enabled', 'maxPerWeek', 'maxPerMonth', 'allowedWeekdays', 'blackoutDates', 'eligibility', 'requests', 'verification']);
      c.allowKeys('eligibility', ['blockDuringProbation', 'minServiceMonths', 'allowedRoleIds']);
      c.allowKeys('requests', ['minNoticeDays', 'allowMultipleDates', 'allowRecurring', 'maxRecurringWeeks', 'approval', 'countPendingInQuota']);
      c.bool('enabled', 'WFH enabled');
      c.int('maxPerWeek', 'Max WFH days per week', { min: 0, max: 7 });
      c.int('maxPerMonth', 'Max WFH days per month', { min: 0, max: 31 });
      c.weekdays('allowedWeekdays', 'Allowed WFH weekdays');
      c.list('blackoutDates', 'Blackout dates', (b) =>
        b && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && typeof b.reason === 'string' && b.reason.trim()
          ? null : 'each blackout date needs a date and a reason.');
      c.object('eligibility', 'Eligibility');
      c.bool('eligibility.blockDuringProbation', 'Block WFH during probation');
      c.int('eligibility.minServiceMonths', 'Minimum months of service', { min: 0, max: 600 });
      c.ids('eligibility.allowedRoleIds', 'Allowed roles');
      c.object('requests', 'Request rules');
      c.int('requests.minNoticeDays', 'Minimum notice (days)', { min: 0, max: 365 });
      c.bool('requests.allowMultipleDates', 'Allow multiple dates per request');
      c.bool('requests.allowRecurring', 'Allow recurring weekly requests');
      c.int('requests.maxRecurringWeeks', 'Max weeks for a recurring request', { min: 1, max: 52 });
      c.oneOf('requests.approval', 'Approval', ['manager', 'auto_within_limits']);
      c.bool('requests.countPendingInQuota', 'Count pending requests against the quota');
      c.oneOf('verification', 'WFH check-in verification', ['none', 'selfie', 'ip_device']);

      const week = c.get('maxPerWeek');
      const month = c.get('maxPerMonth');
      const days = c.get('allowedWeekdays');
      c.warn(Number.isInteger(week) && Number.isInteger(month) && month < week, 'maxPerMonth',
        `The monthly limit (${month}) is lower than the weekly limit (${week}), so the weekly limit can never be fully used.`);
      c.warn(Number.isInteger(week) && Array.isArray(days) && week > days.length, 'maxPerWeek',
        `The weekly limit (${week}) is more than the number of allowed weekdays (${days?.length}: ${(days ?? []).map(dayName).join(', ') || 'none'}).`);
      c.warn(c.get('enabled') === true && week === 0, 'maxPerWeek', 'WFH is enabled but the weekly limit is 0, so no request can ever be approved.');
    },
  },

  'leave.year': {
    label: 'Leave year',
    scopes: ['company'],
    validate(c) {
      c.allowKeys('', ['startMonth', 'startDay']);
      c.int('startMonth', 'Leave year start month', { min: 1, max: 12 });
      c.int('startDay', 'Leave year start day', { min: 1, max: 28 });
    },
  },

  'leave.rules': {
    label: 'General leave rules',
    scopes: ['company', 'department'],
    validate(c) {
      c.allowKeys('', ['teamClashMaxOff', 'hoursPerDay']);
      c.int('teamClashMaxOff', 'Team clash warning threshold (people off on one day)', { min: 1, max: 1000 });
      c.num('hoursPerDay', 'Hours in a leave day (for hourly leave)', { min: 1, max: 24 });
    },
  },

  'leave.type': {
    label: 'Leave type rules',
    subjectTable: 'leave_types',
    scopes: ALL_SCOPES,
    form: {
      listItems: { tenureBands: [{ key: 'minMonths', label: 'From months of service', type: 'int' }, { key: 'entitlementDays', label: 'Days per year', type: 'num' }] },
      help: { entitlementDays: 'Leave empty for unlimited (e.g. unpaid leave).', probationEntitlementDays: 'Leave empty to use the normal quota during probation.' },
    },
    validate(c) {
      c.allowKeys('', ['paid', 'entitlementDays', 'accrual', 'proRate', 'probationEntitlementDays', 'allowDuringProbation',
        'tenureBands', 'carryForward', 'encashment', 'maxConsecutiveDays', 'minNoticeDays', 'maxBackdatedDays',
        'medicalCertificateAfterDays', 'allowHalfDay', 'allowHourly', 'countWeekends', 'countHolidays', 'insufficientBalance']);
      c.allowKeys('accrual', ['enabled', 'daysPerMonth', 'postOn']);
      c.allowKeys('proRate', ['joiners', 'leavers', 'roundingStep']);
      c.allowKeys('carryForward', ['maxDays', 'expiryMonths']);
      c.allowKeys('encashment', ['allowed', 'maxDays']);
      c.bool('paid', 'Paid leave');
      c.num('entitlementDays', 'Yearly entitlement (days)', { min: 0, max: 366, nullable: true });
      c.object('accrual', 'Accrual');
      c.bool('accrual.enabled', 'Monthly accrual');
      c.num('accrual.daysPerMonth', 'Days accrued per month', { min: 0, max: 31 });
      c.oneOf('accrual.postOn', 'Accrual posting day', ['month_start', 'month_end']);
      c.object('proRate', 'Pro-rating');
      c.bool('proRate.joiners', 'Pro-rate for new joiners');
      c.bool('proRate.leavers', 'Pro-rate for leavers');
      c.num('proRate.roundingStep', 'Pro-rate rounding step', { min: 0, max: 1 });
      c.num('probationEntitlementDays', 'Entitlement during probation', { min: 0, max: 366, nullable: true });
      c.bool('allowDuringProbation', 'Allowed during probation');
      c.list('tenureBands', 'Tenure bands', (b) =>
        b && Number.isInteger(b.minMonths) && b.minMonths >= 0 && typeof b.entitlementDays === 'number' && b.entitlementDays >= 0
          ? null : 'each band needs minMonths (whole number) and entitlementDays.');
      c.object('carryForward', 'Carry forward');
      c.num('carryForward.maxDays', 'Max days carried forward', { min: 0, max: 366 });
      c.int('carryForward.expiryMonths', 'Carried-forward days expire after (months)', { min: 1, max: 24, nullable: true });
      c.object('encashment', 'Encashment');
      c.bool('encashment.allowed', 'Encashment allowed');
      c.num('encashment.maxDays', 'Max days encashed', { min: 0, max: 366 });
      c.int('maxConsecutiveDays', 'Max consecutive days', { min: 1, max: 366, nullable: true });
      c.int('minNoticeDays', 'Minimum notice (days)', { min: 0, max: 365 });
      c.int('maxBackdatedDays', 'Can be applied up to N days after the date', { min: 0, max: 365 });
      c.int('medicalCertificateAfterDays', 'Medical certificate required after (days)', { min: 0, max: 366, nullable: true });
      c.bool('allowHalfDay', 'Half-day allowed');
      c.bool('allowHourly', 'Hourly leave allowed');
      c.bool('countWeekends', 'Count weekends inside the leave');
      c.bool('countHolidays', 'Count public holidays inside the leave');
      c.oneOf('insufficientBalance', 'When balance is insufficient', ['reject', 'convert_to_unpaid']);

      const ent = c.get('entitlementDays');
      c.warn(c.get('accrual.enabled') === true && ent == null, 'entitlementDays',
        'Accrual is on but there is no yearly entitlement, so accrual is not capped.');
      c.warn(c.get('paid') === false && typeof ent === 'number' && ent > 0 && c.get('insufficientBalance') === 'convert_to_unpaid', 'insufficientBalance',
        'This leave is already unpaid; converting the excess to unpaid has no effect.');
      const bands = c.get('tenureBands');
      if (Array.isArray(bands)) {
        const months = bands.map((b) => b?.minMonths);
        c.rule(new Set(months).size === months.length, 'tenureBands', 'Two tenure bands start at the same number of months.');
      }
      const cf = c.get('carryForward.maxDays');
      c.warn(typeof cf === 'number' && typeof ent === 'number' && cf > ent, 'carryForward.maxDays',
        `Carry-forward limit (${cf}) is higher than the yearly entitlement (${ent}).`);
    },
  },

  'shift.rules': {
    label: 'Shift timings',
    subjectTable: 'shifts',
    scopes: ['company'],
    validate(c) {
      c.allowKeys('', ['start', 'end', 'graceMinutes', 'halfDayLateMinutes', 'fullDayMinHours', 'halfDayMinHours']);
      c.time('start', 'Shift start');
      c.time('end', 'Shift end');
      c.int('graceMinutes', 'Grace minutes', { min: 0, max: 240 });
      c.int('halfDayLateMinutes', 'Late by this many minutes counts as half day', { min: 0, max: 720 });
      c.num('fullDayMinHours', 'Minimum hours for a full day', { min: 0, max: 24 });
      c.num('halfDayMinHours', 'Minimum hours for a half day', { min: 0, max: 24 });
      const full = c.get('fullDayMinHours');
      const half = c.get('halfDayMinHours');
      c.rule(!(typeof full === 'number' && typeof half === 'number') || half <= full, 'halfDayMinHours',
        'Minimum hours for a half day cannot be more than for a full day.');
    },
  },
};

PAYROLL_DEFINITIONS(registry);

export function getDefinition(key) {
  return registry[key] ?? null;
}

export const listDefinitions = () =>
  Object.entries(registry).map(([key, d]) => ({
    key, label: d.label, scopes: d.scopes, subjectTable: d.subjectTable ?? null, fields: describeFields(d.validate, d.form),
  }));

/**
 * Registers an async check that needs the database (e.g. formula references
 * to other components). Called as check(ctx, { value, merged, version, date })
 * and returns { errors, warnings }.
 */
export function setCheck(key, fn) {
  registry[key].check = fn;
}

/** Paths inside a value that hold ids of other records: { path: lookup entity }. */
export const refsOf = (key) => registry[key]?.form?.refs ?? {};

/**
 * Validates a stored value (partial for overrides) and, when given, the
 * merged effective value. Returns { ok, errors, warnings }.
 */
export function validateSetting(key, { value, scopeType, merged }) {
  const def = getDefinition(key);
  if (!def) return { ok: false, errors: [{ path: '', message: `Unknown setting "${key}".` }], warnings: [] };
  const own = checker(value, { partial: scopeType !== 'company' });
  def.validate(own);
  const result = own.result();
  if (merged !== undefined && scopeType !== 'company') {
    const full = checker(merged);
    def.validate(full);
    const r = full.result();
    const seen = new Set(result.errors.map((e) => e.path + e.message));
    for (const e of r.errors) if (!seen.has(e.path + e.message)) result.errors.push({ ...e, message: `${e.message} (after combining with the inherited rule)` });
    const seenW = new Set(result.warnings.map((w) => w.message));
    for (const w of r.warnings) if (!seenW.has(w.message)) result.warnings.push(w);
    result.ok = result.errors.length === 0;
  }
  return result;
}

function PAYROLL_DEFINITIONS(reg) {
  const functions = payrollFunctions();
  reg['payroll.rules'] = {
    label: 'Payroll rules',
    scopes: ['company', 'department', 'employment_type', 'employee'],
    form: {
      help: {
        ruleDate: "Which day's rules a payroll month uses. A rule published mid-month applies to that month with 'period end', or from the next month with 'period start'.",
        variables: 'Named formulas any component can use, e.g. DAILY_RATE = MONTHLY_SALARY / CALENDAR_DAYS.',
        'overtime.requireApproval': 'Off: overtime is paid straight from attendance.',
      },
    },
    validate(c) {
      c.allowKeys('', ['ruleDate', 'proRateBasis', 'variables', 'overtime', 'approval']);
      c.allowKeys('overtime', ['requireApproval', 'minMinutes']);
      c.allowKeys('approval', ['requireDifferentApprover']);
      c.oneOf('ruleDate', 'Rules used for a payroll month', ['period_start', 'period_end']);
      c.oneOf('proRateBasis', 'Pro-rate joiners and leavers by', ['calendar_days', 'working_days']);
      c.formulaMap('variables', 'Rates and variables', { functions });
      const vars = c.get('variables');
      if (vars && typeof vars === 'object') {
        for (const name of Object.keys(vars)) {
          c.rule(!isReservedName(name), 'variables', `"${name}" is a built-in value; choose another name.`);
        }
      }
      c.object('overtime', 'Overtime');
      c.bool('overtime.requireApproval', 'Pay only approved overtime claims');
      c.int('overtime.minMinutes', 'Ignore overtime below (minutes per day)', { min: 0, max: 600 });
      c.object('approval', 'Approval');
      c.bool('approval.requireDifferentApprover', 'A different HR admin must approve the payroll than the one who prepared it');
    },
  };

  reg['payroll.component'] = {
    label: 'Salary component rules',
    subjectTable: 'salary_components',
    scopes: ALL_SCOPES,
    form: {
      help: {
        calculation: "'structure' takes the amount entered in each employee's salary; 'formula' works it out.",
        formula: "Used when the amount is worked out by formula. Component codes give that component's amount on this payslip.",
        proRate: 'Only for salary-structure amounts: joiners and leavers get the share of the month they were employed.',
      },
    },
    validate(c) {
      c.allowKeys('', ['enabled', 'calculation', 'formula', 'proRate', 'taxable', 'showIfZero']);
      c.bool('enabled', 'Included in payroll');
      c.oneOf('calculation', 'How the amount is worked out', ['structure', 'formula']);
      c.formula('formula', 'Formula', { functions, nullable: true });
      c.bool('proRate', 'Pro-rate for joiners and leavers');
      c.bool('taxable', 'Taxable (earnings only)');
      c.bool('showIfZero', 'Show on the payslip when zero');
      c.rule(!(c.get('calculation') === 'formula' && c.get('formula') == null && c.present('formula')), 'formula',
        'Enter a formula, or choose "structure".');
    },
  };

  reg['payroll.tax'] = {
    label: 'Income tax table',
    scopes: ['company'],
    form: {
      listItems: {
        annualSlabs: [
          { key: 'above', label: 'Annual income above', type: 'num' },
          { key: 'fixed', label: 'Fixed tax', type: 'num' },
          { key: 'rate', label: 'Rate on the excess (%)', type: 'num' },
        ],
      },
      help: { annualSlabs: 'Example values only. Verify them with your accountant and the current Finance Act before running payroll.' },
    },
    validate(c) {
      c.allowKeys('', ['annualSlabs', 'note']);
      c.list('annualSlabs', 'Tax slabs', (s) =>
        s && Object.keys(s).length === 3 && ['above', 'fixed', 'rate'].every((k) => typeof s[k] === 'number' && s[k] >= 0) && s.rate <= 100
          ? null : 'each slab needs "above", "fixed" and "rate" (0 to 100%).');
      c.text('note', 'Source / note', { max: 1000, optional: true });
      const slabs = c.get('annualSlabs');
      if (Array.isArray(slabs)) {
        const above = slabs.map((s) => s?.above);
        c.rule(new Set(above).size === above.length, 'annualSlabs', 'Two slabs start at the same income.');
        c.warn(slabs.length > 0 && !above.includes(0), 'annualSlabs', 'No slab starts at 0, so income below the first slab is not taxed.');
      }
    },
  };
}
