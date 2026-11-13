/**
 * Payslip PDF (A4, pdfkit's built-in Helvetica) on the company's own
 * letterhead (logo, name, address). Rendered on request from the stored
 * payslip, so a locked payslip always prints the same figures.
 * Note: the built-in fonts are Latin-only; Urdu names need an embedded
 * font (e.g. Noto Nastaliq) registered with doc.registerFont.
 */
import PDFDocument from 'pdfkit';

const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const INK = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

/** logo: { mime, buffer } of the company's logo (PNG/JPEG), or null. */
export function renderPayslipPdf(payslip, { logo = null } = {}) {
  const s = payslip.summary;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Payslip ${s.employee.code} ${payslip.period_key}`, Author: payslip.company } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  // Letterhead: the company's own logo, name and contact details (the payslip is the company's document).
  const c = payslip.companyDetails ?? { name: payslip.company };
  const top = 44;
  let textX = left;
  if (logo) {
    try {
      doc.image(logo.buffer, left, top, { fit: [110, 54], valign: 'center' });
      textX = left + 124;
    } catch { /* unreadable image: print the name only */ }
  }
  const textW = width - (textX - left);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(c.name, textX, top + 4, { width: textW });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const line of [c.address, [c.phone, c.email].filter(Boolean).join('  ·  ')].filter(Boolean)) doc.text(line, textX, doc.y + 1, { width: textW });
  const headEnd = Math.max(doc.y, textX > left ? top + 56 : 0) + 10;
  doc.moveTo(left, headEnd).lineTo(left + width, headEnd).strokeColor(RULE).lineWidth(0.7).stroke();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(`Payslip for ${monthName(payslip.period_key)}`, left, headEnd + 10);
  doc.moveDown(0.8);

  // Employee block, two columns.
  const facts = [
    ['Employee', `${s.employee.name} (${s.employee.code})`], ['Department', s.employee.department ?? '—'],
    ['Designation', s.employee.role ?? '—'], ['Joining date', s.employee.joiningDate],
    ['Pay period', `${s.period.start} to ${s.period.end}`], ['Days paid', `${s.inputs.EMPLOYED_DAYS} of ${s.inputs.CALENDAR_DAYS}`],
  ];
  let y = doc.y;
  facts.forEach(([k, v], i) => {
    const x = left + (i % 2) * (width / 2);
    const rowY = y + Math.floor(i / 2) * 16;
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(k, x, rowY, { width: 80 });
    doc.fillColor(INK).text(v, x + 80, rowY, { width: width / 2 - 84 });
  });
  y += Math.ceil(facts.length / 2) * 16 + 12;

  const table = (title, lines, total, x, w) => {
    let ty = y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(title, x, ty);
    ty += 16;
    doc.moveTo(x, ty - 3).lineTo(x + w, ty - 3).strokeColor(RULE).lineWidth(0.7).stroke();
    doc.font('Helvetica').fontSize(9.5);
    for (const l of lines) {
      doc.fillColor(INK).text(l.name, x, ty, { width: w - 90 });
      doc.text(fmt(l.amount), x + w - 90, ty, { width: 90, align: 'right' });
      ty += 15;
    }
    doc.moveTo(x, ty).lineTo(x + w, ty).strokeColor(RULE).stroke();
    doc.font('Helvetica-Bold').text(`Total ${title.toLowerCase()}`, x, ty + 5, { width: w - 90 });
    doc.text(fmt(total), x + w - 90, ty + 5, { width: 90, align: 'right' });
    return ty + 22;
  };
  const shown = (kind) => s.lines.filter((l) => l.kind === kind && !l.hidden);
  const gap = 24;
  const colW = (width - gap) / 2;
  const endA = table('Earnings', shown('earning'), payslip.gross, left, colW);
  const endB = table('Deductions', shown('deduction'), payslip.deductions, left + colW + gap, colW);
  y = Math.max(endA, endB) + 6;

  doc.rect(left, y, width, 34).fillColor('#eef2ff').fill();
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Net pay', left + 12, y + 11);
  doc.text(`${payslip.currency} ${fmt(payslip.net)}`, left, y + 11, { width: width - 12, align: 'right' });
  y += 50;

  const i = s.inputs;
  const att = [['Working days', i.WORKING_DAYS], ['Present', i.PRESENT_DAYS], ['Absent', i.ABSENT_DAYS], ['Half days', i.HALF_DAYS],
    ['Late arrivals', i.LATE_COUNT], ['Paid leave', i.PAID_LEAVE_DAYS], ['Unpaid leave', i.UNPAID_LEAVE_DAYS], ['Overtime (h)', round(i.OT_HOURS + i.OT_OFFDAY_HOURS)]];
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Attendance this month', left, y);
  y += 16;
  att.forEach(([k, v], n) => {
    const x = left + (n % 4) * (width / 4);
    const rowY = y + Math.floor(n / 4) * 28;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, x, rowY);
    doc.fontSize(11).fillColor(INK).text(String(v), x, rowY + 10);
  });
  y += 64;

  const employer = s.lines.filter((l) => l.kind === 'employer' && !l.hidden);
  if (employer.length) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(`Paid by the employer (not deducted from you): ${employer.map((l) => `${l.name} ${fmt(l.amount)}`).join(', ')}.`, left, y, { width });
    y = doc.y + 8;
  }
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`System-generated payslip. Payroll locked ${payslip.locked_at ? new Date(payslip.locked_at).toISOString().slice(0, 10) : '—'}. Reference ${payslip.id}.`, left, y, { width });
  doc.end();
  return done;
}

const round = (n) => Math.round(n * 100) / 100;
