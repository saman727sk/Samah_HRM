/**
 * Consent (location / selfie) and registered devices.
 * Location is only captured at punch time and only after consent; a
 * registered device is always accepted as the non-biometric alternative
 * to a selfie check.
 */
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertCanManage } from './access.js';
import { getEmployee } from './employees.js';

export async function hasConsent(ctx, userId, kind) {
  const row = await ctx.db.one(
    `select granted from consents where tenant_id = $1 and user_id = $2 and kind = $3 order by created_at desc limit 1`,
    [ctx.tenant.id, userId, kind]);
  return row?.granted === true;
}

export async function consentStatus(ctx, userId = ctx.actor.userId) {
  return { location: await hasConsent(ctx, userId, 'location'), selfie: await hasConsent(ctx, userId, 'selfie') };
}

/** Records a consent decision (granting or withdrawing). History is kept. */
export async function recordConsent(ctx, { kind, granted, textVersion }) {
  if (!['location', 'selfie'].includes(kind)) throw badRequest('consent_invalid', 'Consent must be for location or selfie.');
  if (typeof granted !== 'boolean') throw badRequest('consent_invalid', 'Say whether consent is granted (true) or withdrawn (false).');
  const row = await ctx.db.one(
    `insert into consents (tenant_id, user_id, kind, granted, text_version) values ($1, $2, $3, $4, $5) returning *`,
    [ctx.tenant.id, ctx.actor.userId, kind, granted, textVersion ?? null]);
  await audit(ctx.db, ctx, { action: granted ? 'consent.granted' : 'consent.withdrawn', entityType: 'consent', entityId: row.id, newValue: row });
  return row;
}

export async function listDevices(ctx, employeeId) {
  await getEmployee(ctx, employeeId);
  return (await ctx.db.query(`select * from employee_devices where tenant_id = $1 and employee_id = $2 order by created_at desc`,
    [ctx.tenant.id, employeeId])).rows;
}

export async function registerDevice(ctx, { employeeId, deviceId, ip, label }) {
  if (ctx.actor?.employeeId !== employeeId) await assertCanManage(ctx, employeeId);
  if (!deviceId && !ip) throw badRequest('device_invalid', 'Give a device id or a network (IP) address.');
  const row = await ctx.db.one(
    `insert into employee_devices (tenant_id, employee_id, device_id, ip, label, created_by) values ($1, $2, $3, $4, $5, $6) returning *`,
    [ctx.tenant.id, employeeId, deviceId ?? null, ip ?? null, label ?? null, ctx.actor.userId]);
  await audit(ctx.db, ctx, { action: 'device.registered', entityType: 'employee_device', entityId: row.id, newValue: row });
  return row;
}

export async function revokeDevice(ctx, id) {
  const d = await ctx.db.one('select * from employee_devices where id = $1 and tenant_id = $2', [id, ctx.tenant.id]);
  if (!d) throw notFound('Device');
  if (ctx.actor?.employeeId !== d.employee_id) await assertCanManage(ctx, d.employee_id);
  await ctx.db.query(`update employee_devices set status = 'revoked' where id = $1`, [id]);
  await audit(ctx.db, ctx, { action: 'device.revoked', entityType: 'employee_device', entityId: id, oldValue: d });
}

export async function isRegisteredDevice(ctx, employeeId, { deviceId, ip }) {
  if (!deviceId && !ip) return false;
  return !!(await ctx.db.one(
    `select 1 from employee_devices where tenant_id = $1 and employee_id = $2 and status = 'active'
        and ((device_id is not null and device_id = $3) or (ip is not null and ip = $4)) limit 1`,
    [ctx.tenant.id, employeeId, deviceId ?? null, ip ?? null]));
}
