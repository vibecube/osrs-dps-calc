/* eslint-disable no-restricted-globals */
import {
  CalcRequestsUnion,
  CalcResponse,
  Handler,
  SequenceWorkerLoadout,
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
import { MonsterAttribute } from '@/enums/MonsterAttribute';
import { getDefenceFloor } from '@/lib/scaling/DefenceReduction';
import { SequenceSwingEvent } from '@/types/State';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pre-built cumulative distribution function for fast MC sampling. */
interface CdfData {
  dmg: Int32Array;
  cum: Float64Array;
}

type DrainType = 'bgs' | 'dwh' | 'elderMaul' | 'arclight' | 'emberlight' | 'tonalztic' | 'seercull' | 'shadowBarrage';

interface DrainInfo {
  type: DrainType;
  /** For arclight / emberlight drain formula (demonbane multiplier). */
  isDemon: boolean;
}

interface StepPrecomp {
  dist: DelayedHit[];
  hpDists: DelayedHit[][] | null;
  speed: number;
  condition: AttackSequenceStep['condition'];
  /** Hit chance at the monster def/magic level this precomp was built for. */
  hitChance: number;
  /** Non-null when this step has an in-sequence defence drain effect. */
  drain: DrainInfo | null;
  /** CDF for MC sampling from the base distribution (hp-independent). */
  baseCdf: CdfData;
  /** Per-HP CDFs for MC sampling, populated when hpDists is non-null. */
  hpCdfs: CdfData[] | null;
  /** Human-readable weapon label for the debug trace (includes "(spec)" suffix when applicable). */
  weaponName: string;
}

/** Live monster stat state tracked per MC iteration. */
interface McMonsterState {
  def: number;
  magic: number;
  atk: number;
  str: number;
  ranged: number;
  /** Shadow barrage only drains defence once per fight. */
  shadowBarrageDrained: boolean;
}

// ---------------------------------------------------------------------------
// CDF helpers
// ---------------------------------------------------------------------------

function delayedToFlat(d: DelayedHit[]): [number, number][] {
  const map = new Map<number, number>();
  for (const [wh] of d) {
    const dmg = wh.getSum();
    map.set(dmg, (map.get(dmg) ?? 0) + wh.probability);
  }
  return Array.from(map.entries());
}

function buildCdf(flat: [number, number][]): CdfData {
  const sorted = flat.slice().sort((a, b) => a[0] - b[0]);
  const n = sorted.length;
  const dmg = new Int32Array(sorted.map(([d]) => d));
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += sorted[i][1];
    cum[i] = acc;
  }
  if (n > 0) cum[n - 1] = 1.0; // guard against floating-point accumulation error
  return { dmg, cum };
}

