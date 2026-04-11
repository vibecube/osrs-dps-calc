/* eslint-disable no-restricted-globals */
import {
  CalcRequestsUnion,
  CalcResponse,
  Handler,
  WORKER_JSON_REPLACER,
  WORKER_JSON_REVIVER,
  WorkerRequestType,
} from '@/worker/CalcWorkerTypes';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import { AttackSequenceLoadout, AttackSequenceStep } from '@/types/State';
import { Player } from '@/types/Player';
import { DelayedHit } from '@/lib/HitDist';
import { TTK_DIST_EPSILON, TTK_DIST_MAX_ITER_ROUNDS } from '@/lib/constants';
import { calculateEquipmentBonusesFromGear } from '@/lib/Equipment';
import { Monster } from '@/types/Monster';
import { scaleMonster } from '@/lib/MonsterScaling';

interface StepPrecomp {
  dist: DelayedHit[];
  hpDists: DelayedHit[][] | null;
  speed: number;
  condition: AttackSequenceStep['condition'];
}

function buildSteps(sequence: AttackSequenceStep[], loadouts: Player[], monster: Monster, scaledMonster: Monster): (StepPrecomp | null)[] {
  return sequence.map((step) => {
    const player: Player | undefined = loadouts[step.loadoutIndex];
    if (!player) return null;
    const effectivePlayer: Player = (() => {
      if (step.weaponOverride === undefined) return player;
      const equipment = {
        ...player.equipment,
        weapon: step.weaponOverride,
        shield: step.weaponOverride?.isTwoHanded ? null : player.equipment.shield,
      };
      const base: Player = { ...player, equipment };
      return { ...base, ...calculateEquipmentBonusesFromGear(base, monster) };
    })();
    const baseCalc = new PlayerVsNPCCalc(effectivePlayer, monster, { loadoutName: 'seq-dp' });
    const activeCalc = step.useSpec ? (baseCalc.getSpecCalc() ?? baseCalc) : baseCalc;
    const dist = activeCalc.getDistribution()
      .zipped
      .withProbabilisticDelays(activeCalc.getWeaponDelayProvider());
    const speed = activeCalc.getAttackSpeed();
    const recalcOnHp = activeCalc.distIsCurrentHpDependent(effectivePlayer, scaledMonster);
    const hpDists: DelayedHit[][] | null = recalcOnHp
      ? Array.from({ length: scaledMonster.skills.hp + 1 }, (_, hp) => activeCalc.distAtHp(dist, hp))
      : null;
    return {
      dist, hpDists, speed, condition: step.condition,
    };
  });
}

/** (dmg, prob) pairs for a step at a given HP. hp is only used when hpDists is non-null. */
function flatDist(step: StepPrecomp, hp: number): [number, number][] {
  const d = step.hpDists ? step.hpDists[hp] : step.dist;
  const map = new Map<number, number>();
  for (const [wh] of d) {
    const dmg = wh.getSum();
    map.set(dmg, (map.get(dmg) ?? 0) + wh.probability);
  }
  return Array.from(map.entries());
}

function convolve(a: [number, number][], b: [number, number][]): [number, number][] {
  const map = new Map<number, number>();
  for (const [da, pa] of a) {
    for (const [db, pb] of b) {
      const d = da + db;
      map.set(d, (map.get(d) ?? 0) + pa * pb);
    }
  }
  return Array.from(map.entries());
}

function combinedDist(steps: StepPrecomp[], hp: number): [number, number][] {
  if (steps.length === 0) return [[0, 1]];
  let result = flatDist(steps[0], hp);
  for (let i = 1; i < steps.length; i++) {
    result = convolve(result, flatDist(steps[i], hp));
  }
  return result;
}

/**
 * Precompute the full attack event schedule for one player.
 *
 * 'attacks' steps produce a finite list of (tick, step) events.
 * The first 'kill' or 'hp_threshold' step produces an open-ended entry: the
 * player fires from entryTick every speed ticks until the monster dies / threshold is met.
 */
interface AttackEvent {
  tick: number;
  step: StepPrecomp;
}

interface OpenStep {
  entryTick: number;
  step: StepPrecomp;
}

interface PlayerSchedule {
  events: AttackEvent[];
  openStep: OpenStep | null;
}

function buildPlayerSchedule(steps: (StepPrecomp | null)[]): PlayerSchedule {
  const events: AttackEvent[] = [];
  let tick = 1;

  for (const step of steps) {
    if (!step) continue;
    if (step.condition.type === 'attacks') {
      for (let a = 0; a < step.condition.count; a++) {
        events.push({ tick, step });
        tick += step.speed;
      }
    } else {
      return { events, openStep: { entryTick: tick, step } };
    }
  }
  return { events, openStep: null };
}

