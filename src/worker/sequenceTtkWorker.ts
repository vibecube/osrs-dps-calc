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
import { AttackSequenceStep } from '@/types/State';
import { Player } from '@/types/Player';
import { DelayedHit } from '@/lib/HitDist';
import { TTK_DIST_EPSILON, TTK_DIST_MAX_ITER_ROUNDS } from '@/lib/constants';
import { calculateEquipmentBonusesFromGear } from '@/lib/Equipment';

interface StepPrecomp {
  calc: PlayerVsNPCCalc;
  dist: DelayedHit[];
  /** Per-HP hit distributions for weapons whose damage depends on current HP (ruby bolts, yellow keris, etc.).
   *  Null when the distribution is HP-independent, matching getTtkDistribution()'s hpHitDists optimisation. */
  hpDists: DelayedHit[][] | null;
  speed: number;
  condition: AttackSequenceStep['condition'];
}

// eslint-disable-next-line import/prefer-default-export
export const sequenceTtkDist: Handler<WorkerRequestType.COMPUTE_SEQUENCE_TTK> = async (data) => {
  const { sequence, loadouts, monster } = data;

  // Pre-compute per-step data, mirroring the setup getTtkDistribution() does for a single weapon.
  const steps: (StepPrecomp | null)[] = sequence.map((step) => {
    const player: Player | undefined = loadouts[step.loadoutIndex];
    if (!player) return null;
    const effectivePlayer: Player = (() => {
      if (step.weaponOverride === undefined) return player;
      const equipment = {
        ...player.equipment,
        weapon: step.weaponOverride,
        // 2H weapons cannot use a shield; clear it to avoid phantom offhand stats
        shield: step.weaponOverride?.isTwoHanded ? null : player.equipment.shield,
      };
      const base: Player = { ...player, equipment };
      // Recompute pre-aggregated bonuses so PlayerVsNPCCalc sees the correct totals
      return { ...base, ...calculateEquipmentBonusesFromGear(base, monster) };
    })();
    const baseCalc = new PlayerVsNPCCalc(effectivePlayer, monster, { loadoutName: 'seq-dp' });
    const activeCalc = step.useSpec ? (baseCalc.getSpecCalc() ?? baseCalc) : baseCalc;
    const dist = activeCalc.getDistribution()
      .zipped
      .withProbabilisticDelays(activeCalc.getWeaponDelayProvider());
    const speed = activeCalc.getAttackSpeed();
    const recalcOnHp = activeCalc.distIsCurrentHpDependent(effectivePlayer, activeCalc.monster);
    const hpDists: DelayedHit[][] | null = recalcOnHp
      ? Array.from({ length: activeCalc.monster.skills.hp + 1 }, (_, hp) => activeCalc.distAtHp(dist, hp))
      : null;
    return {
      calc: activeCalc, dist, hpDists, speed, condition: step.condition,
    };
  });

  // Derive maxHp/startHp from the first valid step's scaled calc so that scaleMonster()
  // adjustments (e.g. ToB party-size HP reduction) are applied exactly as getTtkDistribution() does.
  const refCalc = steps.find((s) => s !== null)?.calc;
  const maxHp = refCalc?.monster.skills.hp ?? monster.skills.hp;
  const startHp = refCalc
    ? (refCalc.monster.inputs.monsterCurrentHp || refCalc.monster.skills.hp)
    : monster.skills.hp;

  // Pre-compute the tick budget needed to cover every step:
  //   - attacks steps:          N × maxDelay ticks
  //   - kill / threshold steps: TTK_DIST_MAX_ITER_ROUNDS × speed ticks
  // The +20 safety buffer matches getTtkDistribution()'s (iterMax + 20) allocation so that
  // in-place writes at (t + delay) never exceed the array bounds.
  let h = 2; // 1-indexed base
  for (const step of steps) {
    if (!step) continue;
    const maxDelay = step.dist.reduce((acc, [, d]) => Math.max(acc, d), step.speed);
    if (step.condition.type === 'attacks') {
      h += step.condition.count * maxDelay;
    } else {
      h += TTK_DIST_MAX_ITER_ROUNDS * Math.max(step.speed, maxDelay);
    }
  }
  h += 20;

  // State arrays: tickHps[t * w + hp] = P(attack fires at tick t AND monster HP = hp).
  // This is the same representation getTtkDistribution() uses for tickHps[t][hp].
  // Two buffers (cur / nxt) are ping-ponged for the round-based steps; the kill step
  // updates cur in-place (safe because t + delay > t, so no write aliasing).
  const w = maxHp + 1;
  let cur = new Float64Array(h * w);
  let nxt = new Float64Array(h * w);

  // First attack fires at tick 1 with full HP — identical to getTtkDistribution()'s init.
  cur[1 * w + startHp] = 1.0;

  const ttks = new Map<number, number>();
  let epsilon = 1.0; // total probability mass not yet killed

  for (const step of steps) {
    if (!step || epsilon < TTK_DIST_EPSILON) break;
    const { dist, hpDists, condition } = step;

    if (condition.type === 'attacks') {
      // Apply exactly N attacks, one round at a time.
      // Each round reads from cur, writes survivors to nxt, then swaps.
      // Kills (newHp ≤ 0) are drained from epsilon and recorded immediately.
      for (let a = 0; a < condition.count && epsilon >= TTK_DIST_EPSILON; a++) {
        for (let t = 1; t < h; t++) {
          for (let hp = 1; hp <= maxHp; hp++) {
            const prob = cur[t * w + hp];
            if (prob === 0) continue;
            const stepDist = hpDists ? hpDists[hp] : dist;
            for (const [wh, delay] of stepDist) {
              const p = prob * wh.probability;
              if (p === 0) continue;
              const newHp = hp - wh.getSum();
              if (newHp <= 0) {
                ttks.set(t, (ttks.get(t) || 0) + p);
                epsilon -= p;
              } else {
                nxt[(t + delay) * w + newHp] += p;
              }
            }
          }
        }
        [cur, nxt] = [nxt, cur];
        nxt.fill(0); // clear the old cur buffer for the next round
      }
    } else if (condition.type === 'hp_threshold') {
      // Attack until all probability mass is at or below the HP threshold.
      // Paths already at/below target are carried forward at their current tick unchanged —
      // they will enter the next step's weapon cooldown naturally.
      const target = condition.hp;
      let pendingMass = epsilon; // upper bound: all remaining mass could still be above target
      for (let iter = 0; iter < TTK_DIST_MAX_ITER_ROUNDS && pendingMass >= TTK_DIST_EPSILON; iter++) {
        pendingMass = 0;
        for (let t = 1; t < h; t++) {
          for (let hp = 1; hp <= maxHp; hp++) {
            const prob = cur[t * w + hp];
            if (prob === 0) continue;
            if (hp <= target) {
              nxt[t * w + hp] += prob; // already at threshold — carry forward unchanged
              continue;
            }
            const stepDist = hpDists ? hpDists[hp] : dist;
            for (const [wh, delay] of stepDist) {
              const p = prob * wh.probability;
              if (p === 0) continue;
              const newHp = hp - wh.getSum();
              if (newHp <= 0) {
                ttks.set(t, (ttks.get(t) || 0) + p);
                epsilon -= p;
              } else {
                nxt[(t + delay) * w + newHp] += p;
                if (newHp > target) pendingMass += p;
              }
            }
          }
        }
        [cur, nxt] = [nxt, cur];
        nxt.fill(0);
      }
    } else {
      // 'kill' — in-place tick-indexed DP, exactly matching getTtkDistribution().
      // Iterating ticks in ascending order guarantees that writing to cur[t + delay] never
      // corrupts the current tick's data (since t + delay > t).
      if (step.calc.getDistribution().getExpectedDamage() === 0) break;
      for (let t = 1; t < h && epsilon >= TTK_DIST_EPSILON; t++) {
        for (let hp = 1; hp <= maxHp; hp++) {
          const prob = cur[t * w + hp];
          if (prob === 0) continue;
          const stepDist = hpDists ? hpDists[hp] : dist;
          for (const [wh, delay] of stepDist) {
            const p = prob * wh.probability;
            if (p === 0) continue;
            const newHp = hp - wh.getSum();
            if (newHp <= 0) {
              ttks.set(t, (ttks.get(t) || 0) + p);
              epsilon -= p;
            } else {
              cur[(t + delay) * w + newHp] += p; // in-place: safe because t + delay > t
            }
          }
        }
      }
      break; // kill is always the terminal step
    }
  }

  return ttks;
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