function sampleCdf(cdf: CdfData): number {
  const r = Math.random();
  let lo = 0;
  let hi = cdf.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf.cum[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return cdf.dmg[lo];
}

function sampleStep(step: StepPrecomp, hp: number): number {
  const cdf = step.hpCdfs
    ? step.hpCdfs[Math.min(hp, step.hpCdfs.length - 1)]
    : step.baseCdf;
  return sampleCdf(cdf);
}

// ---------------------------------------------------------------------------
// Drain helpers
// ---------------------------------------------------------------------------

/**
 * Spec drain weapons (must have useSpec=true to trigger).
 * Shadow barrage is excluded — it drains on every hit, not just spec.
 */
const SPEC_DRAIN_WEAPONS = new Set([
  'Bandos godsword',
  'Dragon warhammer',
  'Elder maul',
  'Arclight',
  'Emberlight',
  'Tonalztics of ralos',
  'Seercull',
]);

/**
 * Returns true if any step in any player's sequence has a defence-draining
 * effect, which requires the Monte Carlo simulation path.
 */
function sequenceHasDrain(playerSequences: AttackSequenceStep[][], loadouts: Player[]): boolean {
  return playerSequences.some((seq) => seq.some((step) => {
    const player = loadouts[step.loadoutIndex];
    if (!player) return false;
    const weapon = step.weaponOverride !== undefined ? step.weaponOverride : player.equipment.weapon;
    const weaponName = weapon?.name ?? '';
    if (step.useSpec && SPEC_DRAIN_WEAPONS.has(weaponName)) return true;
    // Shadow ancient sceptre + Shadow Barrage spell drains once on first hit
    if (weaponName === 'Shadow ancient sceptre' && player.spell?.name === 'Shadow Barrage') return true;
    return false;
  }));
}

/**
 * Returns true if any step uses an hp_threshold condition, which requires the
 * MC path (exact DP cannot track per-player step-state transitions at runtime).
 */
function sequenceHasHpThreshold(playerSequences: AttackSequenceStep[][]): boolean {
  return playerSequences.some((seq) => seq.some((step) => step.condition.type === 'hp_threshold'));
}

function detectDrain(effectivePlayer: Player, step: AttackSequenceStep, monster: Monster): DrainInfo | null {
  const weaponName = effectivePlayer.equipment.weapon?.name ?? '';
  const isDemon = monster.attributes.includes(MonsterAttribute.DEMON);
  if (step.useSpec) {
    if (weaponName === 'Bandos godsword') return { type: 'bgs', isDemon: false };
    if (weaponName === 'Dragon warhammer') return { type: 'dwh', isDemon: false };
    if (weaponName === 'Elder maul') return { type: 'elderMaul', isDemon: false };
    if (weaponName === 'Arclight') return { type: 'arclight', isDemon };
    if (weaponName === 'Emberlight') return { type: 'emberlight', isDemon };
    if (weaponName === 'Tonalztics of ralos') return { type: 'tonalztic', isDemon: false };
    if (weaponName === 'Seercull') return { type: 'seercull', isDemon: false };
  }
  if (weaponName === 'Shadow ancient sceptre' && effectivePlayer.spell?.name === 'Shadow Barrage') {
    return { type: 'shadowBarrage', isDemon: false };
  }
  return null;
}

/**
 * Apply an in-sequence defence drain to the live monster state.
 *
 * @param drain      Drain descriptor for this step.
 * @param damage     Actual damage rolled this attack.
 * @param isHit      Whether the attack was accurate (needed for non-BGS drains).
 * @param state      Mutable monster state to update.
 * @param defFloor   Minimum defence level for this monster.
 * @param initDef    Initial scaled defence (used for arclight formula).
 * @param initAtk    Initial scaled attack (used for arclight formula).
 * @param initStr    Initial scaled strength (used for arclight formula).
 */
function applyDrain(
  drain: DrainInfo,
  damage: number,
  isHit: boolean,
  state: McMonsterState,
  defFloor: number,
  initDef: number,
  initAtk: number,
  initStr: number,
): void {
  if (!isHit) return;
  switch (drain.type) {
    case 'bgs': {
      // Drain def by damage dealt; cascade overflow to str → atk → magic → ranged.
      // Cascade only when a stat reaches absolute 0 (not just the def floor).
      let rem = damage;
      const drainStat = (cur: number, floor: number): number => {
        const next = Math.max(floor, cur - rem);
        if (next > 0) rem = 0;
        else rem -= cur;
        return next;
      };
      state.def = drainStat(state.def, defFloor);
      if (rem > 0) state.str = drainStat(state.str, 0);
      if (rem > 0) state.atk = drainStat(state.atk, 0);
      if (rem > 0) state.magic = drainStat(state.magic, 0);
      if (rem > 0) state.ranged = drainStat(state.ranged, 0);
      break;
    }
    case 'dwh':
      state.def = Math.max(defFloor, state.def - Math.trunc(state.def * 3 / 10));
      break;
    case 'elderMaul':
      state.def = Math.max(defFloor, state.def - Math.trunc(state.def * 35 / 100));
      break;
    case 'arclight': {
      const num = drain.isDemon ? 2 : 1;
      state.def = Math.max(defFloor, state.def - (Math.trunc(num * initDef / 20) + 1));
      state.atk = Math.max(0, state.atk - (Math.trunc(num * initAtk / 20) + 1));
      state.str = Math.max(0, state.str - (Math.trunc(num * initStr / 20) + 1));
      break;
    }
    case 'emberlight': {
      const num = drain.isDemon ? 3 : 1;
      state.def = Math.max(defFloor, state.def - (Math.trunc(num * initDef / 20) + 1));
      state.atk = Math.max(0, state.atk - (Math.trunc(num * initAtk / 20) + 1));
      state.str = Math.max(0, state.str - (Math.trunc(num * initStr / 20) + 1));
      break;
    }
    case 'tonalztic':
      // Drain amount uses current magic level (may have been drained by seercull).
      state.def = Math.max(defFloor, state.def - Math.trunc(state.magic / 10));
      break;
    case 'seercull':
      // Drain magic by damage dealt (mirrors BGS mechanic, targets magic).
      state.magic = Math.max(0, state.magic - damage);
      break;
    case 'shadowBarrage':
      // 16.5% one-time drain; resulting defence level is rounded up.
      if (!state.shadowBarrageDrained) {
        state.def = Math.max(defFloor, Math.ceil(state.def * 0.835));
        state.shadowBarrageDrained = true;
      }
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Step precomputation
// ---------------------------------------------------------------------------

function buildSteps(
  sequence: AttackSequenceStep[],
  loadouts: Player[],
  monster: Monster,
  scaledMonster: Monster,
): (StepPrecomp | null)[] {
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
    const hitChance = activeCalc.getHitChance();
    const drain = detectDrain(effectivePlayer, step, monster);
    const baseCdf = buildCdf(delayedToFlat(dist));
    const hpCdfs = hpDists
      ? Array.from({ length: hpDists.length }, (_, hp) => buildCdf(delayedToFlat(hpDists[hp])))
      : null;
    const rawWeaponName = effectivePlayer.equipment.weapon?.name ?? 'Unknown';
    const weaponName = step.useSpec ? `${rawWeaponName} (spec)` : rawWeaponName;
    return {
      dist,
      hpDists,
      speed,
      condition: step.condition,
      hitChance,
      drain,
      baseCdf,
      hpCdfs,
      weaponName,
    };
  });
}

/** (dmg, prob) pairs for a step at a given HP. hp is only used when hpDists is non-null. */
function flatDist(step: StepPrecomp, hp: number): [number, number][] {
  return delayedToFlat(step.hpDists ? step.hpDists[hp] : step.dist);
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

// ---------------------------------------------------------------------------
// Schedule building
// ---------------------------------------------------------------------------

/**
 * Each event records the step index within the original sequence so the
 * Monte Carlo path can look up steps from the lazy per-def-level cache.
 */
interface AttackEvent {
  tick: number;
  step: StepPrecomp;
  seqStepIdx: number;
}

interface OpenStep {
  entryTick: number;
  step: StepPrecomp;
  seqStepIdx: number;
}

interface PlayerSchedule {
  events: AttackEvent[];
  /** All non-'attacks' steps in sequence order. */
  openSteps: OpenStep[];
}

function buildPlayerSchedule(steps: (StepPrecomp | null)[]): PlayerSchedule {
  const events: AttackEvent[] = [];
  const openSteps: OpenStep[] = [];
  let tick = 1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (step.condition.type === 'attacks') {
      for (let a = 0; a < step.condition.count; a++) {
        events.push({ tick, step, seqStepIdx: i });
        tick += step.speed;
      }
    } else {
      openSteps.push({ entryTick: tick, step, seqStepIdx: i });
      if (step.condition.type === 'kill') break; // terminal — no steps after kill
      // For hp_threshold, the exit tick depends on runtime HP; subsequent steps are
      // added here so the MC can chain them; timing is tracked dynamically.
    }
  }
  return { events, openSteps };
}

// ---------------------------------------------------------------------------
// Monte Carlo simulation (used when any step has a defence drain effect)
// ---------------------------------------------------------------------------

const SEQUENCE_MC_ITERATIONS = 50_000;
/** Safety cap on Phase 2 ticks per iteration (≈ 100 real-world minutes). */
const SEQUENCE_MC_MAX_TICKS = 10_000;

/** Monster.inputs.defenceReductions zeroed out — the sequence handles drains. */
const ZERO_DEF_REDUCTIONS: Monster['inputs']['defenceReductions'] = {
  vulnerability: false,
  accursed: false,
  elderMaul: 0,
  dwh: 0,
  arclight: 0,
  emberlight: 0,
  bgs: 0,
  tonalztic: 0,
  seercull: 0,
  ayak: 0,
};

// Per-player run state shared across both MC and trace simulation.
interface PlayerRunState {
  playerIdx: number;
  stepIdx: number;
  attacksLeft: number;
  nextTick: number;
}

// Advance a player to their next step after their current condition is satisfied.
// prevSpeed: the speed of the weapon just fired — determines when the next attack slot opens.
function advancePlayerStep(ps: PlayerRunState, playerSteps: (StepPrecomp | null)[], t: number, prevSpeed: number): void {
  ps.stepIdx++;
  while (ps.stepIdx < playerSteps.length && !playerSteps[ps.stepIdx]) ps.stepIdx++;
  if (ps.stepIdx >= playerSteps.length) {
    ps.nextTick = SEQUENCE_MC_MAX_TICKS + 1; // no more steps
    return;
  }
  const ns = playerSteps[ps.stepIdx]!;
  ps.attacksLeft = ns.condition.type === 'attacks' ? ns.condition.count : 0;
  ps.nextTick = t + prevSpeed; // next attack opens after current weapon's cycle completes
}

/**
 * Builds initial PlayerRunState[] for one monster's steps.
 * `initialNextTicks`: per-player carry-over nextTick from the previous monster (or 1 on first monster).
 */
function buildInitialPlayerStates(
  playerSequences: AttackSequenceStep[][],
  precompSteps: (StepPrecomp | null)[][],
  initialNextTicks: number[],
): PlayerRunState[] {
  const states: PlayerRunState[] = [];
  for (let pi = 0; pi < playerSequences.length; pi++) {
    const pSteps = precompSteps[pi];
    let firstIdx = -1;
    for (let i = 0; i < pSteps.length; i++) { if (pSteps[i]) { firstIdx = i; break; } }
    if (firstIdx === -1) continue;
    const firstStep = pSteps[firstIdx]!;
    states.push({
      playerIdx: pi,
      stepIdx: firstIdx,
      attacksLeft: firstStep.condition.type === 'attacks' ? firstStep.condition.count : 0,
      nextTick: initialNextTicks[pi] ?? 1,
    });
  }
  return states;
}

/**
 * Runs one monster's MC simulation for SEQUENCE_MC_ITERATIONS iterations.
 * Returns:
 *   - `killTicks`: per-iteration kill tick (length = SEQUENCE_MC_ITERATIONS)
 *   - `carryoverNextTicks`: per-iteration, per-player nextTick after the kill
 */
function computeOneMonsterMC(
  playerSequences: AttackSequenceStep[][],
  loadouts: Player[],
  cleanMonster: Monster,
  iterationNextTicks: number[][], // [iter][playerIdx]
): { killTicks: number[]; carryoverNextTicks: number[][] } {
  const initialScaled = scaleMonster(cleanMonster);
  const defFloor = getDefenceFloor(initialScaled);
  const startHp = initialScaled.inputs.monsterCurrentHp || initialScaled.skills.hp;
  const initDef = initialScaled.skills.def;
  const initMagic = initialScaled.skills.magic;
  const initAtk = initialScaled.skills.atk;
  const initStr = initialScaled.skills.str;
  const initRanged = initialScaled.skills.ranged;

  const stepCache = new Map<string, (StepPrecomp | null)[][]>();
  const getStepsForState = (def: number, magic: number): (StepPrecomp | null)[][] => {
    const key = `${def},${magic}`;
    let cached = stepCache.get(key);
    if (!cached) {
      const m = (def === initDef && magic === initMagic)
        ? cleanMonster
        : { ...cleanMonster, skills: { ...cleanMonster.skills, def, magic } };
      const scaled = (def === initDef && magic === initMagic)
        ? initialScaled
        : scaleMonster(m);
      cached = playerSequences.map((seq) => buildSteps(seq, loadouts, m, scaled));
      stepCache.set(key, cached);
    }
    return cached;
  };

  const baseSteps = getStepsForState(initDef, initMagic);
  const killTicks: number[] = new Array(SEQUENCE_MC_ITERATIONS).fill(SEQUENCE_MC_MAX_TICKS);
  const carryoverNextTicks: number[][] = [];

  for (let iter = 0; iter < SEQUENCE_MC_ITERATIONS; iter++) {
    const state: McMonsterState = {
      def: initDef, magic: initMagic, atk: initAtk, str: initStr, ranged: initRanged,
      shadowBarrageDrained: false,
    };
    let hp = startHp;
    let killed = false;
    let killTick = SEQUENCE_MC_MAX_TICKS;

    const playerStates = buildInitialPlayerStates(playerSequences, baseSteps, iterationNextTicks[iter] ?? []);

    while (!killed) {
      let t = SEQUENCE_MC_MAX_TICKS + 1;
      for (const ps of playerStates) { if (ps.nextTick < t) t = ps.nextTick; }
      if (t > SEQUENCE_MC_MAX_TICKS) break;

      const steps = getStepsForState(state.def, state.magic);

      for (const ps of playerStates) {
        if (ps.nextTick !== t) continue;
        const playerStepsArr = steps[ps.playerIdx];
        const step = playerStepsArr[ps.stepIdx];

        if (!step) { advancePlayerStep(ps, playerStepsArr, t, 1); continue; }

        const { condition } = step;

        if (condition.type === 'hp_threshold' && hp < condition.hp) {
          advancePlayerStep(ps, playerStepsArr, t, step.speed);
          continue;
        }

        const damage = sampleStep(step, hp);
        if (step.drain) {
          const isHit = (step.drain.type === 'bgs' || step.drain.type === 'seercull')
            ? damage > 0
            : Math.random() < step.hitChance;
          applyDrain(step.drain, damage, isHit, state, defFloor, initDef, initAtk, initStr);
        }
        hp -= damage;

        if (hp <= 0) { killed = true; killTick = t; break; }

        if (condition.type === 'attacks') {
          ps.attacksLeft--;
          if (ps.attacksLeft <= 0) {
            advancePlayerStep(ps, playerStepsArr, t, step.speed);
          } else {
            ps.nextTick = t + step.speed;
          }
        } else if (condition.type === 'hp_threshold') {
          if (hp < condition.hp) {
            advancePlayerStep(ps, playerStepsArr, t, step.speed);
          } else {
            ps.nextTick = t + step.speed;
          }
        } else {
          ps.nextTick = t + step.speed;
        }
      }
    }

    killTicks[iter] = killTick;
    // Carry over per-player nextTick; players not in this monster's sequence keep their previous tick.
    const carry = (iterationNextTicks[iter] ?? []).slice();
    for (const ps of playerStates) { carry[ps.playerIdx] = ps.nextTick; }
    carryoverNextTicks.push(carry);
  }

  return { killTicks, carryoverNextTicks };
}

/** Compute median kill tick from a per-iteration array of kill ticks. */
function medianKillTick(killTicks: number[]): number {
  const sorted = killTicks.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Convert per-iteration kill ticks to a CDF Map<tick, cumulative_probability>. */
function killTicksToDist(killTicks: number[]): Map<number, number> {
  const invN = 1 / killTicks.length;
  const raw = new Map<number, number>();
  for (const t of killTicks) { raw.set(t, (raw.get(t) ?? 0) + invN); }
  return raw;
}

// ---------------------------------------------------------------------------
// Exact DP (single monster, no drain, no hp_threshold)
// ---------------------------------------------------------------------------

function computeOneMonsterDP(
  playerSequences: AttackSequenceStep[][],
  loadouts: Player[],
  cleanMonster: Monster,
): Map<number, number> {
  const scaledMonster = scaleMonster(cleanMonster);
  const allPlayerSteps = playerSequences.map((seq) => buildSteps(seq, loadouts, cleanMonster, scaledMonster));

  const maxHp = scaledMonster.skills.hp;
  const startHp = scaledMonster.inputs.monsterCurrentHp || scaledMonster.skills.hp;

  const schedules = allPlayerSteps.map((steps) => buildPlayerSchedule(steps));

  let h = 2;
  for (const s of schedules) {
    for (const e of s.events) h = Math.max(h, e.tick + 2);
    if (s.openSteps.length > 0) h += TTK_DIST_MAX_ITER_ROUNDS * s.openSteps[0].step.speed;
  }
  h += 20;

  const w = maxHp + 1;
  const cur = new Float64Array(h * w);
  cur[1 * w + startHp] = 1.0;

  const ttks = new Map<number, number>();
  let epsilon = 1.0;

  const attackTickSet = new Set<number>();
  for (const s of schedules) {
    for (const e of s.events) attackTickSet.add(e.tick);
  }
  const sortedAttackTicks = Array.from(attackTickSet).sort((a, b) => a - b);

  const tickToSteps = new Map<number, StepPrecomp[]>();
  for (const s of schedules) {
    for (const { tick, step } of s.events) {
      if (!tickToSteps.has(tick)) tickToSteps.set(tick, []);
      tickToSteps.get(tick)!.push(step);
    }
  }

  const openSteps: OpenStep[] = schedules.flatMap((s) => s.openSteps.slice(0, 1));
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
      }
      cur[tick * w + hp] = 0;
    }
  }

  if (openSteps.length > 0 && epsilon >= TTK_DIST_EPSILON) {
    const openNextTick = openSteps.map((o) => o.entryTick);

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
      if (firingOpen.length === 0) { t = Math.min(...openNextTick); continue; }

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

// ---------------------------------------------------------------------------
// Multi-monster sequential simulation
// ---------------------------------------------------------------------------

function computeOneLoadout(workerLoadout: SequenceWorkerLoadout, loadouts: Player[]): {
  ttkDist: Map<number, number>;
  monsterKillTicks: number[];
} {
  const { monsters } = workerLoadout;

  // Single-monster, no drain, no hp_threshold → exact DP.
  if (monsters.length === 1) {
    const { monster, playerSteps } = monsters[0];
    const cleanMonster: Monster = { ...monster, inputs: { ...monster.inputs, defenceReductions: ZERO_DEF_REDUCTIONS } };
    if (!sequenceHasDrain(playerSteps, loadouts) && !sequenceHasHpThreshold(playerSteps)) {
      const dpDist = computeOneMonsterDP(playerSteps, loadouts, cleanMonster);
      // Compute median from DP distribution via CDF.
      let cum = 0;
      let medianTick = 0;
      for (const [tick, prob] of [...dpDist.entries()].sort((a, b) => a[0] - b[0])) {
        cum += prob;
        if (cum >= 0.5) { medianTick = tick; break; }
      }
      return { ttkDist: dpDist, monsterKillTicks: [medianTick] };
    }
  }

  // Multi-monster or drain/threshold → MC.
  // Each iteration runs all monsters in sequence with weapon cooldown carryover.
  const numPlayers = Math.max(...monsters.map((m) => m.playerSteps.length));

  // iterationNextTicks[iter][playerIdx] tracks each player's nextTick across monsters.
  let iterationNextTicks: number[][] = Array.from(
    { length: SEQUENCE_MC_ITERATIONS },
    () => new Array(numPlayers).fill(1),
  );

  const perMonsterKillTicks: number[][] = []; // [monsterIdx][iter]

  for (let mi = 0; mi < monsters.length; mi++) {
    const { monster, playerSteps } = monsters[mi];
    const cleanMonster: Monster = { ...monster, inputs: { ...monster.inputs, defenceReductions: ZERO_DEF_REDUCTIONS } };
    const { killTicks, carryoverNextTicks } = computeOneMonsterMC(
      playerSteps, loadouts, cleanMonster, iterationNextTicks,
    );
    perMonsterKillTicks.push(killTicks);
    iterationNextTicks = carryoverNextTicks;
  }

  // Final TTK = kill tick of last monster.
  const finalKillTicks = perMonsterKillTicks[perMonsterKillTicks.length - 1];
  const ttkDist = killTicksToDist(finalKillTicks);
  const monsterKillTicks = perMonsterKillTicks.map(medianKillTick);

  return { ttkDist, monsterKillTicks };
}

// ---------------------------------------------------------------------------
// Debug trace — one deterministic simulation run recorded event-by-event
// ---------------------------------------------------------------------------

/**
 * Runs a single trace iteration across all monsters in order, recording every
 * weapon swing as a SequenceSwingEvent. Used only for the debug panel.
 */
function runOneTrace(
  workerLoadout: SequenceWorkerLoadout,
  loadouts: Player[],
): SequenceSwingEvent[] {
  const trace: SequenceSwingEvent[] = [];

  // Per-player carry-over nextTick across monsters.
  const playerNextTick: number[] = [];

  for (let mi = 0; mi < workerLoadout.monsters.length; mi++) {
    const { monster, playerSteps } = workerLoadout.monsters[mi];
    const cleanMonster: Monster = { ...monster, inputs: { ...monster.inputs, defenceReductions: ZERO_DEF_REDUCTIONS } };
    const initialScaled = scaleMonster(cleanMonster);
    const defFloor = getDefenceFloor(initialScaled);
    const startHp = initialScaled.inputs.monsterCurrentHp || initialScaled.skills.hp;
    const initDef = initialScaled.skills.def;
    const initMagic = initialScaled.skills.magic;
    const initAtk = initialScaled.skills.atk;
    const initStr = initialScaled.skills.str;
    const initRanged = initialScaled.skills.ranged;

    const stepCache = new Map<string, (StepPrecomp | null)[][]>();
    const getStepsForState = (def: number, magic: number): (StepPrecomp | null)[][] => {
      const key = `${def},${magic}`;
      let cached = stepCache.get(key);
      if (!cached) {
        const m = (def === initDef && magic === initMagic)
          ? cleanMonster
          : { ...cleanMonster, skills: { ...cleanMonster.skills, def, magic } };
        const scaled = (def === initDef && magic === initMagic) ? initialScaled : scaleMonster(m);
        cached = playerSteps.map((seq) => buildSteps(seq, loadouts, m, scaled));
        stepCache.set(key, cached);
      }
      return cached;
    };

    const baseSteps = getStepsForState(initDef, initMagic);
    const initialTicks = playerNextTick.slice();
    const ps = buildInitialPlayerStates(playerSteps, baseSteps, initialTicks);

    const state: McMonsterState = {
      def: initDef, magic: initMagic, atk: initAtk, str: initStr, ranged: initRanged,
      shadowBarrageDrained: false,
    };
    let hp = startHp;
    let killed = false;

    while (!killed) {
      let t = SEQUENCE_MC_MAX_TICKS + 1;
      for (const p of ps) { if (p.nextTick < t) t = p.nextTick; }
      if (t > SEQUENCE_MC_MAX_TICKS) break;

      const steps = getStepsForState(state.def, state.magic);

      for (const p of ps) {
        if (p.nextTick !== t) continue;
        const playerStepsArr = steps[p.playerIdx];
        const step = playerStepsArr[p.stepIdx];

        if (!step) { advancePlayerStep(p, playerStepsArr, t, 1); continue; }

        const { condition } = step;

        if (condition.type === 'hp_threshold' && hp < condition.hp) {
          advancePlayerStep(p, playerStepsArr, t, step.speed);
          continue;
        }

        const hpBefore = hp;
        const defBefore = state.def;
        const damage = sampleStep(step, hp);
        if (step.drain) {
          const isHit = (step.drain.type === 'bgs' || step.drain.type === 'seercull')
            ? damage > 0
            : Math.random() < step.hitChance;
          applyDrain(step.drain, damage, isHit, state, defFloor, initDef, initAtk, initStr);
        }
        hp -= damage;

        trace.push({
          tick: t,
          playerIdx: p.playerIdx,
          monsterIdx: mi,
          weaponName: step.weaponName,
          damage,
          hpBefore,
          hpAfter: Math.max(0, hp),
          defBefore,
          defAfter: state.def,
          phase: condition.type === 'kill' ? 'kill' : 'attacks',
          isKill: hp <= 0,
        });

        if (hp <= 0) { killed = true; break; }

        if (condition.type === 'attacks') {
          p.attacksLeft--;
          if (p.attacksLeft <= 0) {
            advancePlayerStep(p, playerStepsArr, t, step.speed);
          } else {
            p.nextTick = t + step.speed;
          }
        } else if (condition.type === 'hp_threshold') {
          if (hp < condition.hp) {
            advancePlayerStep(p, playerStepsArr, t, step.speed);
          } else {
            p.nextTick = t + step.speed;
          }
        } else {
          p.nextTick = t + step.speed;
        }
      }
    }

    // Carry over per-player nextTick to the next monster.
    for (const p of ps) { playerNextTick[p.playerIdx] = p.nextTick; }
  }

  return trace;
}

// ---------------------------------------------------------------------------
// Worker handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/prefer-default-export
export const sequenceTtkDist: Handler<WorkerRequestType.COMPUTE_SEQUENCE_TTK> = async (data) => {
  const { sequenceLoadouts, loadouts } = data;

  const results = sequenceLoadouts.map((sl) => computeOneLoadout(sl, loadouts));
  const dists = results.map((r) => r.ttkDist);
  const monsterKillTicks = results.map((r) => r.monsterKillTicks);

  // Produce one debug trace from the first loadout that has any steps.
  const traceLoadout = sequenceLoadouts.find((sl) => sl.monsters.some((m) => m.playerSteps.some((p) => p.length > 0)));
  const debugTrace: SequenceSwingEvent[] = traceLoadout ? runOneTrace(traceLoadout, loadouts) : [];

  return { dists, debugTrace, monsterKillTicks };
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
