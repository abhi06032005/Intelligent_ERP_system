import '../../../backend/src/config/env.js';
import { db } from '../src/index.js';
import { D } from '../../../backend/src/lib/domain.js';
import { createOrder, planOrder } from '../../../backend/src/services/order.service.js';
import { reserveYarn } from '../../../backend/src/services/inventory.service.js';
import { assignJob, startJob, recordOutput, pauseJob, completeJob } from '../../../backend/src/services/production.service.js';
import { publish } from '../../../backend/src/lib/events.js';

async function main() {
  console.log('--- Populating floor data in Weaving, Spinning, and Dyeing ---');

  const admin = await db.user.findFirstOrThrow({ where: { email: 'owner@loomos.demo' } });
  const actor = {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: 'ADMIN' as const,
    buyerId: null,
    workerId: null,
  };

  const factory = await db.factory.findFirstOrThrow();
  const depts = Object.fromEntries(
    (await db.department.findMany()).map((d) => [d.code, d.id])
  );

  // 1. Ensure modern industrial machines exist across all 3 stages
  const machineConfigs = [
    // SPINNING
    { code: 'SP-01', name: 'Ring spinning frame 01', type: 'SPINNING', location: 'Spinning hall · Bay 1', capacityPerHour: 150, hourlyCost: 180, status: 'IDLE', dept: 'SPINNING' },
    { code: 'SP-02', name: 'Ring spinning frame 02', type: 'SPINNING', location: 'Spinning hall · Bay 2', capacityPerHour: 150, hourlyCost: 180, status: 'IDLE', dept: 'SPINNING' },
    { code: 'SP-03', name: 'Open-end rotor spinner 03', type: 'SPINNING', location: 'Spinning hall · Bay 3', capacityPerHour: 180, hourlyCost: 210, status: 'IDLE', dept: 'SPINNING' },
    { code: 'SP-04', name: 'Compact spinning frame 04', type: 'SPINNING', location: 'Spinning hall · Bay 4', capacityPerHour: 160, hourlyCost: 195, status: 'IDLE', dept: 'SPINNING' },
    // WEAVING
    { code: 'LM-01', name: 'Rapier loom 01', type: 'WEAVING', location: 'Weaving shed · Bay 1', capacityPerHour: 120, hourlyCost: 200, status: 'IDLE', dept: 'WEAVING' },
    { code: 'LM-02', name: 'Air-jet loom 02', type: 'WEAVING', location: 'Weaving shed · Bay 2', capacityPerHour: 140, hourlyCost: 220, status: 'IDLE', dept: 'WEAVING' },
    { code: 'LM-03', name: 'High-speed Rapier loom 03', type: 'WEAVING', location: 'Weaving shed · Bay 3', capacityPerHour: 135, hourlyCost: 215, status: 'IDLE', dept: 'WEAVING' },
    { code: 'LM-04', name: 'Air-jet loom 04', type: 'WEAVING', location: 'Weaving shed · Bay 4', capacityPerHour: 150, hourlyCost: 230, status: 'IDLE', dept: 'WEAVING' },
    { code: 'LM-05', name: 'Jacquard electronic loom 05', type: 'WEAVING', location: 'Weaving shed · Bay 5', capacityPerHour: 110, hourlyCost: 250, status: 'IDLE', dept: 'WEAVING' },
    { code: 'LM-06', name: 'Sulzer projectile loom 06', type: 'WEAVING', location: 'Weaving shed · Bay 6', capacityPerHour: 145, hourlyCost: 225, status: 'IDLE', dept: 'WEAVING' },
    // DYEING
    { code: 'DY-01', name: 'Jet dyeing machine 01', type: 'DYEING', location: 'Processing hall · Bay 1', capacityPerHour: 100, hourlyCost: 260, status: 'IDLE', dept: 'DYEING' },
    { code: 'DY-02', name: 'Soft flow dyeing machine 02', type: 'DYEING', location: 'Processing hall · Bay 2', capacityPerHour: 110, hourlyCost: 280, status: 'IDLE', dept: 'DYEING' },
    { code: 'DY-03', name: 'Jigger HT dyeing unit 03', type: 'DYEING', location: 'Processing hall · Bay 3', capacityPerHour: 125, hourlyCost: 290, status: 'IDLE', dept: 'DYEING' },
    { code: 'DY-04', name: 'Beam atmospheric vessel 04', type: 'DYEING', location: 'Processing hall · Bay 4', capacityPerHour: 115, hourlyCost: 275, status: 'IDLE', dept: 'DYEING' },
  ];

  const machinesMap: Record<string, any> = {};
  for (const m of machineConfigs) {
    const record = await db.machine.upsert({
      where: { code: m.code },
      update: {
        name: m.name,
        type: m.type,
        location: m.location,
        capacityPerHour: m.capacityPerHour,
        hourlyCost: m.hourlyCost,
        status: m.status,
        departmentId: depts[m.dept],
        factoryId: factory.id,
        active: true,
      },
      create: {
        code: m.code,
        name: m.name,
        type: m.type,
        location: m.location,
        capacityPerHour: m.capacityPerHour,
        hourlyCost: m.hourlyCost,
        status: m.status,
        departmentId: depts[m.dept],
        factoryId: factory.id,
        active: true,
      },
    });
    machinesMap[m.code] = record;
  }
  console.log('Configured 14 machines across Spinning, Weaving, and Dyeing.');

  // Fetch lookups
  const buyers = await db.buyer.findMany();
  const recipes = await db.recipe.findMany({ where: { active: true } });
  const workers = await db.worker.findMany({ where: { active: true } });

  const workerByDept: Record<string, any[]> = {
    SPINNING: workers.filter((w) => w.departmentId === depts['SPINNING']),
    WEAVING: workers.filter((w) => w.departmentId === depts['WEAVING']),
    DYEING: workers.filter((w) => w.departmentId === depts['DYEING']),
  };

  async function createFloorBatch(opts: {
    buyerIndex: number;
    recipeIndex: number;
    color: string;
    quantity: number;
    orderNum: string;
    batchNum: string;
    targetStage: 'SPINNING' | 'WEAVING' | 'DYEING';
    stageStatus: 'IN_PROGRESS' | 'READY' | 'PAUSED';
    machineCode?: string;
    workerId?: string;
    outputQuantity?: number;
    priority?: 'NORMAL' | 'HIGH' | 'URGENT';
    instructions?: string;
  }) {
    let existingOrder = await db.salesOrder.findUnique({ where: { number: opts.orderNum }, include: { items: true } });
    if (!existingOrder) {
      existingOrder = await db.$transaction(async (tx) => {
        const o = await createOrder(tx, {
          buyerId: buyers[opts.buyerIndex % buyers.length].id,
          deadline: new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10),
          priority: opts.priority || 'NORMAL',
          instructions: opts.instructions || 'High uniformity required.',
          items: [{ recipeId: recipes[opts.recipeIndex % recipes.length].id, color: opts.color, quantity: opts.quantity }],
        }, actor);
        await tx.salesOrder.update({ where: { id: o.id }, data: { number: opts.orderNum } });
        await planOrder(tx, o.id, actor);
        return tx.salesOrder.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
      });
    }

    const item = existingOrder.items[0];
    let prod = await db.productionOrder.findFirst({
      where: { itemId: item.id },
      include: { jobs: { orderBy: { sequence: 'asc' } } },
    });
    if (!prod) return;

    await db.productionOrder.update({ where: { id: prod.id }, data: { number: opts.batchNum } });

    const recipe = recipes[opts.recipeIndex % recipes.length];
    const lot = await db.yarnLot.findFirst({
      where: { material: recipe.material },
      orderBy: { createdAt: 'desc' },
    });
    if (lot) {
      const needed = D(opts.quantity).mul(recipe.kgPerMetre).mul(1.05).toDecimalPlaces(3).toNumber();
      try {
        await db.$transaction(async (tx) => {
          await reserveYarn(tx, { lotId: lot.id, productionId: prod.id, quantity: needed }, actor);
        });
      } catch (e) {
        // yarn already reserved
      }
    }

    const jobs = await db.jobCard.findMany({
      where: { productionId: prod.id },
      orderBy: { sequence: 'asc' },
    });

    const spinningJob = jobs.find((j) => j.stage === 'SPINNING')!;
    const weavingJob = jobs.find((j) => j.stage === 'WEAVING')!;
    const dyeingJob = jobs.find((j) => j.stage === 'DYEING')!;

    if (opts.targetStage === 'SPINNING') {
      if (opts.stageStatus === 'IN_PROGRESS' || opts.stageStatus === 'PAUSED') {
        const machine = machinesMap[opts.machineCode || 'SP-03'];
        const worker = opts.workerId || workerByDept['SPINNING'][1]?.id;
        await db.$transaction(async (tx) => {
          await tx.machine.update({ where: { id: machine.id }, data: { status: 'IDLE' } });
          await assignJob(tx, spinningJob.id, { machineId: machine.id, workerId: worker }, actor);
          await startJob(tx, spinningJob.id, actor);
          if (opts.outputQuantity && opts.outputQuantity > 0) {
            await recordOutput(tx, spinningJob.id, {
              quantity: opts.outputQuantity,
              waste: 2.5,
              hours: 4.5,
              lotId: lot?.id,
              consumedKg: D(opts.outputQuantity).mul(recipe.kgPerMetre).toNumber(),
              rollLengths: [],
            }, actor);
          }
          if (opts.stageStatus === 'PAUSED') {
            await pauseJob(tx, spinningJob.id, actor);
          }
        });
      }
    } else if (opts.targetStage === 'WEAVING') {
      // Mark spinning stage as completed directly
      await db.jobCard.update({
        where: { id: spinningJob.id },
        data: {
          status: 'COMPLETED',
          output: opts.quantity,
          startedAt: new Date(Date.now() - 12 * 3600000),
          endedAt: new Date(Date.now() - 4 * 3600000),
        },
      });
      await db.jobCard.update({
        where: { id: weavingJob.id },
        data: { status: 'READY' },
      });

      if (opts.stageStatus === 'IN_PROGRESS' || opts.stageStatus === 'PAUSED') {
        const machine = machinesMap[opts.machineCode || 'LM-03'];
        const worker = opts.workerId || workerByDept['WEAVING'][1]?.id;
        await db.$transaction(async (tx) => {
          await tx.machine.update({ where: { id: machine.id }, data: { status: 'IDLE' } });
          await assignJob(tx, weavingJob.id, { machineId: machine.id, workerId: worker }, actor);
          await startJob(tx, weavingJob.id, actor);
          if (opts.outputQuantity && opts.outputQuantity > 0) {
            await recordOutput(tx, weavingJob.id, {
              quantity: opts.outputQuantity,
              waste: 4.0,
              hours: 5.5,
              consumedKg: 0,
              rollLengths: [],
            }, actor);
          }
          if (opts.stageStatus === 'PAUSED') {
            await pauseJob(tx, weavingJob.id, actor);
          }
        });
      }
    } else if (opts.targetStage === 'DYEING') {
      // Mark spinning and weaving stages as completed directly
      await db.jobCard.update({
        where: { id: spinningJob.id },
        data: {
          status: 'COMPLETED',
          output: opts.quantity,
          startedAt: new Date(Date.now() - 20 * 3600000),
          endedAt: new Date(Date.now() - 12 * 3600000),
        },
      });
      await db.jobCard.update({
        where: { id: weavingJob.id },
        data: {
          status: 'COMPLETED',
          output: opts.quantity,
          startedAt: new Date(Date.now() - 12 * 3600000),
          endedAt: new Date(Date.now() - 3 * 3600000),
        },
      });
      await db.jobCard.update({
        where: { id: dyeingJob.id },
        data: { status: 'READY' },
      });

      if (opts.stageStatus === 'IN_PROGRESS' || opts.stageStatus === 'PAUSED') {
        const machine = machinesMap[opts.machineCode || 'DY-03'];
        const worker = opts.workerId || workerByDept['DYEING'][1]?.id;
        await db.$transaction(async (tx) => {
          await tx.machine.update({ where: { id: machine.id }, data: { status: 'IDLE' } });
          await assignJob(tx, dyeingJob.id, { machineId: machine.id, workerId: worker }, actor);
          await startJob(tx, dyeingJob.id, actor);
          if (opts.outputQuantity && opts.outputQuantity > 0) {
            await recordOutput(tx, dyeingJob.id, {
              quantity: opts.outputQuantity,
              waste: 1.0,
              hours: 4.0,
              consumedKg: 0,
              rollLengths: [],
            }, actor);
          }
          if (opts.stageStatus === 'PAUSED') {
            await pauseJob(tx, dyeingJob.id, actor);
          }
        });
      }
    }

    console.log(`Configured batch ${opts.batchNum} -> ${opts.targetStage} (${opts.stageStatus})`);
  }

  // WEAVING DATA
  console.log('Adding Weaving batches...');
  await createFloorBatch({
    buyerIndex: 0,
    recipeIndex: 1, // Cotton twill
    color: 'Midnight Navy',
    quantity: 1200,
    orderNum: 'SO-2026-1011',
    batchNum: 'WO-2011',
    targetStage: 'WEAVING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'LM-03',
    workerId: workerByDept['WEAVING'][1]?.id, // Imran Ali
    outputQuantity: 780,
    priority: 'HIGH',
    instructions: '3/1 heavy twill construction for workwear jackets.',
  });

  await createFloorBatch({
    buyerIndex: 1,
    recipeIndex: 2, // Linen blend
    color: 'Natural Oatmeal',
    quantity: 900,
    orderNum: 'SO-2026-1012',
    batchNum: 'WO-2012',
    targetStage: 'WEAVING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'LM-04',
    workerId: workerByDept['WEAVING'][2]?.id, // Arun Patel
    outputQuantity: 520,
    priority: 'NORMAL',
    instructions: 'Breathable summer weave with selvedge branding.',
  });

  await createFloorBatch({
    buyerIndex: 2,
    recipeIndex: 0, // Cotton poplin
    color: 'Crimson Red',
    quantity: 1500,
    orderNum: 'SO-2026-1013',
    batchNum: 'WO-2013',
    targetStage: 'WEAVING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'LM-06',
    workerId: workerByDept['WEAVING'][4]?.id, // Vikram Singh
    outputQuantity: 1100,
    priority: 'URGENT',
    instructions: 'High-density 120 GSM poplin for shirting.',
  });

  await createFloorBatch({
    buyerIndex: 3,
    recipeIndex: 3, // Raw cotton fabric
    color: 'Ecru Unbleached',
    quantity: 1400,
    orderNum: 'SO-2026-1014',
    batchNum: 'WO-2014',
    targetStage: 'WEAVING',
    stageStatus: 'READY',
    priority: 'NORMAL',
    instructions: 'Plain weave greige fabric for domestic printing.',
  });

  await createFloorBatch({
    buyerIndex: 4,
    recipeIndex: 1, // Cotton twill
    color: 'Khaki Sand',
    quantity: 1000,
    orderNum: 'SO-2026-1015',
    batchNum: 'WO-2015',
    targetStage: 'WEAVING',
    stageStatus: 'PAUSED',
    machineCode: 'LM-02',
    workerId: workerByDept['WEAVING'][3]?.id, // Sanjay Dutt
    outputQuantity: 320,
    priority: 'NORMAL',
    instructions: 'Paused for warp beam tension alignment check.',
  });

  // SPINNING DATA
  console.log('Adding Spinning batches...');
  await createFloorBatch({
    buyerIndex: 1,
    recipeIndex: 0,
    color: 'Ivory Cream',
    quantity: 1000,
    orderNum: 'SO-2026-1016',
    batchNum: 'WO-2016',
    targetStage: 'SPINNING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'SP-03',
    workerId: workerByDept['SPINNING'][1]?.id, // Gurmeet Kaur
    outputQuantity: 650,
    priority: 'HIGH',
    instructions: '40s combed ring spun yarn with minimal slubs.',
  });

  await createFloorBatch({
    buyerIndex: 2,
    recipeIndex: 2,
    color: 'Raw Slate',
    quantity: 800,
    orderNum: 'SO-2026-1017',
    batchNum: 'WO-2017',
    targetStage: 'SPINNING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'SP-04',
    workerId: workerByDept['SPINNING'][2]?.id, // Farhan Khan
    outputQuantity: 380,
    priority: 'NORMAL',
    instructions: 'Compact spun yarn with high tensile strength.',
  });

  await createFloorBatch({
    buyerIndex: 0,
    recipeIndex: 1,
    color: 'Olive Tint',
    quantity: 1100,
    orderNum: 'SO-2026-1018',
    batchNum: 'WO-2018',
    targetStage: 'SPINNING',
    stageStatus: 'READY',
    priority: 'NORMAL',
    instructions: 'Yarn lot reserved, waiting for operator allocation.',
  });

  // DYEING DATA
  console.log('Adding Dyeing batches...');
  await createFloorBatch({
    buyerIndex: 0,
    recipeIndex: 1,
    color: 'Royal Sapphire',
    quantity: 1100,
    orderNum: 'SO-2026-1019',
    batchNum: 'WO-2019',
    targetStage: 'DYEING',
    stageStatus: 'IN_PROGRESS',
    machineCode: 'DY-03',
    workerId: workerByDept['DYEING'][1]?.id, // Mohan Lal
    outputQuantity: 740,
    priority: 'HIGH',
    instructions: 'Reactive exhaust dyeing with double wash-off cycle.',
  });

  await createFloorBatch({
    buyerIndex: 3,
    recipeIndex: 2,
    color: 'Moss Forest',
    quantity: 850,
    orderNum: 'SO-2026-1020',
    batchNum: 'WO-2020',
    targetStage: 'DYEING',
    stageStatus: 'READY',
    priority: 'NORMAL',
    instructions: 'Woven fabric inspected, waiting for dye bath preparation.',
  });

  await createFloorBatch({
    buyerIndex: 4,
    recipeIndex: 0,
    color: 'Coral Sunset',
    quantity: 750,
    orderNum: 'SO-2026-1021',
    batchNum: 'WO-2021',
    targetStage: 'DYEING',
    stageStatus: 'PAUSED',
    machineCode: 'DY-04',
    workerId: workerByDept['DYEING'][2]?.id, // Lakshmi Iyer
    outputQuantity: 280,
    priority: 'URGENT',
    instructions: 'Paused for lab dip spectrophotometer Delta-E approval.',
  });

  publish('production');
  publish('machines');
  publish('orders');

  console.log('Successfully populated floor data across Weaving, Spinning, and Dyeing!');
}

main().catch(console.error).finally(() => db.$disconnect());
