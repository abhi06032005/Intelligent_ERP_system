import { Router, type Request } from 'express';
import { db, type Prisma } from '@loomos/db';
import * as contracts from '@loomos/shared';
import { authorize } from '../middleware/auth.js';
import { page, id, write, empty, reason } from '../lib/route-helpers.js';
import {
  assignJob,
  handoverJob,
  startJob,
  recordOutput,
  pauseJob,
  completeJob,
  createStandaloneBatch,
  cancelBatch,
  createReplacement,
  listBatches,
  batchDetail,
  batchRef,
} from '../services/production.service.js';
import { raiseRework, cancelRework, listReworks } from '../services/rework.service.js';
import { reportIssue, resolveIssue } from '../services/issue.service.js';

export const productionRouter = Router();

// Read a text filter from the query string ("" and missing both mean "no filter").
const q = (req: Request, name: string) => (req.query[name] ? String(req.query[name]) : undefined);

// Floor job cards. Active & waiting jobs always appear first, followed by recent completed jobs.
productionRouter.get('/', authorize('production'), async (req, res) => {
  const stageParam = q(req, 'stage');
  const stage = stageParam && stageParam !== 'ALL' ? stageParam : undefined;
  const where: Prisma.JobCardWhereInput = {
    status: { not: 'CANCELLED' },
    production: { status: { not: 'CANCELLED' } },
  };
  if (stage) where.stage = stage;
  if (q(req, 'machineId')) where.machineId = q(req, 'machineId');
  if (q(req, 'workerId')) where.workerId = q(req, 'workerId');
  if (q(req, 'buyerId')) where.production = { ...(where.production as object), order: { buyerId: q(req, 'buyerId') } };
  if (q(req, 'orderId')) where.production = { ...(where.production as object), orderId: q(req, 'orderId') };

  const jobInclude = {
    machine: { select: { id: true, name: true, code: true, type: true, status: true } },
    worker: { select: { id: true, name: true } },
    shift: { select: { id: true, name: true } },
    production: {
      include: {
        order: { include: { buyer: true } },
        reservations: { include: { lot: true } },
        jobs: { select: { sequence: true, stage: true, status: true } },
      },
    },
  };

  // Active / waiting jobs first so they are never pushed off page by completed historical jobs
  const [activeJobs, completedJobs] = await Promise.all([
    db.jobCard.findMany({
      where: { ...where, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      include: jobInclude,
      orderBy: [{ sequence: 'asc' }, { id: 'desc' }],
    }),
    db.jobCard.findMany({
      where: { ...where, status: 'COMPLETED' },
      include: jobInclude,
      orderBy: [{ endedAt: 'desc' }, { sequence: 'asc' }],
      take: 100,
    }),
  ]);

  const jobs = [...activeJobs, ...completedJobs];

  res.json(
    page(
      req,
      jobs.map((j) => ({
        ...j,
        production: {
          ...batchRef(j.production),
          status: j.production.status,
          priority: j.production.priority,
          reservations: j.production.reservations,
          jobs: j.production.jobs,
        },
      })),
    ),
  );
});

// ==================== BATCHES ====================

// All batches with combinable filters: customer, order, status, department, machine, operator, dates, purpose, rework.
productionRouter.get('/batches', authorize('production'), async (req, res) => {
  const batches = await listBatches(
    {
      buyerId: q(req, 'buyerId'),
      orderId: q(req, 'orderId'),
      status: q(req, 'status'),
      department: q(req, 'department'),
      machineId: q(req, 'machineId'),
      workerId: q(req, 'workerId'),
      from: q(req, 'from'),
      to: q(req, 'to'),
      purpose: q(req, 'purpose'),
      rework: q(req, 'rework'),
      search: q(req, 'search'),
    },
    req.actor,
  );
  res.json(page(req, batches));
});

productionRouter.get('/batches/:id', authorize('production'), async (req, res) => {
  res.json(await batchDetail(id(req)));
});

// Standalone batch: production without a customer order (stock, internal, replacement, urgent).
write(productionRouter, '/batches', 'production:create', contracts.standaloneBatchSchema, (tx, input, actor) =>
  createStandaloneBatch(tx, input, actor),
);

// Sending work back is a decision for the production manager or the quality inspector.
write(productionRouter, '/batches/:id/rework', ['production:approve', 'quality:manage'], contracts.reworkRequestSchema, (tx, input, actor, req) =>
  raiseRework(tx, id(req), input, actor),
);

// Anyone running the work, or inspecting it, can report a problem.
write(productionRouter, '/batches/:id/issues', ['production:update', 'quality:manage'], contracts.issueSchema, (tx, input, actor, req) =>
  reportIssue(tx, id(req), input, actor),
);

write(productionRouter, '/batches/:id/cancel', 'production:create', reason, (tx, input, actor, req) =>
  cancelBatch(tx, id(req), input.reason, actor),
);

write(productionRouter, '/batches/:id/replacement', 'production:create', contracts.replacementSchema, (tx, input, actor, req) =>
  createReplacement(tx, id(req), input, actor),
);

// ==================== REWORK & ISSUES ====================

productionRouter.get('/reworks', authorize('production'), async (req, res) => {
  const reworks = await listReworks({
    status: q(req, 'status'),
    stage: q(req, 'stage'),
    defectType: q(req, 'defectType'),
    buyerId: q(req, 'buyerId'),
    from: q(req, 'from'),
    to: q(req, 'to'),
  });
  res.json(page(req, reworks));
});

write(productionRouter, '/reworks/:id/cancel', 'production:approve', reason, (tx, input, actor, req) =>
  cancelRework(tx, id(req), input.reason, actor),
);

write(productionRouter, '/issues/:id/resolve', 'production:approve', contracts.resolveIssueSchema, (tx, input, actor, req) =>
  resolveIssue(tx, id(req), input.resolution, actor),
);

// ==================== JOB CARDS ====================

// 1. The production manager or stage operator chooses the machine and operator (also to move stopped work after a breakdown).
write(productionRouter, '/jobs/:id/assign', ['production:approve', 'production:update'], contracts.assignmentSchema, (tx, input, actor, req) =>
  assignJob(tx, id(req), input, actor),
);

// 2. Start production: the assigned operator or the manager. Machine, check-in and yarn are checked first.
write(productionRouter, '/jobs/:id/start', 'production:update', empty, (tx, _input, actor, req) =>
  startJob(tx, id(req), actor),
);

// 3. Record metre output while running.
write(productionRouter, '/jobs/:id/output', 'production:update', contracts.outputSchema, (tx, input, actor, req) =>
  recordOutput(tx, id(req), input, actor),
);

write(productionRouter, '/jobs/:id/pause', 'production:update', empty, (tx, _input, actor, req) =>
  pauseJob(tx, id(req), actor),
);

// 4. Finish the stage (with the final output of this run) and hand it to the next team.
write(productionRouter, '/jobs/:id/complete', 'production:update', contracts.completeSchema, (tx, input, actor, req) =>
  completeJob(tx, id(req), input, actor),
);

// Shift change: the supervisor or operator hands a running job to the incoming operator on the same machine.
write(productionRouter, '/jobs/:id/handover', ['attendance:manage', 'production:approve', 'production:update'], contracts.handoverSchema, (tx, input, actor, req) =>
  handoverJob(tx, id(req), input, actor),
);
