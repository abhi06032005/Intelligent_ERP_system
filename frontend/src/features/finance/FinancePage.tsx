import { useState } from 'react';
import { Bar, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Wallet, ArrowDownLeft, AlertCircle, Plus, FileWarning, BadgeIndianRupee, Users, FileText, BellRing, Mail } from 'lucide-react';
import { factoryToday, type MonthMoney } from '@loomos/shared';
import { billForm, billCategoryLabel, expenseForm } from '../forms/quickForms';
import { useData, useLookups, useAction } from '../../hooks/useFactory';
import { Button } from '../../components/ui/button';
import { ActionForm, type FormSpec } from '../../components/shared/ActionForm';
import { FilterBar, useFilters } from '../../components/shared/FilterBar';
import { PageHeader, Panel, Loading, ErrorState, Badge, Kpi, ExportButton, Empty } from '../../components/shared/common';
import { Donut, axis, series, tooltipStyle } from '../../components/shared/Charts';
import { DataTable } from '../../components/tables/DataTable';
import { money, date, exportCsv, label } from '../../lib/utils';

type Money = string;
export interface Finance {
  month: string;
  billed: Money;
  received: Money;
  cost: Money;
  expenses: Money;
  outstanding: Money;
  overdue: Money;
  overdueCount: number;
  pendingInvoices: number;
  pendingClaims: number;
  pendingClaimAmount: Money;
  billsDue: Money;
  billsDueCount: number;
  billsOverdueCount: number;
  wages: Money;
  wagesUnpaid: Money;
  pnl: MonthMoney;
  trend: MonthMoney[];
  spendBreakdown: { key: string; name: string; value: number }[];
  customers: { id: string; name: string; city: string; email: string; billed: Money; credits: Money; received: Money; outstanding: Money; overdue: Money; overdueCount: number; lastPaymentAt: string | null; lastReminderAt: string | null; invoices: { id: string; number: string; outstanding: Money; dueAt: string; overdue: boolean }[] }[];
  invoices: { id: string; number: string; buyer: string; buyerId: string; order: string; challan: string; total: Money; adjustment: Money; paid: Money; outstanding: Money; status: string; createdAt: string; dueAt: string | null; overdue: boolean }[];
  payments: { id: string; reference: string; amount: Money; createdAt: string; invoice: string; buyer: string; order: string }[];
  bills: { id: string; supplier: string; supplierId: string; number: string; category: string; description: string; fromReceipt: boolean; billDate: string; total: Money; paid: Money; outstanding: Money; dueAt: string; overdue: boolean }[];
  expenseList: { id: string; category: string; description: string; amount: Money; recordedBy: string; createdAt: string }[];
  claims: { id: string; number: string; party: string; who: string; order: string; invoice: string; amount: Money; reason: string; status: string; note: string; createdAt: string; createdBy: string }[];
  wageList: { id: string; worker: string; shift: string; amount: Money; calculation: string; paidAt: string | null; date: string }[];
  orders: { id: string; number: string; buyer: string; status: string; metres: Money; estimatedRevenue: Money; billed: Money; actualCost: Money; costPerMetre: Money; margin: Money; costs: { category: string; amount: Money }[] }[];
}

