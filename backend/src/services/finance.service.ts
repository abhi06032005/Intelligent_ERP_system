import { db, Prisma, type Tx } from '@loomos/db';
import { factoryToday, type BillInput } from '@loomos/shared';
import { audit, code, D, ensure, sum, type Actor } from '../lib/domain.js';
import { notify } from './notification.service.js';

// Accounts: buyer payments, supplier bills, wages, expenses and claims, and the monthly
// "did we make money?" view. All numbers come from recorded transactions.

const DAY = 86400000;
const IST = 'Asia/Kolkata';

// Money still owed on an invoice after payments and approved claim credits.
const outstandingOf = (i: { total: Prisma.Decimal; adjustment: Prisma.Decimal; payments: { amount: Prisma.Decimal }[] }) =>
  Prisma.Decimal.max(i.total.minus(i.adjustment).minus(sum(i.payments.map((p) => p.amount))), 0);

// Invoices fall due 30 days after dispatch unless a date was set.
const dueOf = (i: { dueAt: Date | null; createdAt: Date }) => i.dueAt ?? new Date(i.createdAt.getTime() + 30 * DAY);

const billOutstanding = (b: { total: Prisma.Decimal; payments: { amount: Prisma.Decimal }[] }) =>
  Prisma.Decimal.max(b.total.minus(sum(b.payments.map((p) => p.amount))), 0);

// "2026-10" → the first instant of that month and of the next one, in factory time.
export function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: new Date(`${month}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`), next };
}

