/* eslint-disable react/only-export-components */
import { useEffect, useState } from 'react';
import { get, post, storage } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { fmtTime, hm, WEEKDAYS } from '../lib/format.js';
import { Alert, Button, Card, Flags, Icon, Modal, StatusBadge } from './ui.jsx';

/** A stable id for this browser, used for "registered device" verification. */
export function browserDeviceId() {
  let id = storage.get('hrm.device');
  if (!id) { id = `web-${crypto.randomUUID()}`; storage.set('hrm.device', id); }
  return id;
}

const getPosition = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error('This browser cannot share location.'));
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
    (e) => reject(new Error(e.code === 1 ? 'Location permission was denied. Allow location for this site to check in at the office.' : 'Could not get your location. Try again.')),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});

const CONSENT_TEXT = 'We read your location only at the moment you check in or out, to confirm you are inside the office area. ' +
  'Your location is never tracked in the background, and you can withdraw consent at any time (you will then need to check in another way).';

export function CheckInCard({ today, onDone }) {
  const { t, tz, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [consent, setConsent] = useState(null);
  const [askConsent, setAskConsent] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => { get('/consents').then(setConsent).catch(() => {}); }, []);

  const s = today.summary;
  const officeMethod = today.methods.includes('office_manual') ? 'office_manual' : today.methods.find((m) => m.startsWith('office'));
  const shiftMinutes = s.shift ? (() => { const [a, b] = [s.shift.start, s.shift.end].map((x) => x.split(':').map(Number)); return (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]); })() : 480;
  const worked = s.workedMinutes ?? 0;

  const punch = async (method) => {
    setError(null);
    if (today.nextAction === 'in' && method !== 'wfh' && !consent?.location) { setAskConsent(true); return; }
    setBusy(true);
    try {
      const body = { method, deviceTime: new Date().toISOString(), clientPunchId: crypto.randomUUID(), deviceId: browserDeviceId() };
      if (method !== 'wfh' && today.nextAction === 'in') Object.assign(body, await getPosition());
      const { event } = await post('/attendance/punch', body);
      toast(event.event_type === 'in' ? `${t('ui.checked_in', 'Checked in at')} ${fmtTime(event.punch_time, tz)}` : `${t('ui.checked_out', 'Checked out at')} ${fmtTime(event.punch_time, tz)}`);
      onDone();
    } catch (err) {
      setError(err.reasons?.length ? err.reasons : [err.message]);
    } finally { setBusy(false); }
  };

  const acceptConsent = async () => {
    await post('/consents', { kind: 'location', granted: true, textVersion: 'v1' });
    setConsent((c) => ({ ...c, location: true }));
    setAskConsent(false);
    toast(t('ui.consent_saved', 'Thanks — you can now check in at the office.'));
  };

  return (
    <Card title={t('ui.today', 'Today')} actions={<StatusBadge status={s.status} />}>
      <div className="hero">
        <div>
          <div className="clock">{new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)}</div>
          <div className="muted small">{s.shift ? `${t('ui.shift', 'Shift')} ${s.shift.start}–${s.shift.end}` : ''}</div>
        </div>
        <div className="stack" style={{ flex: 1, minWidth: 220 }}>
          <div className="row between small">
            <span>{today.checkedIn ? `${t('ui.since', 'In since')} ${fmtTime(today.since, tz)}` : s.firstIn ? `${fmtTime(s.firstIn, tz)} – ${fmtTime(s.lastOut, tz)}` : t('ui.not_checked_in', 'Not checked in yet')}</span>
            <span className="num">{hm(worked)} / {hm(shiftMinutes)}</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={shiftMinutes} aria-valuenow={worked}><span style={{ width: `${Math.min(100, (worked / shiftMinutes) * 100)}%` }} /></div>
          <Flags flags={s.flags} />
        </div>
        <div className="row">
          {today.nextAction === 'in' ? (
            <>
              {officeMethod && <Button kind="primary" size="lg" icon="map" disabled={busy || ['holiday', 'weekend', 'on_leave'].includes(s.status)} onClick={() => punch(officeMethod)}>{t('ui.check_in_office', 'Check in')}</Button>}
              {today.methods.includes('wfh') && <Button kind={officeMethod ? undefined : 'primary'} size="lg" icon="home2" disabled={busy} onClick={() => punch('wfh')}>{t('ui.check_in_wfh', 'Check in (WFH)')}</Button>}
            </>
          ) : (
            <Button kind="primary" size="lg" icon="logout" disabled={busy} onClick={() => punch(officeMethod ?? 'wfh')}>{t('ui.check_out', 'Check out')}</Button>
          )}
        </div>
      </div>
      {today.wfhApproved && today.wfhVerification !== 'none' && today.nextAction === 'in' && (
        <p className="small muted">{t('ui.wfh_verify_note', 'WFH check-in is verified with this registered browser/device or a selfie in the mobile app.')}</p>
      )}
      {error && <div style={{ marginTop: 12 }}><Alert kind="bad" items={error} /></div>}
      {askConsent && (
        <Modal title={t('ui.location_consent', 'Location consent')} onClose={() => setAskConsent(false)}
          footer={<><Button onClick={() => setAskConsent(false)}>{t('ui.not_now', 'Not now')}</Button><Button kind="primary" onClick={acceptConsent}>{t('ui.i_agree', 'I agree')}</Button></>}>
          <p>{t('consent.location.text', CONSENT_TEXT)}</p>
        </Modal>
      )}
    </Card>
  );
}

const SHORT = { present: 'Office', wfh: 'WFH', on_leave: 'Leave', absent: 'Absent', holiday: 'Holiday', weekend: '', not_yet: '', not_employed: '' };

/** Month grid (Monday first). Status is shown as a word, not colour alone. */
export function MonthCalendar({ days, today, onPick }) {
  const { t } = useApp();
  if (!days?.length) return null;
  const first = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="cal" role="grid" aria-label="Month attendance">
      {order.map((d) => <div key={d} className="dow" role="columnheader">{WEEKDAYS[d]}</div>)}
      {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} />)}
      {days.map((d) => {
        const label = d.status === 'on_leave' ? (d.leave?.name ?? SHORT.on_leave) : d.status === 'holiday' ? (d.holiday ?? SHORT.holiday) : SHORT[d.status];
        const warn = d.flags?.filter((f) => ['late', 'half_day', 'missed_checkout', 'unverified_time', 'short_hours'].includes(f)).length;
        return (
          <div key={d.date} role="gridcell" className={`day s-${d.status} ${d.date === today ? 'today' : ''}`} title={`${d.date}: ${d.status}${d.flags?.length ? ` (${d.flags.join(', ')})` : ''}`}
            onClick={onPick ? () => onPick(d) : undefined} style={onPick ? { cursor: 'pointer' } : undefined}>
            <span className="d">{Number(d.date.slice(8))}</span>
            {label && <span className="lbl">{t(`cal.${d.status}`, label)}</span>}
            {warn ? <span className="flags"><Icon name="alert" size={10} /> {warn}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
