import '../../../backend/src/config/env.js';
import { db, type Tx } from '../src/index.js';
import bcrypt from 'bcryptjs';
import {
  type CurrentUser,
  permissionResources,
  permissionActions,
  ROLE_PERMISSIONS_TEMPLATE,
  standardRoles,
  roleNames,
  roleDuties,
  type Role,
} from '@loomos/shared';
import { createOrder, planOrder } from '../../../backend/src/services/order.service.js';
import { reserveYarn } from '../../../backend/src/services/inventory.service.js';
import { assignJob, startJob, recordOutput, completeJob } from '../../../backend/src/services/production.service.js';
import { shiftState, shiftWindow } from '../../../backend/src/services/workforce.service.js';
import { inspectRoll } from '../../../backend/src/services/quality.service.js';
import { createShipment, verifyRoll, confirmShipment } from '../../../backend/src/services/dispatch.service.js';
import { buyerPayment } from '../../../backend/src/services/finance.service.js';
import { reportBreakdown } from '../../../backend/src/services/machine.service.js';
import { D } from '../../../backend/src/lib/domain.js';
import { seedHistory } from './seed-history.js';

export async function seedRbacAndFacilities(tx: Tx) {
  // 1. Seed Factory
  const factory = await tx.factory.upsert({
    where: { code: 'ETM-01' },
    update: { name: 'Everest Textile Mills · Main Plant', location: 'Ludhiana, Punjab', active: true },
    create: { code: 'ETM-01', name: 'Everest Textile Mills · Main Plant', location: 'Ludhiana, Punjab', active: true },
  });

  // 2. Seed Departments
  const deptDefs = [
    { code: 'SPINNING', name: 'Spinning Department' },
    { code: 'WEAVING', name: 'Weaving Shed' },
    { code: 'DYEING', name: 'Dyeing & Processing' },
    { code: 'QUALITY', name: 'Quality Assurance' },
    { code: 'DISPATCH', name: 'Dispatch & Logistics' },
    { code: 'FINANCE', name: 'Finance & Accounts' },
  ];

  const depts: Record<string, string> = {};
  for (const def of deptDefs) {
    const d = await tx.department.upsert({
      where: { code: def.code },
      update: { name: def.name, factoryId: factory.id, active: true },
      create: { code: def.code, name: def.name, factoryId: factory.id, active: true },
    });
    depts[def.code] = d.id;
  }

  // 3. Seed Permissions
  const permissionIds: Record<string, string> = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const code = `${resource}:${action}`;
      const name = `${action.toUpperCase()} ${resource.toUpperCase()}`;
      const p = await tx.permission.upsert({
        where: { code },
        update: { name, resource, action, description: `Allows user to ${action} ${resource}` },
        create: { code, name, resource, action, description: `Allows user to ${action} ${resource}` },
      });
      permissionIds[code] = p.id;
    }
  }

  // 4. Seed Standard Roles
  const roleDisplayNames: Record<string, string> = roleNames;

  const seededRoles: Record<string, string> = {};
  for (const roleCode of standardRoles) {
    const roleRecord = await tx.role.upsert({
      where: { code: roleCode },
      update: {
        name: roleDisplayNames[roleCode] ?? roleCode,
        description: roleDuties[roleCode as Role] ?? '',
        isSystem: true,
      },
      create: {
        code: roleCode,
        name: roleDisplayNames[roleCode] ?? roleCode,
        description: roleDuties[roleCode as Role] ?? '',
        isSystem: true,
      },
    });
    seededRoles[roleCode] = roleRecord.id;

    // Link template permissions
    const template = ROLE_PERMISSIONS_TEMPLATE[roleCode as Role] ?? [];
    // '*' means every permission (administrators).
    const allowedPerms = template.includes('*') ? Object.keys(permissionIds) : template;
    for (const permCode of allowedPerms) {
      const permId = permissionIds[permCode];
      if (permId) {
        await tx.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: roleRecord.id, permissionId: permId } },
          update: {},
          create: { roleId: roleRecord.id, permissionId: permId },
        });
      }
    }
  }

  return { factory, depts, seededRoles };
}

async function clearDatabase(tx: Tx) {
  const tablenames = await tx.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname='public'
  `;
  const tables = tablenames
    .map(({ tablename }) => tablename)
    .filter((name) => name !== '_prisma_migrations')
    .map((name) => `"${name}"`)
    .join(', ');
  if (tables.length > 0) {
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE;`);
  }
}