const tabs = ['Invoices', 'Customers', 'Payments', 'Bills to pay', 'Wages', 'Expenses', 'Claims', 'Order costs'];
const short = (v: number) => (Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(1)} L` : money(v));

// The last twelve months, newest first, for the month picker.
function recentMonths() {
  const [y, m] = factoryToday().split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 15));
    return { value: d.toISOString().slice(0, 7), label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d) };
  });
}

export function FinancePage() {
  const [month, setMonth] = useState('');
  const query = useData<Finance>(`/reports/finance${month ? `?month=${month}` : ''}`);
  const lookups = useLookups();
  const action = useAction();
  const filters = useFilters(['buyerId', 'status']);
  const [tab, setTab] = useState('Invoices');
  const [spec, setSpec] = useState<FormSpec | null>(null);

  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorState error={query.error} retry={() => void query.refetch()} />;

  const d = query.data!;
  const p = d.pnl;
  const buyerName = lookups.data?.buyers.find((b) => b.id === filters.values.buyerId)?.name;
  const invoices = d.invoices
    .filter((i) => !filters.values.buyerId || i.buyerId === filters.values.buyerId)
    .filter((i) => !filters.values.status || (filters.values.status === 'OVERDUE' ? i.overdue : filters.values.status === 'OPEN' ? Number(i.outstanding) > 0 : i.status === filters.values.status));
  const payments = d.payments.filter((x) => !buyerName || x.buyer === buyerName);
  const claims = d.claims.filter((c) => !buyerName || c.who === buyerName).filter((c) => !filters.values.status || c.status === filters.values.status);
  const customers = d.customers.filter((c) => !filters.values.buyerId || c.id === filters.values.buyerId);
  const bills = d.bills.filter((b) => !filters.values.status || (filters.values.status === 'OVERDUE' ? b.overdue : filters.values.status === 'OPEN' ? Number(b.outstanding) > 0 : Number(b.outstanding) === 0));

  const paymentForm = (inv: Finance['invoices'][number]): FormSpec => ({
    title: `Record payment · ${inv.number}`,
    description: `${inv.buyer} · outstanding ${money(inv.outstanding)}`,
    path: `/invoices/${inv.id}/payments`,
    fields: [
      { name: 'amount', label: 'Amount received (₹)', type: 'number', min: 0.01, value: Number(inv.outstanding) },
      { name: 'reference', label: 'Bank / cheque reference', hint: 'Must be unique: the same reference cannot be recorded twice.' },
    ],
    submit: 'Record payment',
  });

  // Record money received by picking the invoice. Limited to one customer's invoices when opened from their row.
  const receiveForm = (customer?: Finance['customers'][number]): FormSpec => {
    const open = (customer ? [customer] : d.customers).flatMap((c) => c.invoices.map((i) => ({ value: i.id, label: `${i.number} · ${c.name} · ${money(i.outstanding)} outstanding` })));
    return {
      title: customer ? `Record payment from ${customer.name}` : 'Record a payment received',
      description: customer ? `Outstanding ${money(customer.outstanding)} on ${customer.invoices.length} invoice${customer.invoices.length === 1 ? '' : 's'}.` : 'Money that has arrived from a customer against one of their invoices.',
      path: '/payments',
      fields: [
        { name: 'invoiceId', label: 'Invoice', type: 'select', options: open, span: true },
        { name: 'amount', label: 'Amount received (₹)', type: 'number', min: 0.01 },
        { name: 'reference', label: 'Bank / cheque reference', hint: 'Must be unique: the same reference cannot be recorded twice.' },
      ],
      submit: 'Record payment',
    };
  };

  const remindForm = (c: Finance['customers'][number]): FormSpec => ({
    title: `Remind ${c.name}`,
    description: `Sends a notice to their buyer portal: ${money(c.outstanding)} outstanding on ${c.invoices.map((i) => i.number).join(', ')}${c.overdueCount ? ` (${c.overdueCount} past due)` : ''}.`,
    path: `/buyers/${c.id}/remind`,
    fields: [{ name: 'note', label: 'Add a note', required: false, span: true, hint: 'Optional, e.g. a bank account or a date to pay by.' }],
    submit: 'Send reminder',
  });

  // A ready-to-send email for customers who do not open the portal.
  const reminderMailto = (c: Finance['customers'][number]) => {
    const lines = c.invoices.map((i) => `${i.number}: ${money(i.outstanding)}${i.overdue ? ' (past due)' : ` (due ${date(i.dueAt)})`}`);
    const body = `Dear ${c.name},\n\nA gentle reminder that ${money(c.outstanding)} is outstanding on your account:\n\n${lines.join('\n')}\n\nPlease arrange payment at your earliest convenience.\n\nThank you.`;
    return `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(`Payment reminder · ${money(c.outstanding)} outstanding`)}&body=${encodeURIComponent(body)}`;
  };

  const payBillForm = (b: Finance['bills'][number]): FormSpec => ({
    title: `Pay ${b.supplier} · bill ${b.number}`,
    description: `${billCategoryLabel(b.category)} · still to pay ${money(b.outstanding)}`,
    path: `/bills/${b.id}/payments`,
    fields: [
      { name: 'amount', label: 'Amount paid (₹)', type: 'number', min: 0.01, value: Number(b.outstanding) },
      { name: 'reference', label: 'Bank / cheque reference', hint: 'Must be unique.' },
    ],
    submit: 'Record payment',
  });

  const claimForm: FormSpec = {
    title: 'New claim',
    description: 'A money claim with a buyer or supplier: damage, shortage, price difference.',
    path: '/claims',
    fields: [
      { name: 'party', label: 'Claim with', type: 'select', value: 'BUYER', options: [{ value: 'BUYER', label: 'Buyer (we owe a credit)' }, { value: 'SUPPLIER', label: 'Supplier (they owe us)' }] },
      { name: 'buyerId', label: 'Buyer', type: 'select', required: false, options: (lookups.data?.buyers ?? []).map((b) => ({ value: b.id, label: b.name })) },
      { name: 'supplierId', label: 'Supplier', type: 'select', required: false, options: (lookups.data?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name })) },
      { name: 'invoiceId', label: 'Invoice (buyer claims)', type: 'select', required: false, options: d.invoices.map((i) => ({ value: i.id, label: `${i.number} · ${i.buyer} · ${money(i.total)}` })), hint: 'An approved claim credits this invoice.' },
      { name: 'amount', label: 'Amount (₹)', type: 'number', min: 0.01 },
      { name: 'reason', label: 'Reason', type: 'textarea', span: true },
    ],
    transform: (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')),
    submit: 'Create claim',
  };

  const decideForm = (c: Finance['claims'][number], decision: string): FormSpec => ({
    title: `${label(decision)} · ${c.number}`,
    description: `${c.who} · ${money(c.amount)} · ${c.reason}`,
    path: `/claims/${c.id}/decide`,
    fields: [{ name: 'note', label: 'Note', required: false, span: true }],
    transform: (f) => ({ ...f, decision }),
    submit: label(decision),
  });

  const wageRunForm: FormSpec = {
    title: 'Pay wages',
    description: `Marks every unpaid wage up to the date as paid. Unpaid now: ${money(d.wagesUnpaid)}.`,
    path: '/wages/pay-all',
    fields: [{ name: 'upTo', label: 'Pay everything worked up to', type: 'date', value: factoryToday() }],
    submit: 'Pay wages',
  };

  const statusOptions = tab === 'Claims'
    ? ['PENDING', 'APPROVED', 'REJECTED', 'RESOLVED'].map((s) => ({ value: s, label: label(s) }))
    : [{ value: 'OPEN', label: 'Unpaid' }, { value: 'OVERDUE', label: 'Overdue' }, { value: 'PAID', label: 'Paid' }];

  const exportRows = () =>
    tab === 'Invoices' ? invoices : tab === 'Customers' ? customers.map(({ invoices: open, ...c }) => ({ ...c, openInvoices: open.length })) : tab === 'Payments' ? payments : tab === 'Claims' ? claims : tab === 'Expenses' ? d.expenseList : tab === 'Bills to pay' ? bills : tab === 'Wages' ? d.wageList : d.orders.map(({ costs, ...o }) => ({ ...o, ...Object.fromEntries(costs.map((c) => [c.category.toLowerCase(), c.amount])) }));

  return (
    <>
      <PageHeader eyebrow="ACCOUNTS" title="Accounts" description="Sales, bills, wages and expenses in one place, so you can see whether the mill made money.">
        <label className="date-button">
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            <option value="">All records · this month’s result</option>
            {recentMonths().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <ExportButton onClick={() => exportCsv(`accounts-${tab.toLowerCase().replace(/ /g, '-')}`, exportRows())} />
        <Button variant="outline" onClick={() => setSpec(receiveForm())}><ArrowDownLeft size={16} /> Record payment</Button>
        <Button variant="outline" onClick={() => setSpec(expenseForm())}><Plus size={16} /> Expense</Button>
        <Button onClick={() => setSpec(billForm(lookups.data))}><Plus size={16} /> Add bill</Button>
      </PageHeader>

      <div className="pnl-hero">
        <div className="pnl-card">
          <div className="eyebrow">{p.label.toUpperCase()} · DID WE MAKE MONEY?</div>
          <h2 className={p.profit < 0 ? 'loss' : ''}>{p.profit >= 0 ? 'Profit' : 'Loss'} {money(Math.abs(p.profit))}</h2>
          <p>Sales invoiced minus raw material bills, other bills, wages and expenses.</p>
          <div className="pnl-lines">
            <div><span>Sales invoiced</span><strong>{money(p.sales)}</strong></div>
            <div><span>Raw material bills</span><strong>{money(p.yarnBills)}</strong></div>
            <div><span>Other bills</span><strong>{money(p.otherBills)}</strong></div>
            <div><span>Worker wages</span><strong>{money(p.wages)}</strong></div>
            <div><span>Other expenses</span><strong>{money(p.expenses)}</strong></div>
            <div><span>Cash in from buyers</span><strong>{money(p.received)}</strong></div>
          </div>
        </div>
        <Panel title="Where the money went" subtitle={`${p.label} · ${money(p.spend)} in total`}>
          <Donut
            data={d.spendBreakdown.map((s, i) => ({ name: s.name, value: s.value, color: series[i] }))}
            centre={short(p.spend)}
            caption="spent"
            format={short}
            onSelect={(s) => setTab(s.name.includes('wages') ? 'Wages' : s.name.includes('expenses') ? 'Expenses' : 'Bills to pay')}
          />
        </Panel>
      </div>

      <Panel title="Six months at a glance" subtitle="Sales against spending each month; the line is the profit">
        <div className="chart-box" style={{ height: 260 }}>
          <ResponsiveContainer>
            <ComposedChart data={d.trend} barGap={2} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eceef1" />
              <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} />
              <YAxis tick={axis} axisLine={false} tickLine={false} width={60} tickFormatter={(v) => short(Number(v))} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [money(Number(v)), String(n)]} cursor={{ fill: '#f3f4f6' }} />
              <Legend iconType="square" formatter={(v) => <span style={{ color: '#1f2227' }}>{v}</span>} />
              <Bar dataKey="sales" name="Sales" fill={series[0]} maxBarSize={26} radius={[4, 4, 0, 0]} />
              <Bar dataKey="spend" name="Spent" fill={series[1]} maxBarSize={26} radius={[4, 4, 0, 0]} />
              <Line dataKey="profit" name="Profit" stroke="#111316" strokeWidth={2} dot={{ r: 4, fill: '#111316' }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="kpi-grid mt-5">
        <Kpi label="To collect" value={money(d.outstanding)} icon={<Wallet size={19} />} meta={`${d.pendingInvoices} unpaid invoices · ${money(d.overdue)} overdue`} accent />
        <Kpi label="Bills to pay" value={money(d.billsDue)} icon={<FileText size={19} />} meta={`${d.billsDueCount} open · ${d.billsOverdueCount} past due`} />
        <Kpi label="Wages unpaid" value={money(d.wagesUnpaid)} icon={<Users size={19} />} meta={`${money(d.wages)} wages${month ? ' this month' : ' in total'}`} />
        <Kpi label="Pending claims" value={d.pendingClaims} icon={<FileWarning size={19} />} meta={money(d.pendingClaimAmount)} />
      </div>

      <Panel>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); filters.setValue('status', ''); }}>{t}</button>
          ))}
        </div>
        {['Invoices', 'Customers', 'Payments', 'Claims', 'Bills to pay'].includes(tab) && (
          <FilterBar
            filters={[
              ...(tab === 'Bills to pay' ? [] : [{ name: 'buyerId', label: 'Customer', options: (lookups.data?.buyers ?? []).map((b) => ({ value: b.id, label: b.name })) }]),
              ...(tab === 'Payments' || tab === 'Customers' ? [] : [{ name: 'status', label: 'Status', options: statusOptions }]),
            ]}
            values={filters.values} onChange={filters.setValue} onClear={filters.clear} active={filters.active}
          />
        )}

        {tab === 'Invoices' && (invoices.length ? (
          <DataTable data={invoices} columns={[
            { accessorKey: 'number', header: 'Invoice', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.number}</strong><span>{row.original.order} · DC {row.original.challan}</span></div> },
            { accessorKey: 'buyer', header: 'Buyer' },
            { accessorKey: 'createdAt', header: 'Issued / due', cell: ({ row }) => <div className="cell-stack"><span>{date(row.original.createdAt)}</span><span>{row.original.dueAt ? `due ${date(row.original.dueAt)}` : ''}</span></div> },
            { accessorKey: 'total', header: 'Billed', cell: ({ row }) => money(row.original.total) },
            { accessorKey: 'paid', header: 'Received', cell: ({ row }) => <div className="cell-stack"><span>{money(row.original.paid)}</span>{Number(row.original.adjustment) > 0 && <span>credit {money(row.original.adjustment)}</span>}</div> },
            { accessorKey: 'outstanding', header: 'Outstanding', cell: ({ row }) => <strong>{money(row.original.outstanding)}</strong> },
            { accessorKey: 'status', header: 'Status', cell: ({ row }) => <span className="batch-flags" style={{ marginTop: 0 }}><Badge value={row.original.status} />{row.original.overdue && <Badge value="REJECTED">Overdue</Badge>}</span> },
            { id: 'actions', header: '', cell: ({ row }) => Number(row.original.outstanding) > 0 ? <Button size="sm" onClick={() => setSpec(paymentForm(row.original))}><ArrowDownLeft size={14} /> Record payment</Button> : null },
          ]} />
        ) : <Empty title="No invoices" description="Invoices are raised when a dispatch is confirmed." />)}

        {tab === 'Customers' && (customers.length ? (
          <DataTable data={customers} columns={[
            { accessorKey: 'name', header: 'Customer', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.name}</strong><span>{row.original.city} · {row.original.email}</span></div> },
            { accessorKey: 'billed', header: 'Billed', cell: ({ row }) => money(row.original.billed) },
            { accessorKey: 'received', header: 'Received', cell: ({ row }) => <div className="cell-stack"><span>{money(row.original.received)}</span>{Number(row.original.credits) > 0 && <span>credit {money(row.original.credits)}</span>}</div> },
            { accessorKey: 'outstanding', header: 'Still owed', cell: ({ row }) => <strong>{money(row.original.outstanding)}</strong> },
            { accessorKey: 'overdue', header: 'Overdue', cell: ({ row }) => row.original.overdueCount ? <strong className="red-text">{money(row.original.overdue)} · {row.original.overdueCount}</strong> : <span className="muted">—</span> },
            { accessorKey: 'lastPaymentAt', header: 'Last paid / reminded', cell: ({ row }) => <div className="cell-stack"><span>{row.original.lastPaymentAt ? date(row.original.lastPaymentAt) : 'Never paid'}</span><span>{row.original.lastReminderAt ? `reminded ${date(row.original.lastReminderAt)}` : ''}</span></div> },
            { id: 'actions', header: '', cell: ({ row }) => Number(row.original.outstanding) > 0 ? (
              <div className="record-actions">
                <Button size="sm" onClick={() => setSpec(receiveForm(row.original))}><ArrowDownLeft size={14} /> Record payment</Button>
                <Button size="sm" variant="outline" onClick={() => setSpec(remindForm(row.original))}><BellRing size={14} /> Remind</Button>
                <Button size="sm" variant="outline" asChild><a href={reminderMailto(row.original)}><Mail size={14} /> Email</a></Button>
              </div>
            ) : <Badge value="PAID">Settled</Badge> },
          ]} />
        ) : <Empty title="No customers" />)}

        {tab === 'Payments' && (payments.length ? (
          <DataTable data={payments} columns={[
            { accessorKey: 'createdAt', header: 'Date', cell: ({ row }) => date(row.original.createdAt) },
            { accessorKey: 'buyer', header: 'Buyer' },
            { accessorKey: 'invoice', header: 'Invoice / order', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.invoice}</strong><span>{row.original.order}</span></div> },
            { accessorKey: 'reference', header: 'Reference' },
            { accessorKey: 'amount', header: 'Amount', cell: ({ row }) => <strong>{money(row.original.amount)}</strong> },
          ]} />
        ) : <Empty title="No payments yet" description="Record payments from the Invoices tab." />)}

        {tab === 'Bills to pay' && (bills.length ? (
          <DataTable data={bills} columns={[
            { accessorKey: 'number', header: 'Bill', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.number}</strong><span>{billCategoryLabel(row.original.category)}{row.original.fromReceipt ? ' · from yarn receipt' : ''}</span></div> },
            { accessorKey: 'supplier', header: 'Supplier', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.supplier}</strong><span>{row.original.description}</span></div> },
            { accessorKey: 'billDate', header: 'Date / pay by', cell: ({ row }) => <div className="cell-stack"><span>{date(row.original.billDate)}</span><span>pay by {date(row.original.dueAt)}</span></div> },
            { accessorKey: 'total', header: 'Amount', cell: ({ row }) => money(row.original.total) },
            { accessorKey: 'outstanding', header: 'Still to pay', cell: ({ row }) => <strong>{money(row.original.outstanding)}</strong> },
            { id: 'status', header: 'Status', cell: ({ row }) => Number(row.original.outstanding) === 0 ? <Badge value="PAID" /> : row.original.overdue ? <Badge value="REJECTED">Overdue</Badge> : Number(row.original.paid) > 0 ? <Badge value="PARTIAL">Part paid</Badge> : <Badge value="OPEN">Unpaid</Badge> },
            { id: 'actions', header: '', cell: ({ row }) => Number(row.original.outstanding) > 0 ? <Button size="sm" variant="outline" onClick={() => setSpec(payBillForm(row.original))}>Pay</Button> : null },
          ]} />
        ) : <Empty title="No bills" description="Add a bill with the Add bill button. Yarn bills are created when yarn is received." />)}

        {tab === 'Wages' && (
          <>
            <div className="table-toolbar">
              <span className="muted">{d.wageList.length} wage entries · {money(d.wagesUnpaid)} unpaid</span>
              <Button size="sm" disabled={Number(d.wagesUnpaid) <= 0} onClick={() => setSpec(wageRunForm)}><BadgeIndianRupee size={14} /> Pay wages</Button>
            </div>
            <DataTable data={d.wageList} columns={[
              { accessorKey: 'date', header: 'Day', cell: ({ row }) => <div className="cell-stack"><span>{date(row.original.date)}</span><span>{row.original.shift}</span></div> },
              { accessorKey: 'worker', header: 'Worker' },
              { accessorKey: 'calculation', header: 'Basis' },
              { accessorKey: 'amount', header: 'Amount', cell: ({ row }) => money(row.original.amount) },
              { id: 'paid', header: 'Status', cell: ({ row }) => row.original.paidAt ? <Badge value="PAID">Paid {date(row.original.paidAt)}</Badge> : <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ path: `/wages/${row.original.id}/pay` })}>Pay</Button> },
            ]} />
          </>
        )}

        {tab === 'Expenses' && (d.expenseList.length ? (
          <DataTable data={d.expenseList} columns={[
            { accessorKey: 'createdAt', header: 'Date', cell: ({ row }) => date(row.original.createdAt) },
            { accessorKey: 'category', header: 'Category', cell: ({ row }) => <Badge value="PLANNED">{row.original.category}</Badge> },
            { accessorKey: 'description', header: 'Description' },
            { accessorKey: 'recordedBy', header: 'Recorded by' },
            { accessorKey: 'amount', header: 'Amount', cell: ({ row }) => <strong>{money(row.original.amount)}</strong> },
          ]} />
        ) : <Empty title="No expenses recorded" />)}

        {tab === 'Claims' && (
          <>
            <div className="table-toolbar">
              <span className="muted">Damage, shortage or price differences with buyers and suppliers.</span>
              <Button size="sm" onClick={() => setSpec(claimForm)}><Plus size={14} /> New claim</Button>
            </div>
            {claims.length ? (
              <DataTable data={claims} columns={[
                { accessorKey: 'number', header: 'Claim', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.number}</strong><span>{date(row.original.createdAt)} · {row.original.createdBy}</span></div> },
                { accessorKey: 'who', header: 'With', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.who}</strong><span>{label(row.original.party)}{row.original.invoice ? ` · ${row.original.invoice}` : ''}{row.original.order ? ` · ${row.original.order}` : ''}</span></div> },
                { accessorKey: 'reason', header: 'Reason', cell: ({ row }) => <div className="cell-stack"><span>{row.original.reason}</span>{row.original.note && <span>{row.original.note}</span>}</div> },
                { accessorKey: 'amount', header: 'Amount', cell: ({ row }) => <strong>{money(row.original.amount)}</strong> },
                { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge value={row.original.status === 'APPROVED' ? 'PASSED' : row.original.status}>{label(row.original.status)}</Badge> },
                { id: 'actions', header: '', cell: ({ row }) => (
                  <div className="record-actions">
                    {row.original.status === 'PENDING' && <><Button size="sm" onClick={() => setSpec(decideForm(row.original, 'APPROVED'))}>Approve</Button><Button size="sm" variant="outline" onClick={() => setSpec(decideForm(row.original, 'REJECTED'))}>Reject</Button></>}
                    {row.original.status === 'APPROVED' && <Button size="sm" variant="outline" onClick={() => setSpec(decideForm(row.original, 'RESOLVED'))}>Mark resolved</Button>}
                  </div>
                ) },
              ]} />
            ) : <Empty title="No claims" description="Record a claim when goods are damaged, short, or priced wrongly." />}
          </>
        )}

        {tab === 'Order costs' && (
          <DataTable data={d.orders} columns={[
            { accessorKey: 'number', header: 'Order', cell: ({ row }) => <div className="cell-stack"><strong>{row.original.number}</strong><span>{row.original.buyer} · {label(row.original.status)}</span></div> },
            { accessorKey: 'actualCost', header: 'What it cost', cell: ({ row }) => (
              <div className="cell-stack">
                <strong>{money(row.original.actualCost)}</strong>
                <span>{row.original.costs.filter((c) => Number(c.amount) > 0).map((c) => `${label(c.category)} ${money(c.amount)}`).join(' · ') || 'Nothing made yet'}</span>
              </div>
            ) },
            { accessorKey: 'costPerMetre', header: 'Cost / metre', cell: ({ row }) => `${money(row.original.costPerMetre)} · ${Number(row.original.metres).toLocaleString('en-IN')} m` },
            { accessorKey: 'estimatedRevenue', header: 'Order value', cell: ({ row }) => money(row.original.estimatedRevenue) },
            { accessorKey: 'billed', header: 'Invoiced', cell: ({ row }) => money(row.original.billed) },
            { accessorKey: 'margin', header: 'Margin', cell: ({ row }) => <strong className={Number(row.original.margin) < 0 ? 'red-text' : 'green-text'}>{money(row.original.margin)}</strong> },
          ]} />
        )}
      </Panel>

      <p className="chart-note">
        <AlertCircle size={13} /> {d.overdueCount} invoices overdue. Invoices are due 30 days after dispatch; bills on the pay-by date entered (30 days by default).
      </p>

      {spec && <ActionForm spec={spec} onClose={() => setSpec(null)} />}
    </>
  );
}
