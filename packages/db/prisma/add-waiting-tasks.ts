import '../../../backend/src/config/env.js';
import { db } from '../src/index.js';
import { D } from '../../../backend/src/lib/domain.js';
import { createOrder, planOrder } from '../../../backend/src/services/order.service.js';
import { reserveYarn } from '../../../backend/src/services/inventory.service.js';
import { assignJob } from '../../../backend/src/services/production.service.js';
import { publish } from '../../../backend/src/lib/events.js';

async function main() {
  console.log('--- Ingesting waiting tasks across Spinning, Weaving, and Dyeing ---');

  const admin = await db.user.findFirstOrThrow({ where: { email: 'owner@loomos.demo' } });
  const actor = {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: 'ADMIN' as const,
    buyerId: null,
    workerId: null,
  };

  const buyers = await db.buyer.findMany();
  const recipes = await db.recipe.findMany({ where: { active: true } });
  const machines = await db.machine.findMany();
  const workers = await db.worker.findMany({ where: { active: true } });

  const machineByCode = Object.fromEntries(machines.map((m) => [m.code, m]));
  const workerByName = Object.fromEntries(workers.map((w) => [w.name, w]));

  const waitingConfigs = [
    // --- SPINNING WAITING TASKS ---
    {
      orderNum: 'SO-2026-1031',
      batchNum: 'WO-2031',
      buyerIndex: 0,
      recipeIndex: 0, // Poplin
      color: 'Mint Sage',
      quantity: 1200,
      stage: 'SPINNING',
      status: 'READY', // Needs machine & operator
      priority: 'HIGH' as const,
      instructions: 'Yarn lot reserved. Waiting for machine and operator assignment.',
    },
    {
      orderNum: 'SO-2026-1032',
      batchNum: 'WO-2032',
      buyerIndex: 1,
      recipeIndex: 1, // Twill
      color: 'Charcoal Black',
      quantity: 900,
      stage: 'SPINNING',
      status: 'ASSIGNED', // Ready to start
      machineCode: 'SP-02',
      workerName: 'Anjali Mehta', // Assigned to Anjali Mehta!
      priority: 'URGENT' as const,
      instructions: 'Spindles pre-calibrated. Operator to start production.',
    },
    {
      orderNum: 'SO-2026-1033',
      batchNum: 'WO-2033',
      buyerIndex: 2,
      recipeIndex: 2, // Linen
      color: 'Bleached White',
      quantity: 800,
      stage: 'SPINNING',
      status: 'READY',
      priority: 'NORMAL' as const,
      instructions: '40 lea linen blend lot ready on staging bay.',
    },
    {
      orderNum: 'SO-2026-1034',
      batchNum: 'WO-2034',
      buyerIndex: 3,
      recipeIndex: 0,
      color: 'Pastel Peach',
      quantity: 1100,
      stage: 'SPINNING',
      status: 'ASSIGNED',
      machineCode: 'SP-01',
      workerName: 'Gurmeet Kaur',
      priority: 'NORMAL' as const,
      instructions: 'Ring frame 01 assigned. Ready to spin.',
    },

    // --- WEAVING WAITING TASKS ---
    {
      orderNum: 'SO-2026-1035',
      batchNum: 'WO-2035',
      buyerIndex: 1,
      recipeIndex: 1,
      color: 'Cobalt Blue',
      quantity: 1300,
      stage: 'WEAVING',
      status: 'READY', // Needs loom & operator
      priority: 'HIGH' as const,
      instructions: 'Spinning output received. Ready for loom beam allocation.',
    },
    {
      orderNum: 'SO-2026-1036',
      batchNum: 'WO-2036',
      buyerIndex: 0,
      recipeIndex: 0,
      color: 'Olive Khaki',
      quantity: 1000,
      stage: 'WEAVING',
      status: 'ASSIGNED', // Ready to start
      machineCode: 'LM-05',
      workerName: 'Rajesh Kumar',
      priority: 'URGENT' as const,
      instructions: 'Electronic jacquard loom loaded. Press Start.',
    },
    {
      orderNum: 'SO-2026-1037',
      batchNum: 'WO-2037',
      buyerIndex: 2,
      recipeIndex: 2,
      color: 'Flax Tan',
      quantity: 850,
      stage: 'WEAVING',
      status: 'READY',
      priority: 'NORMAL' as const,
      instructions: 'Linen warp beam waiting for loom allocation.',
    },
    {
      orderNum: 'SO-2026-1038',
      batchNum: 'WO-2038',
      buyerIndex: 4,
      recipeIndex: 3,
      color: 'Unbleached Greige',
      quantity: 1500,
      stage: 'WEAVING',
      status: 'ASSIGNED',
      machineCode: 'LM-01',
      workerName: 'Imran Ali',
      priority: 'NORMAL' as const,
      instructions: 'Rapier loom 01 assigned and threaded.',
    },

    // --- DYEING WAITING TASKS ---
    {
      orderNum: 'SO-2026-1039',
      batchNum: 'WO-2039',
      buyerIndex: 3,
      recipeIndex: 0,
      color: 'Lavender Dusk',
      quantity: 950,
      stage: 'DYEING',
      status: 'READY', // Needs vessel & operator
      priority: 'HIGH' as const,
      instructions: 'Fabric inspected and desized. Ready for dye recipe.',
    },
    {
      orderNum: 'SO-2026-1040',
      batchNum: 'WO-2040',
      buyerIndex: 0,
      recipeIndex: 1,
      color: 'Emerald Forest',
      quantity: 1100,
      stage: 'DYEING',
      status: 'ASSIGNED', // Ready to start
      machineCode: 'DY-02',
      workerName: 'Priya Sharma',
      priority: 'NORMAL' as const,
      instructions: 'Soft flow vessel 02 liquor ratio confirmed. Ready to run.',
    },
    {
      orderNum: 'SO-2026-1041',
      batchNum: 'WO-2041',
      buyerIndex: 1,
      recipeIndex: 2,
      color: 'Terracotta Rust',
      quantity: 800,
      stage: 'DYEING',
      status: 'READY',
      priority: 'URGENT' as const,
      instructions: 'Waiting for jet dyeing machine availability.',
    },
  ];

  for (const c of waitingConfigs) {
    let order = await db.salesOrder.findUnique({ where: { number: c.orderNum }, include: { items: true } });
    if (!order) {
      order = await db.$transaction(async (tx) => {
        const o = await createOrder(tx, {
          buyerId: buyers[c.buyerIndex % buyers.length].id,
          deadline: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
          priority: c.priority,
          instructions: c.instructions,
          items: [{ recipeId: recipes[c.recipeIndex % recipes.length].id, color: c.color, quantity: c.quantity }],
        }, actor);
        await tx.salesOrder.update({ where: { id: o.id }, data: { number: c.orderNum } });
        await planOrder(tx, o.id, actor);
        return tx.salesOrder.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
      });
    }

    const item = order.items[0];
    const prod = await db.productionOrder.findFirstOrThrow({
      where: { itemId: item.id },
      include: { jobs: { orderBy: { sequence: 'asc' } } },
    });
    await db.productionOrder.update({ where: { id: prod.id }, data: { number: c.batchNum } });

    // Reserve yarn
    const recipe = recipes[c.recipeIndex % recipes.length];
    const lot = await db.yarnLot.findFirst({
      where: { material: recipe.material },
      orderBy: { createdAt: 'desc' },
    });
    if (lot) {
      const needed = D(c.quantity).mul(recipe.kgPerMetre).mul(1.05).toDecimalPlaces(3).toNumber();
      try {
        await db.$transaction(async (tx) => {
          await reserveYarn(tx, { lotId: lot.id, productionId: prod.id, quantity: needed }, actor);
        });
      } catch (e) {
        // already reserved
      }
    }

    const spinningJob = prod.jobs.find((j) => j.stage === 'SPINNING')!;
    const weavingJob = prod.jobs.find((j) => j.stage === 'WEAVING')!;
    const dyeingJob = prod.jobs.find((j) => j.stage === 'DYEING')!;

    if (c.stage === 'SPINNING') {
      if (c.status === 'READY') {
        await db.jobCard.update({
          where: { id: spinningJob.id },
          data: { status: 'READY', machineId: null, workerId: null },
        });
      } else if (c.status === 'ASSIGNED') {
        const m = machineByCode[c.machineCode!];
        const w = workerByName[c.workerName!];
        await db.jobCard.update({
          where: { id: spinningJob.id },
          data: { status: 'ASSIGNED', machineId: m?.id, workerId: w?.id },
        });
      }
    } else if (c.stage === 'WEAVING') {
      // Mark spinning complete
      await db.jobCard.update({
        where: { id: spinningJob.id },
        data: { status: 'COMPLETED', output: c.quantity, endedAt: new Date(Date.now() - 6 * 3600000) },
      });
      if (c.status === 'READY') {
        await db.jobCard.update({
          where: { id: weavingJob.id },
          data: { status: 'READY', machineId: null, workerId: null },
        });
      } else if (c.status === 'ASSIGNED') {
        const m = machineByCode[c.machineCode!];
        const w = workerByName[c.workerName!];
        await db.jobCard.update({
          where: { id: weavingJob.id },
          data: { status: 'ASSIGNED', machineId: m?.id, workerId: w?.id },
        });
      }
    } else if (c.stage === 'DYEING') {
      // Mark spinning & weaving complete
      await db.jobCard.update({
        where: { id: spinningJob.id },
        data: { status: 'COMPLETED', output: c.quantity, endedAt: new Date(Date.now() - 12 * 3600000) },
      });
      await db.jobCard.update({
        where: { id: weavingJob.id },
        data: { status: 'COMPLETED', output: c.quantity, endedAt: new Date(Date.now() - 5 * 3600000) },
      });
      if (c.status === 'READY') {
        await db.jobCard.update({
          where: { id: dyeingJob.id },
          data: { status: 'READY', machineId: null, workerId: null },
        });
      } else if (c.status === 'ASSIGNED') {
        const m = machineByCode[c.machineCode!];
        const w = workerByName[c.workerName!];
        await db.jobCard.update({
          where: { id: dyeingJob.id },
          data: { status: 'ASSIGNED', machineId: m?.id, workerId: w?.id },
        });
      }
    }

    console.log(`Configured waiting task: ${c.batchNum} -> ${c.stage} (${c.status})`);
  }

  // Broadcast live SSE to immediately update frontend
  publish('production');
  publish('orders');

  console.log('--- Successfully ingested 11 waiting tasks across all stages! ---');
}

main().catch(console.error).finally(() => db.$disconnect());
