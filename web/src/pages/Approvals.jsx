import { useState } from 'react';
import { get, post, qs } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { humanize } from '../lib/format.js';
import { PageHead } from '../components/Layout.jsx';
import { Button, Card, Empty, ErrorBox, Input, Loading, Switch, useLoad } from '../components/ui.jsx';
import { useConfirm } from '../components/confirm.jsx';

const KIND_LABEL = { leave: 'Leave', wfh: 'WFH', attendance_correction: 'Correction', overtime: 'Overtime' };

export default function Approvals() {
  const { t, isHr, toast } = useApp();
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useLoad(() => get(`/approvals${qs({ all: all ? 'true' : undefined })}`), [all]);
  const confirm = useConfirm();
  const [comments, setComments] = useState({});
  const [override, setOverride] = useState({});
  const decide = async (item, decision) => {
    if (decision === 'rejected' && !(await confirm({ title: `Reject this ${(KIND_LABEL[item.request.type] ?? 'request').toLowerCase()} request?`, danger: true, confirmLabel: 'Reject',
      message: `The employee is notified${comments[item.task.id] ? ' with your comment' : ''}. A rejected request can't be reopened; they would have to apply again.` }))) return;
    if (decision === 'approved' && override[item.task.id] && !(await confirm({ title: 'Approve with HR override?', confirmLabel: 'Approve all steps',
      message: 'This finishes every remaining approval step at once, skipping the other approvers. It is recorded in the audit log.' }))) return;
    try {
      const r = await post(`/approvals/${item.task.id}/decision`, { decision, comment: comments[item.task.id] || null, override: !!override[item.task.id] });
      toast(r.status === 'pending' ? t('ui.step_done', 'Approved — sent to the next approver.') : `${KIND_LABEL[item.request.type]} ${r.status}.`);
      reload();
    } catch (err) { toast(err.reasons?.[0] ?? err.message, 'bad'); }
  };
  return (
    <div className="stack lg">
      <PageHead title={t('nav.approvals', 'Approvals')} subtitle={t('ui.approvals_sub', 'Requests waiting for your decision.')}
        actions={isHr && <Switch label={t('ui.show_all', 'Show every pending step (HR)')} checked={all} onChange={setAll} />} />
      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} /> : data.length === 0 ? <Card><Empty>{t('ui.inbox_empty', 'Nothing waiting for you. 🎉')}</Empty></Card> : (
        <div className="stack">
          {data.map((item) => (
            <Card key={item.task.id}>
              <div className="row between" style={{ alignItems: 'flex-start' }}>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row"><span className="badge info">{t(`request.${item.request.type}`, KIND_LABEL[item.request.type])}</span>
                    <strong>{item.request.employeeName}</strong>
                    <span className="small muted">{t('ui.step', 'Step')} {item.task.step_no} · {humanize(item.task.approver_kind)}{item.task.escalated_from ? ` · ${t('ui.escalated', 'escalated')}` : ''}</span></div>
                  <div>{item.request.summary}</div>
                  <div className="small muted">{t('ui.received', 'Received')} {new Date(item.task.created_at).toLocaleString()}</div>
                </div>
                <div className="stack" style={{ minWidth: 260 }}>
                  <Input placeholder={t('ui.comment_optional', 'Comment (optional)')} aria-label="Comment" value={comments[item.task.id] ?? ''}
                    onChange={(e) => setComments({ ...comments, [item.task.id]: e.target.value })} />
                  {isHr && <Switch label={t('ui.hr_override', 'HR override (finish all steps)')} checked={override[item.task.id]} onChange={(v) => setOverride({ ...override, [item.task.id]: v })} />}
                  <div className="row">
                    <Button kind="primary" icon="check" onClick={() => decide(item, 'approved')}>{t('ui.approve', 'Approve')}</Button>
                    <Button kind="danger" icon="x" onClick={() => decide(item, 'rejected')}>{t('ui.reject', 'Reject')}</Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