async function seed() {
  const password = process.env.DEMO_PASSWORD ?? 'LoomDemo2026!';
  const hash = await bcrypt.hash(password, 12);

  await db.$transaction(async (tx) => {
    await clearDatabase(tx);
    const { factory, depts, seededRoles } = await seedRbacAndFacilities(tx);

    // Buyers & Suppliers
    const buyers = await Promise.all([
      ['Arvind Textiles', 'Ahmedabad', 'AT', 'buyer@loomos.demo'],
      ['Fabindia', 'New Delhi', 'FI', 'buyer2@example.test'],
      ['Raymond Apparel', 'Mumbai', 'RA', 'buyer3@example.test'],
      ['Kaveri Exports', 'Tiruppur', 'KE', 'orders@kaveri.example.test'],
      ['Sutlej Garments', 'Ludhiana', 'SG', 'buying@sutlej.example.test'],
      ['Indigo Threads', 'Jaipur', 'IT', 'purchase@indigo.example.test'],
    ].map(([name, city, initials, email]) =>
      tx.buyer.create({ data: { name, city, initials, email } }),
    ));

    const suppliers = await Promise.all([
      ['Vardhman Yarns', 'Ludhiana'],
      ['Nahar Spinning Mills', 'Coimbatore'],
      ['Trident Fibres', 'Barnala'],
      ['Ludhiana Power Distribution', 'Ludhiana'],
      ['Colourtex Dyes & Chemicals', 'Surat'],
      ['Punjab Loom Spares', 'Amritsar'],
      ['Sutlej Transport Co.', 'Ludhiana'],
    ].map(([name, city], i) =>
      tx.supplier.create({ data: { name, city, email: `supplier${i + 1}@example.test` } }),
    ));

    // Workers linked to departments
    const workers = await Promise.all([
      ['Anjali Mehta', 'Ring frame operator', depts['SPINNING']],
      ['Rajesh Kumar', 'Loom operator', depts['WEAVING']],
      ['Priya Sharma', 'Dyeing specialist', depts['DYEING']],
      ['Sunita Devi', 'Quality inspector', depts['QUALITY']],
      ['Rohan Shah', 'Dispatch coordinator', depts['DISPATCH']],
      ['Sanjay Dutt', 'Floor supervisor', depts['WEAVING']],
      ['Kavita Rao', 'Accounts officer', depts['FINANCE']],
      ['Vikram Singh', 'Production coordinator', depts['WEAVING']],
      ['Mohan Lal', 'Dyeing operator', depts['DYEING']],
      ['Gurmeet Kaur', 'Ring frame operator', depts['SPINNING']],
      ['Farhan Khan', 'Ring frame operator', depts['SPINNING']],
      ['Imran Ali', 'Loom operator', depts['WEAVING']],
      ['Arun Patel', 'Loom operator', depts['WEAVING']],
      ['Lakshmi Iyer', 'Dyeing operator', depts['DYEING']],
      ['Deepa Nair', 'Dyeing operator', depts['DYEING']],
    ].map(([name, designation, departmentId], i) =>
      tx.worker.create({
        data: {
          name,
          designation,
          initials: name.split(' ').map((n) => n[0]).join(''),
          wageType: 'HOURLY',
          rate: 60 + i * 4,
          departmentId,
        },
      }),
    ));

    // Shifts
    const shifts = await Promise.all([
      ['Morning shift', 6],
      ['Evening shift', 14],
      ['Night shift', 22],
    ].map(([name, startHour]) =>
      tx.shift.create({ data: { name: String(name), startHour: Number(startHour), hours: 8 } }),
    ));

    // Demo Users matching exactly the requested roles
    const demoAccountsConfig = [
      { role: 'SUPER_ADMIN', email: 'owner', name: 'Aditya Mehta', dept: undefined, workerId: undefined, buyerId: undefined },
      { role: 'PRODUCTION_MANAGER', email: 'production', name: 'Vikram Singh', dept: depts['WEAVING'], workerId: workers[7].id, buyerId: undefined },
      { role: 'OPERATIONS_MANAGER', email: 'operations', name: 'Meera Joshi', dept: undefined, workerId: undefined, buyerId: undefined },
      { role: 'INVENTORY_MANAGER', email: 'inventory', name: 'Neha Gupta', dept: depts['WEAVING'], workerId: undefined, buyerId: undefined },
      { role: 'PROCUREMENT_MANAGER', email: 'procurement', name: 'Arjun Nair', dept: depts['FINANCE'], workerId: undefined, buyerId: undefined },
      { role: 'SPINNING_OPERATOR', email: 'spinning', name: 'Anjali Mehta', dept: depts['SPINNING'], workerId: workers[0].id, buyerId: undefined },
      { role: 'WEAVING_OPERATOR', email: 'weaving', name: 'Rajesh Kumar', dept: depts['WEAVING'], workerId: workers[1].id, buyerId: undefined },
      { role: 'DYEING_OPERATOR', email: 'dyeing', name: 'Priya Sharma', dept: depts['DYEING'], workerId: workers[2].id, buyerId: undefined },
      { role: 'QUALITY_INSPECTOR', email: 'quality', name: 'Sunita Devi', dept: depts['QUALITY'], workerId: workers[3].id, buyerId: undefined },
      { role: 'DISPATCH_MANAGER', email: 'dispatch', name: 'Rohan Shah', dept: depts['DISPATCH'], workerId: workers[4].id, buyerId: undefined },
      { role: 'SHIFT_SUPERVISOR', email: 'supervisor', name: 'Sanjay Dutt', dept: depts['WEAVING'], workerId: workers[5].id, buyerId: undefined },
      { role: 'MAINTENANCE_ENGINEER', email: 'maintenance', name: 'Deepak Verma', dept: undefined, workerId: undefined, buyerId: undefined },
      { role: 'ACCOUNTS_MANAGER', email: 'accounts', name: 'Kavita Rao', dept: depts['FINANCE'], workerId: workers[6].id, buyerId: undefined },
      { role: 'BUYER', email: 'buyer', name: 'Arvind Textiles', dept: undefined, workerId: undefined, buyerId: buyers[0].id },
      { role: 'BUYER', email: 'fabindia', name: 'Fabindia', dept: undefined, workerId: undefined, buyerId: buyers[1].id },
    ];

    for (const u of demoAccountsConfig) {
      const email = `${u.email}@loomos.demo`;
      const createdUser = await tx.user.upsert({
        where: { email },
        update: {
          name: u.name,
          role: u.role,
          passwordHash: hash,
          factoryId: factory.id,
          departmentId: u.dept ?? null,
          workerId: u.workerId ?? null,
          buyerId: u.buyerId ?? null,
          active: true,
        },
        create: {
          name: u.name,
          email,
          role: u.role,
          passwordHash: hash,
          factoryId: factory.id,
          departmentId: u.dept ?? null,
          workerId: u.workerId ?? null,
          buyerId: u.buyerId ?? null,
          active: true,
        },
      });

      const roleId = seededRoles[u.role];
      if (roleId) {
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: createdUser.id, roleId } },
          update: {},
          create: { userId: createdUser.id, roleId },
        });
      }
    }

    const adminUser = await tx.user.findFirstOrThrow({ where: { email: 'owner@loomos.demo' } });
    const actor: CurrentUser = {
      id: adminUser.id,
      name: adminUser.name,
      email: adminUser.email,
      role: 'ADMIN',
      buyerId: null,
      workerId: null,
    };

    // Standard 3-stage textile recipes: SPINNING -> WEAVING -> DYEING
    const recipes = await Promise.all([
      { name: 'Premium cotton poplin', material: 'Cotton yarn', specification: '40s combed', kgPerMetre: 0.18, wastePercent: 3, route: ['SPINNING', 'WEAVING', 'DYEING'], overheadPerMetre: 8, pricePerMetre: 195 },
      { name: 'Cotton twill', material: 'Cotton yarn', specification: '30s carded', kgPerMetre: 0.24, wastePercent: 4, route: ['SPINNING', 'WEAVING', 'DYEING'], overheadPerMetre: 10, pricePerMetre: 210 },
      { name: 'Linen blend', material: 'Linen blend yarn', specification: '40 lea', kgPerMetre: 0.21, wastePercent: 3, route: ['SPINNING', 'WEAVING', 'DYEING'], overheadPerMetre: 12, pricePerMetre: 240 },
      { name: 'Raw cotton fabric', material: 'Cotton fibre', specification: 'Long staple', kgPerMetre: 0.2, wastePercent: 5, route: ['SPINNING', 'WEAVING', 'DYEING'], overheadPerMetre: 8, pricePerMetre: 160 },
    ].map((data) => tx.recipe.create({ data })));

    // Everyone is checked in on the current shift, so production can start.
    const supervisor = { ...actor, name: 'Sanjay Dutt', role: 'SHIFT_SUPERVISOR' as const };
    const currentShift = shifts.find((sh) => shiftState(sh) === 'CURRENT') ?? shifts[0];
    for (const worker of workers) {
      await tx.attendance.create({
        data: { workerId: worker.id, shiftId: currentShift.id, date: shiftWindow(currentShift).date, hours: 0, status: 'PRESENT', checkInAt: new Date(), recordedBy: supervisor.name },
      });
    }
    // Assign a machine (the first idle one of the right type unless given) and an operator, then start.
    const run = async (jobId: string, workerId: string, machineId?: string) => {
      const job = await tx.jobCard.findUniqueOrThrow({ where: { id: jobId } });
      const machine = machineId ?? (await tx.machine.findFirstOrThrow({ where: { type: job.stage, status: 'IDLE', active: true }, orderBy: { code: 'asc' } })).id;
      await assignJob(tx, jobId, { machineId: machine, workerId }, actor);
      await startJob(tx, jobId, actor);
    };
    // Finish a stage: either the output was already recorded (quantity 0) or the full target is recorded now.
    const finish = (jobId: string, quantity = 0, lotId?: string) =>
      completeJob(tx, jobId, { quantity, hours: quantity ? 4 : 0, waste: 0, lotId, consumedKg: 0, rollLengths: [] }, actor);
    // Operators for the finished demo orders: people who are not busy on a running job.
    const operatorFor: Record<string, string> = { SPINNING: workers[0].id, WEAVING: workers[5].id, DYEING: workers[8].id };

    // Machines for each stage
    const machines = await Promise.all([
      tx.machine.create({ data: { code: 'SP-01', name: 'Ring spinning frame 01', type: 'SPINNING', location: 'Spinning hall · Bay 1', capacityPerHour: 150, hourlyCost: 180, status: 'IDLE', factoryId: factory.id, departmentId: depts['SPINNING'] } }),
      tx.machine.create({ data: { code: 'SP-02', name: 'Ring spinning frame 02', type: 'SPINNING', location: 'Spinning hall · Bay 2', capacityPerHour: 150, hourlyCost: 180, status: 'IDLE', factoryId: factory.id, departmentId: depts['SPINNING'] } }),
      tx.machine.create({ data: { code: 'SP-03', name: 'Open-end rotor spinner 03', type: 'SPINNING', location: 'Spinning hall · Bay 3', capacityPerHour: 180, hourlyCost: 210, status: 'IDLE', factoryId: factory.id, departmentId: depts['SPINNING'] } }),
      tx.machine.create({ data: { code: 'SP-04', name: 'Compact spinning frame 04', type: 'SPINNING', location: 'Spinning hall · Bay 4', capacityPerHour: 160, hourlyCost: 195, status: 'IDLE', factoryId: factory.id, departmentId: depts['SPINNING'] } }),
      tx.machine.create({ data: { code: 'LM-01', name: 'Rapier loom 01', type: 'WEAVING', location: 'Weaving shed · Bay 1', capacityPerHour: 120, hourlyCost: 200, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'LM-02', name: 'Air-jet loom 02', type: 'WEAVING', location: 'Weaving shed · Bay 2', capacityPerHour: 140, hourlyCost: 220, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'LM-03', name: 'High-speed Rapier loom 03', type: 'WEAVING', location: 'Weaving shed · Bay 3', capacityPerHour: 135, hourlyCost: 215, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'LM-04', name: 'Air-jet loom 04', type: 'WEAVING', location: 'Weaving shed · Bay 4', capacityPerHour: 150, hourlyCost: 230, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'LM-05', name: 'Jacquard electronic loom 05', type: 'WEAVING', location: 'Weaving shed · Bay 5', capacityPerHour: 110, hourlyCost: 250, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'LM-06', name: 'Sulzer projectile loom 06', type: 'WEAVING', location: 'Weaving shed · Bay 6', capacityPerHour: 145, hourlyCost: 225, status: 'IDLE', factoryId: factory.id, departmentId: depts['WEAVING'] } }),
      tx.machine.create({ data: { code: 'DY-01', name: 'Jet dyeing machine 01', type: 'DYEING', location: 'Processing hall · Bay 1', capacityPerHour: 100, hourlyCost: 260, status: 'IDLE', factoryId: factory.id, departmentId: depts['DYEING'] } }),
      tx.machine.create({ data: { code: 'DY-02', name: 'Soft flow dyeing machine 02', type: 'DYEING', location: 'Processing hall · Bay 2', capacityPerHour: 110, hourlyCost: 280, status: 'IDLE', factoryId: factory.id, departmentId: depts['DYEING'] } }),
      tx.machine.create({ data: { code: 'DY-03', name: 'Jigger HT dyeing unit 03', type: 'DYEING', location: 'Processing hall · Bay 3', capacityPerHour: 125, hourlyCost: 290, status: 'IDLE', factoryId: factory.id, departmentId: depts['DYEING'] } }),
      tx.machine.create({ data: { code: 'DY-04', name: 'Beam atmospheric vessel 04', type: 'DYEING', location: 'Processing hall · Bay 4', capacityPerHour: 115, hourlyCost: 275, status: 'IDLE', factoryId: factory.id, departmentId: depts['DYEING'] } }),
    ]);

    // ---------- Five months of history (orders, receipts, bills, wages, breakdowns) ----------
    const asUser = async (email: string): Promise<CurrentUser> => {
      const u = await tx.user.findFirstOrThrow({ where: { email: `${email}@loomos.demo` } });
      return { id: u.id, name: u.name, email: u.email, role: u.role as Role, buyerId: null, workerId: u.workerId };
    };
    await seedHistory(tx, {
      actor,
      people: {
        ops: await asUser('operations'),
        production: await asUser('production'),
        inspector: await asUser('quality'),
        dispatcher: await asUser('dispatch'),
        accounts: await asUser('accounts'),
        store: await asUser('inventory'),
        supervisor: await asUser('supervisor'),
        maintenance: await asUser('maintenance'),
      },
      buyers,
      yarnSuppliers: suppliers.slice(0, 3),
      serviceSuppliers: { POWER: suppliers[3], DYES_CHEMICALS: suppliers[4], SPARES: suppliers[5], TRANSPORT: suppliers[6] },
      recipes,
      workers,
      crews: { SPINNING: [0, 9, 10], WEAVING: [1, 11, 12], DYEING: [2, 13, 14, 8] },
      dayStaff: [3, 4, 5, 6, 7],
      machines,
      shifts,
      currentShiftDate: shiftWindow(currentShift).date,
    });
    // Today's orders use this month's yarn (the newest lot of each material).
    const lots = await Promise.all(recipes.map((r) => tx.yarnLot.findFirstOrThrow({ where: { material: r.material, specification: r.specification }, orderBy: { createdAt: 'desc' } })));

    // TODAY ON THE FLOOR:
    // -------------------------------------------------------------
    // Order 1: WO-2001 (1,200 m) -> Currently in SPINNING (In progress)
    // Order 2: WO-2002 (1,000 m) -> Spinning completed -> Currently in WEAVING (In progress)
    // Order 3: WO-2003 (800 m)  -> Spinning & Weaving completed -> Currently in DYEING (In progress)
    // -------------------------------------------------------------

    // ORDER 1 (SPINNING IN PROGRESS)
    const order1 = await createOrder(tx, {
      buyerId: buyers[0].id,
      deadline: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      priority: 'HIGH',
      instructions: 'Export grade quality. Consistent twist and tension.',
      items: [{ recipeId: recipes[0].id, color: 'Sage green', quantity: 1200 }],
    }, actor);
    await tx.salesOrder.update({ where: { id: order1.id }, data: { number: 'SO-2026-1001' } });
    await planOrder(tx, order1.id, actor);
    const prod1 = await tx.productionOrder.findUniqueOrThrow({ where: { itemId: order1.items[0].id }, include: { jobs: { orderBy: { sequence: 'asc' } } } });
    await tx.productionOrder.update({ where: { id: prod1.id }, data: { number: 'WO-2001' } });
    const req1 = D(1200).mul(recipes[0].kgPerMetre).mul(D(1).plus(D(recipes[0].wastePercent).div(100))).toDecimalPlaces(3).toNumber();
    await reserveYarn(tx, { lotId: lots[0].id, productionId: prod1.id, quantity: req1 }, actor);

    // ORDER 2 (WEAVING IN PROGRESS)
    const order2 = await createOrder(tx, {
      buyerId: buyers[1].id,
      deadline: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      priority: 'NORMAL',
      instructions: 'Smooth twill diagonal finish. Pre-shrunk.',
      items: [{ recipeId: recipes[1].id, color: 'Indigo blue', quantity: 1000 }],
    }, actor);
    await tx.salesOrder.update({ where: { id: order2.id }, data: { number: 'SO-2026-1002' } });
    await planOrder(tx, order2.id, actor);
    const prod2 = await tx.productionOrder.findUniqueOrThrow({ where: { itemId: order2.items[0].id }, include: { jobs: { orderBy: { sequence: 'asc' } } } });
    await tx.productionOrder.update({ where: { id: prod2.id }, data: { number: 'WO-2002' } });
    const req2 = D(1000).mul(recipes[1].kgPerMetre).mul(D(1).plus(D(recipes[1].wastePercent).div(100))).toDecimalPlaces(3).toNumber();
    await reserveYarn(tx, { lotId: lots[1].id, productionId: prod2.id, quantity: req2 }, actor);
    // Complete Stage 0 (SPINNING)
    await run(prod2.jobs[0].id, workers[0].id, machines[1].id);
    await recordOutput(tx, prod2.jobs[0].id, { quantity: 1000, waste: 0, hours: 6.5, lotId: lots[1].id, consumedKg: D(1000).mul(recipes[1].kgPerMetre).toNumber(), rollLengths: [] }, actor);
    await finish(prod2.jobs[0].id);
    // Start Stage 1 (WEAVING)
    await run(prod2.jobs[1].id, workers[1].id, machines[2].id);

    // ORDER 3 (DYEING IN PROGRESS)
    const order3 = await createOrder(tx, {
      buyerId: buyers[2].id,
      deadline: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
      priority: 'URGENT',
      instructions: 'Eco-reactive dye with fastness grade 4.5.',
      items: [{ recipeId: recipes[2].id, color: 'Warm ivory', quantity: 800 }],
    }, actor);
    await tx.salesOrder.update({ where: { id: order3.id }, data: { number: 'SO-2026-1003' } });
    await planOrder(tx, order3.id, actor);
    const prod3 = await tx.productionOrder.findUniqueOrThrow({ where: { itemId: order3.items[0].id }, include: { jobs: { orderBy: { sequence: 'asc' } } } });
    await tx.productionOrder.update({ where: { id: prod3.id }, data: { number: 'WO-2003' } });
    const req3 = D(800).mul(recipes[2].kgPerMetre).mul(D(1).plus(D(recipes[2].wastePercent).div(100))).toDecimalPlaces(3).toNumber();
    await reserveYarn(tx, { lotId: lots[2].id, productionId: prod3.id, quantity: req3 }, actor);
    // Complete Stage 0 (SPINNING)
    await run(prod3.jobs[0].id, workers[0].id, machines[1].id);
    await recordOutput(tx, prod3.jobs[0].id, { quantity: 800, waste: 0, hours: 5.5, lotId: lots[2].id, consumedKg: D(800).mul(recipes[2].kgPerMetre).toNumber(), rollLengths: [] }, actor);
    await finish(prod3.jobs[0].id);
    // Complete Stage 1 (WEAVING)
    await run(prod3.jobs[1].id, workers[5].id, machines[3].id);
    await recordOutput(tx, prod3.jobs[1].id, { quantity: 800, waste: 0, hours: 6, consumedKg: 0, rollLengths: [] }, actor);
    await finish(prod3.jobs[1].id);
    // Start Stage 2 (DYEING)
    await run(prod3.jobs[2].id, workers[2].id, machines[4].id);

    // Orders 4-6 run the real workflow end to end so quality, dispatch and
    // finance screens have genuine records. Order 7 is a buyer request awaiting review.
    const finishOrder = async (buyerIndex: number, recipeIndex: number, color: string, quantity: number, days: number, number: string) => {
      const order = await createOrder(tx, {
        buyerId: buyers[buyerIndex].id,
        deadline: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
        priority: 'NORMAL',
        instructions: '',
        items: [{ recipeId: recipes[recipeIndex].id, color, quantity }],
      }, actor);
      await tx.salesOrder.update({ where: { id: order.id }, data: { number } });
      await planOrder(tx, order.id, actor);
      const prod = await tx.productionOrder.findUniqueOrThrow({ where: { itemId: order.items[0].id }, include: { jobs: { orderBy: { sequence: 'asc' } } } });
      for (const job of prod.jobs) {
        await run(job.id, operatorFor[job.stage]);
        await finish(job.id, quantity);
      }
      return { order, rolls: await tx.fabricRoll.findMany({ where: { productionId: prod.id }, orderBy: { code: 'asc' } }) };
    };
    const inspector = { ...actor, name: 'Sunita Devi', role: 'QUALITY_INSPECTOR' as const };
    const dispatcher = { ...actor, name: 'Rohan Shah', role: 'DISPATCH_MANAGER' as const };

    // ORDER 4: delivered, invoiced and partly paid
    const o4 = await finishOrder(0, 1, 'Charcoal grey', 600, 2, 'SO-2026-0998');
    for (const roll of o4.rolls) await inspectRoll(tx, roll.id, { result: 'PASSED', defects: [], notes: 'Clean roll' }, inspector);
    const s4 = await createShipment(tx, { orderId: o4.order.id, rollIds: o4.rolls.map((r) => r.id), transport: 'PB-10-GT-4521', driverName: 'Gurpreet Singh', driverPhone: '+91 98140 22311' }, dispatcher);
    for (const roll of o4.rolls) await verifyRoll(tx, s4.id, roll.code, dispatcher);
    const invoice = await confirmShipment(tx, s4.id, dispatcher);
    await buyerPayment(tx, invoice.id, { amount: 80000, reference: 'NEFT-AT-55120' }, actor);

    // ORDER 5: inspected (passed, rework, pending) and a truck being loaded
    const o5 = await finishOrder(1, 0, 'Sky blue', 800, 4, 'SO-2026-0999');
    await inspectRoll(tx, o5.rolls[0].id, { result: 'PASSED', defects: [], notes: '' }, inspector);
    await inspectRoll(tx, o5.rolls[1].id, { result: 'PASSED', defects: [], notes: '' }, inspector);
    await inspectRoll(tx, o5.rolls[2].id, { result: 'REWORK', defects: ['Colour mismatch'], notes: 'Shade lighter than approved swatch' }, inspector);
    const s5 = await createShipment(tx, { orderId: o5.order.id, rollIds: [o5.rolls[0].id, o5.rolls[1].id], transport: 'HR-55-KL-0932', driverName: 'Mahesh Yadav', driverPhone: '+91 99910 47820' }, dispatcher);
    await verifyRoll(tx, s5.id, o5.rolls[0].code, dispatcher);

    // ORDER 6: fresh rolls waiting for quality inspection
    await finishOrder(2, 3, 'Raw white', 500, 6, 'SO-2026-1000');

    // ORDER 7: buyer request waiting for the production manager's review
    const buyerUser = await tx.user.findFirstOrThrow({ where: { role: 'BUYER' } });
    const request = await createOrder(tx, {
      buyerId: buyers[0].id,
      deadline: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      priority: 'HIGH',
      instructions: 'Need lab dip approval before bulk dyeing.',
      items: [{ recipeId: recipes[2].id, color: 'Olive', quantity: 900 }],
    }, { ...actor, id: buyerUser.id, name: buyerUser.name, role: 'BUYER', buyerId: buyers[0].id }, 'PENDING_REVIEW');
    await tx.salesOrder.update({ where: { id: request.id }, data: { number: 'SO-2026-1004' } });

    // ORDER 1 starts spinning now that its operator is free (the floor shows a running job)
    await run(prod1.jobs[0].id, workers[0].id, machines[0].id);

    // A loom stoppage so the machine floor shows a real alert
    await reportBreakdown(tx, machines[3].id, 'Warp beam tension fault', supervisor);
  }, { timeout: 900000, maxWait: 20000 });

  console.log('LoomOS seeded: 5 months of history (100 orders, receipts, bills, wages) plus today\'s floor: 7 live orders.');
}

seed().finally(() => db.$disconnect());
