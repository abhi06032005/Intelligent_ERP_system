import { Router } from 'express';
import { z } from 'zod';
import * as contracts from '@loomos/shared';
import { authorize } from '../middleware/auth.js';
import { ensure, audit } from '../lib/domain.js';
import { id, write, empty } from '../lib/route-helpers.js';
import { financialReport, buyerPayment, createBill, payBill, createClaim, decideClaim, remindBuyer } from '../services/finance.service.js';

export const financeRouter = Router();

// Financial report breakdown
financeRouter.get('/reports/finance', authorize('finance'), async (req, res) => {
  const month = req.query.month
    ? z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.query.month)
    : undefined;
  res.json(await financialReport(month));
});

// Pay wage entry
write(financeRouter, '/wages/:id/pay', 'finance:manage', empty, async (tx, _input, actor, req) => {
  const wage = await tx.wageEntry.findUnique({ where: { id: id(req) } });
  ensure(wage && !wage.paidAt, 'Wage is missing or already paid.');
  const result = await tx.wageEntry.update({
    where: { id: id(req) },
    data: { paidAt: new Date() },
  });
  await audit(tx, actor, 'finance.wage', wage.id, `${wage.amount} wage paid`);
  return result;
});

// Wage run: pay every unpaid wage up to a date in one go (weekly or monthly payroll).
const wageRunSchema = z.object({ upTo: z.string().date() });
write(financeRouter, '/wages/pay-all', 'finance:manage', wageRunSchema, async (tx, input, actor) => {
  const due = await tx.wageEntry.findMany({ where: { paidAt: null, attendance: { date: { lte: new Date(`${input.upTo}T00:00:00Z`) } } } });
  ensure(due.length, 'There are no unpaid wages up to that date.');
  const now = new Date();
  await tx.wageEntry.updateMany({ where: { id: { in: due.map((w) => w.id) } }, data: { paidAt: now } });
  const total = due.reduce((s, w) => s + w.amount.toNumber(), 0);
  await audit(tx, actor, 'finance.wage', 'wage-run', `Wage run up to ${input.upTo}: ${due.length} entries · ₹${total.toFixed(2)}`);
  return { count: due.length, total };
});

// Record buyer invoice payment
write(financeRouter, '/invoices/:id/payments', 'finance:manage', contracts.paymentSchema, (tx, input, actor, req) =>
  buyerPayment(tx, id(req), input, actor),
);

// Record a payment by picking the invoice, for when the money arrives before anyone opens the invoice list.
write(financeRouter, '/payments', 'finance:manage', contracts.paymentSchema.extend({ invoiceId: z.string().min(1) }), (tx, { invoiceId, ...input }, actor) =>
  buyerPayment(tx, invoiceId, input, actor),
);

// Remind a customer about their outstanding balance
write(financeRouter, '/buyers/:id/remind', 'finance:manage', z.object({ note: z.string().trim().max(500).default('') }), (tx, input, actor, req) =>
  remindBuyer(tx, id(req), input.note, actor),
);

// Bills from suppliers (yarn bills are created by receipts; everything else is entered here)
write(financeRouter, '/bills', 'finance:manage', contracts.billSchema, (tx, input, actor) => createBill(tx, input, actor));

// Record supplier bill payment
write(financeRouter, '/bills/:id/payments', 'finance:manage', contracts.paymentSchema, (tx, input, actor, req) =>
  payBill(tx, id(req), input, actor),
);

// Claims: money owed to or by a buyer or supplier
write(financeRouter, '/claims', 'finance:manage', contracts.claimSchema, (tx, input, actor) => createClaim(tx, input, actor));
write(financeRouter, '/claims/:id/decide', 'finance:manage', contracts.claimDecisionSchema, (tx, input, actor, req) =>
  decideClaim(tx, id(req), input, actor),
);

// Record operating expense
write(financeRouter, '/expenses', 'finance:manage', contracts.expenseSchema, async (tx, input, actor) => {
  const expense = await tx.operatingExpense.create({ data: { ...input, recordedBy: actor.name } });
  await audit(tx, actor, 'finance.expense', expense.id, input.description);
  return expense;
});
