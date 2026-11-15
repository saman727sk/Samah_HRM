-- =====================================================================
-- HR can delete an employee added by mistake (services/employees.js deleteEmployee).
--
-- Only employees with no history (attendance, requests, payroll...) can be deleted; their
-- automatic leave-ledger rows (opening balances, accruals) go with them. leave_ledger stays
-- append-only for everything else: the trigger lets through only deletes of rows belonging to
-- the one employee named in the transaction-local setting hrm.deleting_employee.
-- =====================================================================

create or replace function reject_mutation() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' and deleting_own_company(old.tenant_id) then
    return old;
  end if;
  if TG_OP = 'DELETE' and TG_TABLE_NAME = 'leave_ledger'
     and coalesce(current_setting('hrm.deleting_employee', true), '') = to_jsonb(old) ->> 'employee_id' then
    return old;
  end if;
  raise exception '% is append-only; write a new row instead', TG_TABLE_NAME
    using errcode = 'P0001';
end $$;