// The factory-time month a moment belongs to, e.g. "2026-10".
const monthFormat = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit' });
const monthOf = (d: Date) => monthFormat.format(d).slice(0, 7);
// Attendance dates are calendar days stored at UTC midnight.
const monthOfDay = (d: Date) => d.toISOString().slice(0, 7);
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${month}-15T00:00:00Z`));

function previousMonths(month: string, count: number) {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export async function buyerPayment(tx: Tx, id: string, input: { amount: number; reference: string }, actor: Actor) {
  const invoice = await tx.invoice.findUnique({ where: { id }, include: { payments: true } });
  ensure(invoice, 'Invoice not found.', 404);
  ensure(invoice.status !== 'VOID', 'A void invoice cannot receive payments.');
  ensure(!(await tx.buyerPayment.findUnique({ where: { reference: input.reference } })), 'A payment with this reference has already been recorded.');

  const due = outstandingOf(invoice);
  ensure(D(input.amount).lte(due), `Payment exceeds the outstanding balance of ₹${due.toFixed(2)}.`);

  const payment = await tx.buyerPayment.create({ data: { invoiceId: id, ...input } });
  await tx.invoice.update({ where: { id }, data: { status: D(input.amount).eq(due) ? 'PAID' : 'PARTIAL' } });
  await audit(tx, actor, 'finance.payment', id, `${D(input.amount).toFixed(2)} received against ${invoice.number}`);
  return payment;
}

// A bill from a supplier: dyes, spares, power, transport... (yarn bills come from receipts).
export async function createBill(tx: Tx, input: BillInput, actor: Actor) {
  const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId } });
  ensure(supplier, 'Supplier not found.', 404);
  ensure(
    !(await tx.supplierBill.findFirst({ where: { supplierId: supplier.id, number: input.number } })),
    `Bill ${input.number} from ${supplier.name} has already been entered.`,
  );
  const billDate = new Date(`${input.billDate}T12:00:00+05:30`);
  const dueAt = input.dueDate ? new Date(`${input.dueDate}T12:00:00+05:30`) : new Date(billDate.getTime() + 30 * DAY);
  ensure(dueAt >= billDate, 'The due date cannot be before the bill date.');
  const bill = await tx.supplierBill.create({
    data: {
      supplierId: supplier.id,
      number: input.number,
      category: input.category,
      description: input.description,
      total: input.amount,
      billDate,
      dueAt,
      recordedBy: actor.name,
    },
  });
  await audit(tx, actor, 'finance.bill', bill.id, `Bill ${input.number} from ${supplier.name} · ₹${input.amount} · ${input.category.toLowerCase().replace(/_/g, ' ')}`);
  return bill;
}

export async function payBill(tx: Tx, id: string, input: { amount: number; reference: string }, actor: Actor) {
  const bill = await tx.supplierBill.findUnique({ where: { id }, include: { payments: true, supplier: true } });
  ensure(bill, 'Bill not found.', 404);
  ensure(!(await tx.supplierPayment.findUnique({ where: { reference: input.reference } })), 'A payment with this reference has already been recorded.');
  const due = billOutstanding(bill);
  ensure(D(input.amount).lte(due), `Payment exceeds the outstanding bill of ₹${due.toFixed(2)}.`);
  const payment = await tx.supplierPayment.create({ data: { billId: bill.id, ...input } });
  await audit(tx, actor, 'finance.supplier_payment', bill.id, `₹${input.amount} paid to ${bill.supplier.name} for bill ${bill.number}`);
  return payment;
}

export async function createClaim(
  tx: Tx,
  input: { party: string; buyerId?: string; supplierId?: string; orderId?: string; invoiceId?: string; amount: number; reason: string },
  actor: Actor,
) {
  if (input.invoiceId) ensure(await tx.invoice.findUnique({ where: { id: input.invoiceId } }), 'Invoice not found.', 404);
  if (input.orderId) ensure(await tx.salesOrder.findUnique({ where: { id: input.orderId } }), 'Order not found.', 404);
  const claim = await tx.claim.create({
    data: {
      number: code('CLM'),
      party: input.party,
      buyerId: input.party === 'BUYER' ? input.buyerId : null,
      supplierId: input.party === 'SUPPLIER' ? input.supplierId : null,
      orderId: input.orderId || null,
      invoiceId: input.invoiceId || null,
      amount: input.amount,
      reason: input.reason,
      createdBy: actor.name,
    },
  });
  await audit(tx, actor, 'finance.claim', claim.id, `${claim.number} · ₹${input.amount} · ${input.reason}`);
  return claim;
}

// Approving a buyer claim against an invoice credits that invoice, so less is owed.
export async function decideClaim(tx: Tx, id: string, input: { decision: string; note: string }, actor: Actor) {
  const claim = await tx.claim.findUnique({ where: { id }, include: { invoice: { include: { payments: true } } } });
  ensure(claim, 'Claim not found.', 404);
  ensure(claim.status === 'PENDING' || (claim.status === 'APPROVED' && input.decision === 'RESOLVED'), 'This claim has already been decided.');

  if (input.decision === 'APPROVED' && claim.status === 'PENDING' && claim.party === 'BUYER' && claim.invoice) {
    const room = outstandingOf(claim.invoice);
    ensure(claim.amount.lte(room.plus(claim.invoice.adjustment)), 'The claim is larger than the invoice balance. Record a refund instead.');
    const updated = await tx.invoice.update({ where: { id: claim.invoice.id }, data: { adjustment: { increment: claim.amount } }, include: { payments: true } });
    if (outstandingOf(updated).lte(0)) await tx.invoice.update({ where: { id: updated.id }, data: { status: 'PAID' } });
  }

  const result = await tx.claim.update({
    where: { id },
    data: { status: input.decision, note: input.note, decidedBy: actor.name, decidedAt: new Date() },
  });
  await audit(tx, actor, `finance.claim.${input.decision.toLowerCase()}`, id, `${claim.number} ${input.decision.toLowerCase()}${input.note ? `: ${input.note}` : ''}`);
  return result;
}

// Each customer's account: everything invoiced to them, what they have paid and what is still owed.
// Balances ignore the month filter, because money owed from an earlier month is still owed.
export async function customerBalances() {
  const now = new Date();
  const [buyers, invoices, reminders] = await Promise.all([
    db.buyer.findMany({ orderBy: { name: 'asc' } }),
    db.invoice.findMany({ where: { status: { not: 'VOID' } }, include: { payments: true, shipment: { select: { order: { select: { buyerId: true } } } } } }),
    db.auditLog.findMany({ where: { action: 'finance.reminder' }, orderBy: { createdAt: 'desc' }, distinct: ['entityId'], select: { entityId: true, createdAt: true } }),
  ]);
  return buyers.map((b) => {
    const mine = invoices.filter((i) => i.shipment.order.buyerId === b.id);
    const open = mine.filter((i) => outstandingOf(i).gt(0));
    const overdue = open.filter((i) => dueOf(i) < now);
    const paymentDates = mine.flatMap((i) => i.payments.map((p) => p.createdAt.getTime()));
    return {
      id: b.id,
      name: b.name,
      city: b.city,
      email: b.email,
      billed: sum(mine.map((i) => i.total)),
      credits: sum(mine.map((i) => i.adjustment)),
      received: sum(mine.flatMap((i) => i.payments.map((p) => p.amount))),
      outstanding: sum(open.map(outstandingOf)),
      overdue: sum(overdue.map(outstandingOf)),
      overdueCount: overdue.length,
      lastPaymentAt: paymentDates.length ? new Date(Math.max(...paymentDates)) : null,
      lastReminderAt: reminders.find((r) => r.entityId === b.id)?.createdAt ?? null,
      invoices: open.map((i) => ({ id: i.id, number: i.number, outstanding: outstandingOf(i), dueAt: dueOf(i), overdue: dueOf(i) < now })),
    };
  });
}

// Tell a customer what they still owe: an in-app notice to their portal users, recorded on the account.
export async function remindBuyer(tx: Tx, buyerId: string, note: string, actor: Actor) {
  const buyer = await tx.buyer.findUnique({ where: { id: buyerId }, include: { users: { where: { active: true, approvalStatus: 'APPROVED' }, select: { id: true } } } });
  ensure(buyer, 'Customer not found.', 404);
  const invoices = await tx.invoice.findMany({ where: { status: { not: 'VOID' }, shipment: { order: { buyerId } } }, include: { payments: true } });
  const owed = invoices.filter((i) => outstandingOf(i).gt(0));
  const total = sum(owed.map(outstandingOf));
  ensure(total.gt(0), `${buyer.name} has nothing outstanding.`);
  const overdue = owed.filter((i) => dueOf(i) < new Date()).length;
  const message = `₹${total.toFixed(2)} is outstanding on ${owed.map((i) => i.number).join(', ')}${overdue ? ` (${overdue} past due)` : ''}.${note ? ` ${note}` : ''}`;
  await notify(tx, { userIds: buyer.users.map((u) => u.id), title: 'Payment reminder', message, category: 'PAYMENT', link: '/buyer' });
  await audit(tx, actor, 'finance.reminder', buyerId, message);
  return { recipients: buyer.users.length, outstanding: total, invoices: owed.length };
}

// Profit and loss for one or more months: sales against raw material bills, other bills,
// wages and expenses. "Spend" is what the month cost the mill; "cash" is what actually moved.
async function monthlyMoney(months: string[]) {
  const from = monthRange(months[0]).from;
  const end = monthRange(months[months.length - 1]).end;
  const inRange = { gte: from, lt: end };
  const [invoices, payments, bills, supplierPayments, wages, expenses] = await Promise.all([
    db.invoice.findMany({ where: { status: { not: 'VOID' }, createdAt: inRange }, select: { total: true, adjustment: true, createdAt: true } }),
    db.buyerPayment.findMany({ where: { createdAt: inRange }, select: { amount: true, createdAt: true } }),
    db.supplierBill.findMany({ where: { billDate: inRange }, select: { total: true, category: true, billDate: true } }),
    db.supplierPayment.findMany({ where: { createdAt: inRange }, select: { amount: true, createdAt: true } }),
    // Attendance dates are calendar days at UTC midnight.
    db.wageEntry.findMany({
      where: { attendance: { date: { gte: new Date(`${months[0]}-01T00:00:00Z`), lt: new Date(`${monthRange(months[months.length - 1]).next}-01T00:00:00Z`) } } },
      select: { amount: true, paidAt: true, attendance: { select: { date: true } } },
    }),
    db.operatingExpense.findMany({ where: { createdAt: inRange }, select: { amount: true, createdAt: true } }),
  ]);

  return months.map((month) => {
    const sales = sum(invoices.filter((i) => monthOf(i.createdAt) === month).map((i) => i.total.minus(i.adjustment)));
    const received = sum(payments.filter((p) => monthOf(p.createdAt) === month).map((p) => p.amount));
    const monthBills = bills.filter((b) => monthOf(b.billDate) === month);
    const yarnBills = sum(monthBills.filter((b) => b.category === 'YARN').map((b) => b.total));
    const otherBills = sum(monthBills.filter((b) => b.category !== 'YARN').map((b) => b.total));
    const wageTotal = sum(wages.filter((w) => monthOfDay(w.attendance.date) === month).map((w) => w.amount));
    const expenseTotal = sum(expenses.filter((e) => monthOf(e.createdAt) === month).map((e) => e.amount));
    const spend = yarnBills.plus(otherBills).plus(wageTotal).plus(expenseTotal);
    const paidOut = sum(supplierPayments.filter((p) => monthOf(p.createdAt) === month).map((p) => p.amount))
      .plus(sum(wages.filter((w) => w.paidAt && monthOf(w.paidAt) === month).map((w) => w.amount)))
      .plus(expenseTotal);
    return {
      month,
      label: monthLabel(month),
      sales: sales.toNumber(),
      received: received.toNumber(),
      yarnBills: yarnBills.toNumber(),
      otherBills: otherBills.toNumber(),
      wages: wageTotal.toNumber(),
      expenses: expenseTotal.toNumber(),
      spend: spend.toNumber(),
      profit: sales.minus(spend).toNumber(),
      cash: received.minus(paidOut).toNumber(),
    };
  });
}

export async function financialReport(month?: string) {
  const range = month ? monthRange(month) : undefined;
  const createdAt = range ? { gte: range.from, lt: range.end } : undefined;
  const now = new Date();
  const pnlMonth = month ?? factoryToday().slice(0, 7);

  const [invoices, payments, costs, expenses, bills, wages, orders, claims, trend, customers] = await Promise.all([
    db.invoice.findMany({ where: { status: { not: 'VOID' }, createdAt }, include: { payments: true, shipment: { include: { order: { include: { buyer: true } } } } }, orderBy: { createdAt: 'desc' } }),
    db.buyerPayment.findMany({ where: { createdAt }, include: { invoice: { include: { shipment: { include: { order: { include: { buyer: true } } } } } } }, orderBy: { createdAt: 'desc' } }),
    db.costAllocation.findMany({ where: { createdAt } }),
    db.operatingExpense.findMany({ where: { createdAt }, orderBy: { createdAt: 'desc' } }),
    db.supplierBill.findMany({ where: range ? { billDate: { gte: range.from, lt: range.end } } : {}, include: { payments: true, supplier: true }, orderBy: { billDate: 'desc' } }),
    db.wageEntry.findMany({
      where: range ? { attendance: { date: { gte: new Date(`${month}-01T00:00:00Z`), lt: new Date(`${range.next}-01T00:00:00Z`) } } } : {},
      include: { worker: true, attendance: { include: { shift: true } } },
      orderBy: { attendance: { date: 'desc' } },
    }),
    db.salesOrder.findMany({ include: { buyer: true, items: true, costs: true, shipments: { include: { invoice: true } } }, orderBy: { createdAt: 'desc' } }),
    db.claim.findMany({ include: { buyer: true, supplier: true, invoice: { select: { number: true } }, order: { select: { number: true } } }, orderBy: { createdAt: 'desc' } }),
    monthlyMoney(previousMonths(pnlMonth, 6)),
    customerBalances(),
  ]);

  const billed = sum(invoices.map((i) => i.total));
  const received = sum(payments.map((p) => p.amount));
  const cost = sum(costs.map((c) => c.amount));
  const overhead = sum(expenses.map((e) => e.amount));
  const openInvoices = invoices.filter((i) => outstandingOf(i).gt(0));
  const overdue = openInvoices.filter((i) => dueOf(i) < now);
  const openBills = bills.filter((b) => billOutstanding(b).gt(0));
  const pnl = trend[trend.length - 1];

  return {
    month: pnlMonth,
    billed,
    received,
    cost,
    expenses: overhead,
    outstanding: sum(openInvoices.map(outstandingOf)),
    overdue: sum(overdue.map(outstandingOf)),
    overdueCount: overdue.length,
    pendingInvoices: openInvoices.length,
    pendingClaims: claims.filter((c) => c.status === 'PENDING').length,
    pendingClaimAmount: sum(claims.filter((c) => c.status === 'PENDING').map((c) => c.amount)),
    billsDue: sum(openBills.map(billOutstanding)),
    billsDueCount: openBills.length,
    billsOverdueCount: openBills.filter((b) => b.dueAt < now).length,
    estimatedProfit: billed.minus(cost).minus(overhead),
    // The selected month (or this month) and the five before it.
    pnl,
    trend,
    spendBreakdown: [
      { key: 'YARN', name: 'Raw material (yarn) bills', value: pnl.yarnBills },
      { key: 'OTHER_BILLS', name: 'Other bills', value: pnl.otherBills },
      { key: 'WAGES', name: 'Worker wages', value: pnl.wages },
      { key: 'EXPENSES', name: 'Other expenses', value: pnl.expenses },
    ],
    customers,
    invoices: invoices.map((i) => ({
      id: i.id, number: i.number, buyer: i.shipment.order.buyer.name, buyerId: i.shipment.order.buyerId, order: i.shipment.order.number, challan: i.shipment.number,
      total: i.total, adjustment: i.adjustment, paid: sum(i.payments.map((p) => p.amount)), outstanding: outstandingOf(i),
      status: i.status, createdAt: i.createdAt, dueAt: dueOf(i), overdue: outstandingOf(i).gt(0) && dueOf(i) < now,
    })),
    payments: payments.map((p) => ({ id: p.id, reference: p.reference, amount: p.amount, createdAt: p.createdAt, invoice: p.invoice.number, buyer: p.invoice.shipment.order.buyer.name, order: p.invoice.shipment.order.number })),
    bills: bills.map((b) => ({
      id: b.id,
      supplier: b.supplier.name,
      supplierId: b.supplierId,
      number: b.number,
      category: b.category,
      description: b.description,
      fromReceipt: Boolean(b.receiptId),
      billDate: b.billDate,
      total: b.total,
      paid: sum(b.payments.map((p) => p.amount)),
      outstanding: billOutstanding(b),
      dueAt: b.dueAt,
      overdue: billOutstanding(b).gt(0) && b.dueAt < now,
    })),
    expenseList: expenses,
    claims: claims.map((c) => ({ id: c.id, number: c.number, party: c.party, who: c.buyer?.name ?? c.supplier?.name ?? '—', order: c.order?.number ?? '', invoice: c.invoice?.number ?? '', amount: c.amount, reason: c.reason, status: c.status, note: c.note, createdAt: c.createdAt, createdBy: c.createdBy })),
    wages: sum(wages.map((w) => w.amount)),
    wagesUnpaid: sum(wages.filter((w) => !w.paidAt).map((w) => w.amount)),
    wageList: wages.map((w) => ({ id: w.id, worker: w.worker.name, shift: w.attendance.shift.name, amount: w.amount, calculation: w.calculation, paidAt: w.paidAt, date: w.attendance.date })),
    costBreakdown: ['MATERIAL', 'LABOUR', 'MACHINE', 'OVERHEAD', 'REWORK'].map((category) => ({ category, amount: sum(costs.filter((c) => c.category === category).map((c) => c.amount)) })),
    orders: orders.map((o) => {
      const invoiced = sum(o.shipments.filter((s) => s.invoice && s.invoice.status !== 'VOID').map((s) => s.invoice!.total));
      const actualCost = sum(o.costs.map((c) => c.amount));
      return {
        id: o.id,
        number: o.number,
        buyer: o.buyer.name,
        status: o.status,
        metres: sum(o.items.map((i) => i.quantity)),
        estimatedRevenue: sum(o.items.map((i) => i.price.mul(i.quantity))),
        billed: invoiced,
        actualCost,
        costPerMetre: sum(o.items.map((i) => i.quantity)).gt(0) ? actualCost.div(sum(o.items.map((i) => i.quantity))).toDecimalPlaces(2) : D(0),
        margin: invoiced.minus(actualCost),
        costs: ['MATERIAL', 'LABOUR', 'MACHINE', 'OVERHEAD', 'REWORK'].map((category) => ({ category, amount: sum(o.costs.filter((c) => c.category === category).map((c) => c.amount)) })),
      };
    }),
  };
}
