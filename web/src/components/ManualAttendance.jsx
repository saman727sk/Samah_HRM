import { useState } from 'react';
import { get, post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { hm, todayIn } from '../lib/format.js';
import { Button, ErrorBox, Input, Loading, Modal, useLoad } from './ui.jsx';

/**
 * HR (anyone) or a manager (their team) records a check-in and/or
 * check-out for someone who couldn't check in themselves.
 */
export function ManualAttendanceModal({ onClose, onDone, employeeId = '' }) {
  const { t, tz, toast, session } = useApp();
  const today = todayIn(tz);
  const { data: people, error: loadError } = useLoad(() => get('/employees'), []);
  const [f, setF] = useState({ employeeId, workDate: today, checkIn: '09:00', checkOut: '', reason: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  // A manager can't record their own attendance this way.
  const choices = (people ?? []).filter((p) => session.user.accessLevel === 'hr_admin' || p.id !== session.employee?.id);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await post('/attendance/manual', { ...f, checkIn: f.checkIn || null, checkOut: f.checkOut || null });
      const name = choices.find((p) => p.id === f.employeeId)?.full_name ?? '';
      toast(t('ui.manual_saved', 'Attendance recorded for {name} ({worked} worked).', { name, worked: hm(res.day?.workedMinutes ?? 0) }));
      onDone?.();
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal title={t('ui.record_attendance', 'Record attendance')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('ui.cancel', 'Cancel')}</Button>
        <Button kind="primary" disabled={busy || !f.employeeId || !f.reason.trim() || (!f.checkIn && !f.checkOut)} onClick={save}>{t('ui.save', 'Save')}</Button></>}>
      {loadError ? <ErrorBox error={loadError} /> : !people ? <Loading /> : (
        <div className="stack">
          <p className="small muted">{t('ui.manual_help', 'For someone who could not check in themselves. The employee is notified, and the entry is marked "Entered manually" and kept in the audit log.')}</p>
          <Input as="select" label={t('ui.employee', 'Employee')} value={f.employeeId} onChange={set('employeeId')} required>
            <option value="">—</option>
            {choices.map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.employee_code})</option>)}
          </Input>
          <Input label={t('ui.date', 'Date')} type="date" max={today} value={f.workDate} onChange={set('workDate')} required />
          <div className="form-grid">
            <Input label={t('ui.check_in', 'Check-in')} type="time" value={f.checkIn} onChange={set('checkIn')}
              help={t('ui.manual_in_help', 'Leave empty to only close an open check-in.')} />
            <Input label={t('ui.check_out', 'Check-out')} type="time" value={f.checkOut} onChange={set('checkOut')}
              help={t('ui.manual_out_help', 'Earlier than the check-in = next morning.')} />
          </div>
          <Input as="textarea" rows={2} label={t('ui.reason', 'Reason')} value={f.reason} onChange={set('reason')} required maxLength={500}
            placeholder={t('ui.manual_reason_ph', 'e.g. Phone battery died, checked in at reception')} />
          <ErrorBox error={error} />
        </div>
      )}
    </Modal>
  );
}