function computeOneLoadout(playerSequences: AttackSequenceStep[][], loadouts: Player[], monster: Monster): Map<number, number> {
  const scaledMonster = scaleMonster(monster);
  const allPlayerSteps = playerSequences.map((seq) => buildSteps(seq, loadouts, monster, scaledMonster));

  const maxHp = scaledMonster.skills.hp;
  const startHp = scaledMonster.inputs.monsterCurrentHp || scaledMonster.skills.hp;

  const schedules = allPlayerSteps.map((steps) => buildPlayerSchedule(steps));

  // Estimate tick budget
  let h = 2;
  for (const s of schedules) {
    for (const e of s.events) h = Math.max(h, e.tick + 2);
    if (s.openStep) h += TTK_DIST_MAX_ITER_ROUNDS * s.openStep.step.speed;
  }
  h += 20;

  const w = maxHp + 1;
  const cur = new Float64Array(h * w);
  cur[1 * w + startHp] = 1.0;

  const ttks = new Map<number, number>();
  let epsilon = 1.0;

  // --- Phase 1: 'attacks' steps ---
  // Build sorted list of unique ticks across all players' events
  const attackTickSet = new Set<number>();
  for (const s of schedules) {
    for (const e of s.events) attackTickSet.add(e.tick);
  }
  const sortedAttackTicks = Array.from(attackTickSet).sort((a, b) => a - b);

  // Build tick → [StepPrecomp, ...] map (all players firing at this tick)
  const tickToSteps = new Map<number, StepPrecomp[]>();
  for (const s of schedules) {
    for (const { tick, step } of s.events) {
      if (!tickToSteps.has(tick)) tickToSteps.set(tick, []);
      tickToSteps.get(tick)!.push(step);
    }
  }

  // Open-step entry: survivors from the last attack tick jump to the earliest open-step entry
  const openSteps: OpenStep[] = schedules
    .map((s) => s.openStep)
    .filter((s): s is OpenStep => s !== null);
  const openStart = openSteps.length > 0 ? Math.min(...openSteps.map((o) => o.entryTick)) : null;

  for (let ei = 0; ei < sortedAttackTicks.length && epsilon >= TTK_DIST_EPSILON; ei++) {
    const tick = sortedAttackTicks[ei];
    const nextTick = ei + 1 < sortedAttackTicks.length ? sortedAttackTicks[ei + 1] : (openStart ?? null);
    const firingSteps = tickToSteps.get(tick)!;
    const hasHpDep = firingSteps.some((s) => s.hpDists !== null);

    for (let hp = 1; hp <= maxHp; hp++) {
      const prob = cur[tick * w + hp];
      if (prob === 0) continue;

      const combined = combinedDist(firingSteps, hasHpDep ? hp : 0);

      for (const [dmg, p] of combined) {
        const totalP = prob * p;
        if (totalP === 0) continue;
        const newHp = hp - dmg;
        if (newHp <= 0) {
          ttks.set(tick, (ttks.get(tick) ?? 0) + totalP);
          epsilon -= totalP;
        } else if (nextTick !== null && nextTick < h) {
          cur[nextTick * w + newHp] += totalP;
        }
        // If nextTick === null: no more events, these survivors never get killed — drop them
      }
      cur[tick * w + hp] = 0;
    }
  }

  // --- Phase 2: open-ended (kill / hp_threshold) steps ---
  if (openSteps.length > 0 && epsilon >= TTK_DIST_EPSILON) {
    // Each open step fires every `speed` ticks from its entryTick independently.
    const openNextTick = openSteps.map((o) => o.entryTick);

    // Find the minimum tick with probability mass to start from
    let t0 = openStart!;
    for (let t = 1; t < openStart!; t++) {
      let hasAny = false;
      for (let hp = 1; hp <= maxHp; hp++) {
        if (cur[t * w + hp] > 0) { hasAny = true; break; }
      }
      if (hasAny) { t0 = t; break; }
    }

    let t = t0;
    while (t < h && epsilon >= TTK_DIST_EPSILON) {
      const firingOpen: StepPrecomp[] = [];
      for (let i = 0; i < openSteps.length; i++) {
        if (openNextTick[i] === t) {
          firingOpen.push(openSteps[i].step);
          openNextTick[i] = t + openSteps[i].step.speed;
        }
      }

      if (firingOpen.length === 0) {
        // Jump directly to the next tick where a player fires
        t = Math.min(...openNextTick);
        continue;
      }

      const hasHpDep = firingOpen.some((s) => s.hpDists !== null);
      const nextFire = Math.min(...openNextTick);

      for (let hp = 1; hp <= maxHp; hp++) {
        const prob = cur[t * w + hp];
        if (prob === 0) continue;

        const combined = combinedDist(firingOpen, hasHpDep ? hp : 0);

        for (const [dmg, p] of combined) {
          const totalP = prob * p;
          if (totalP === 0) continue;
          const newHp = hp - dmg;
          if (newHp <= 0) {
            ttks.set(t, (ttks.get(t) ?? 0) + totalP);
            epsilon -= totalP;
          } else if (nextFire < h) {
            cur[nextFire * w + newHp] += totalP;
          }
        }
        cur[t * w + hp] = 0;
      }

      t++;
    }
  }

  return ttks;
}

// eslint-disable-next-line import/prefer-default-export
export const sequenceTtkDist: Handler<WorkerRequestType.COMPUTE_SEQUENCE_TTK> = async (data) => {
  const { sequenceLoadouts, loadouts, monster } = data;
  return sequenceLoadouts.map((sl) => computeOneLoadout(sl.players, loadouts, monster));
};

self.onmessage = async (evt: MessageEvent<string>) => {
  const req = JSON.parse(evt.data, WORKER_JSON_REVIVER) as CalcRequestsUnion;
  const { type, sequenceId, data } = req;

  const res = {
    type,
    sequenceId: sequenceId!,
  } as CalcResponse<typeof type>;

  try {
    switch (type) {
      case WorkerRequestType.COMPUTE_SEQUENCE_TTK: {
        res.payload = await sequenceTtkDist(data, req);
        break;
      }
      default:
        res.error = `Unsupported request type ${type}`;
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      res.error = e.message;
    } else {
      res.error = `Unknown error type: ${e}`;
    }
  }

  self.postMessage(JSON.stringify(res, WORKER_JSON_REPLACER));
};

export {};
