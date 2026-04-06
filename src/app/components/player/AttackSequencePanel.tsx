import React, { useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';
import { useStore } from '@/state';
import NumberInput from '@/app/components/generic/NumberInput';
import Toggle from '@/app/components/generic/Toggle';
import { AttackSequenceStep, SequenceStepCondition } from '@/types/State';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import { INFINITE_HEALTH_MONSTERS, SECONDS_PER_TICK } from '@/lib/constants';
import { Player } from '@/types/Player';
import { Monster } from '@/types/Monster';
import { IconPlus, IconSwords, IconTrash } from '@tabler/icons-react';

const MAX_STEPS = 10;

type ConditionType = SequenceStepCondition['type'];

interface SequenceTtkResult {
  ttk: number;
  ticks: number;
}

function computeSequenceTtk(
  sequence: AttackSequenceStep[],
  loadouts: Player[],
  monster: Monster,
): SequenceTtkResult | string | null {
  if (sequence.length === 0) return null;

  const hasKillStep = sequence.some((s) => s.condition.type === 'kill');
  if (!hasKillStep) {
    return 'Add a final "Until killed" step to see estimated TTK.';
  }

  const startHp = (monster.inputs?.monsterCurrentHp && monster.inputs.monsterCurrentHp <= monster.skills.hp)
    ? monster.inputs.monsterCurrentHp
    : monster.skills.hp;

  let remainingHp = startHp;
  let totalTicks = 0;

  for (const step of sequence) {
    const player = loadouts[step.loadoutIndex];
    if (!player) return 'Invalid loadout in sequence.';

    if (step.condition.type === 'attacks') {
      const baseCalc = new PlayerVsNPCCalc(toJS(player), toJS(monster), { loadoutName: 'seq' });
      const activeCalc = step.useSpec ? (baseCalc.getSpecCalc() ?? baseCalc) : baseCalc;
      const expectedDmg = activeCalc.getDistribution().getExpectedDamage();
      const speed = activeCalc.getExpectedAttackSpeed();
      if (expectedDmg <= 0) return 'Expected damage is 0 — check your loadout.';
      remainingHp -= expectedDmg * step.condition.count;
      totalTicks += speed * step.condition.count;
    } else if (step.condition.type === 'hp_threshold') {
      const target = step.condition.hp;
      if (remainingHp <= target) continue;
      const baseCalc = new PlayerVsNPCCalc(toJS(player), toJS(monster), { loadoutName: 'seq' });
      const activeCalc = step.useSpec ? (baseCalc.getSpecCalc() ?? baseCalc) : baseCalc;
      const expectedDmg = activeCalc.getDistribution().getExpectedDamage();
      const speed = activeCalc.getExpectedAttackSpeed();
      if (expectedDmg <= 0) return 'Expected damage is 0 — check your loadout.';
      const hpToChip = remainingHp - target;
      totalTicks += speed * (hpToChip / expectedDmg);
      remainingHp = target;
    } else if (step.condition.type === 'kill') {
      if (remainingHp <= 0) break;
      const currentHp = Math.max(1, Math.round(remainingHp));
      const monsterWithHp = {
        ...toJS(monster),
        inputs: { ...toJS(monster.inputs), monsterCurrentHp: currentHp },
      };
      const killCalc = new PlayerVsNPCCalc(toJS(player), monsterWithHp, {
        loadoutName: 'seq-kill',
        usingSpecialAttack: step.useSpec,
      });
      totalTicks += killCalc.getHtk() * killCalc.getExpectedAttackSpeed();
      remainingHp = 0;
      break;
    }
  }

  if (remainingHp > 0) {
    return 'The kill step was not reached.';
  }

  return { ttk: totalTicks * SECONDS_PER_TICK, ticks: Math.round(totalTicks) };
}

const CONDITION_LABELS: Record<ConditionType, string> = {
  attacks: 'For N attacks',
  hp_threshold: 'Until HP below',
  kill: 'Until killed',
};

const defaultStep = (loadoutIndex: number): AttackSequenceStep => ({
  loadoutIndex,
  useSpec: false,
  condition: { type: 'attacks', count: 1 },
});

const AttackSequencePanel: React.FC = observer(() => {
  const store = useStore();
  const { prefs, loadouts, monster } = store;

  const { attackSequenceEnabled, attackSequence: sequence } = prefs;
  const isInfiniteHealth = INFINITE_HEALTH_MONSTERS.includes(monster.id);

  const result = useMemo(
    () => (isInfiniteHealth || !attackSequenceEnabled
      ? null
      : computeSequenceTtk(sequence, toJS(loadouts), toJS(monster))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sequence, loadouts, monster, isInfiniteHealth, attackSequenceEnabled],
  );

  const updateSequence = (newSeq: AttackSequenceStep[]) => {
    store.updatePreferences({ attackSequence: newSeq });
  };

  const addStep = () => {
    if (sequence.length >= MAX_STEPS) return;
    updateSequence([...sequence, defaultStep(0)]);
  };

  const removeStep = (index: number) => {
    updateSequence(sequence.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, partial: Partial<AttackSequenceStep>) => {
    updateSequence(sequence.map((step, i) => (i === index ? { ...step, ...partial } : step)));
  };

  const updateConditionType = (index: number, type: ConditionType) => {
    let condition: SequenceStepCondition;
    if (type === 'attacks') condition = { type: 'attacks', count: 1 };
    else if (type === 'hp_threshold') condition = { type: 'hp_threshold', hp: Math.floor(monster.skills.hp / 2) };
    else condition = { type: 'kill' };
    updateStep(index, { condition });
  };

  const formatTtk = (seconds: number) => {
    const ticks = Math.round(seconds / SECONDS_PER_TICK);
    return `${seconds.toFixed(1)}s (${ticks} ticks)`;
  };

  return (
    <div className="px-6 my-4 flex flex-col gap-3">
      {/* Enable toggle */}
      <Toggle
        checked={attackSequenceEnabled}
        setChecked={(c) => store.updatePreferences({ attackSequenceEnabled: c })}
        label={(
          <>
            <IconSwords size={16} className="inline-block align-text-bottom mr-1" />
            Enable attack sequence
          </>
        )}
      />

      {!attackSequenceEnabled ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Enable to define a rotation across loadouts and get an estimated combined TTK.
        </p>
      ) : (
        <>
          {/* Step list */}
          {sequence.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">
              No steps yet. Click &quot;Add step&quot; to begin.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {sequence.map((step, i) => {
                const condType = step.condition.type;
                return (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={i} className="flex items-center gap-1.5 flex-wrap rounded border border-body-400 dark:border-dark-200 px-2 py-1.5">
                    <span className="text-xs font-bold text-gray-400 w-4 shrink-0">{i + 1}.</span>

                    {/* Loadout selector */}
                    <select
                      className="form-control text-xs py-0.5 min-w-0"
                      value={step.loadoutIndex}
                      onChange={(e) => updateStep(i, { loadoutIndex: Number(e.target.value) })}
                    >
                      {loadouts.map((l, ix) => (
                        // eslint-disable-next-line react/no-array-index-key
                        <option key={ix} value={ix}>
                          {l.name || `Loadout ${ix + 1}`}
                        </option>
                      ))}
                    </select>

                    {/* Condition type */}
                    <select
                      className="form-control text-xs py-0.5 min-w-0"
                      value={condType}
                      onChange={(e) => updateConditionType(i, e.target.value as ConditionType)}
                    >
                      {(Object.keys(CONDITION_LABELS) as ConditionType[]).map((t) => (
                        <option key={t} value={t}>{CONDITION_LABELS[t]}</option>
                      ))}
                    </select>

                    {/* Condition value */}
                    {condType === 'attacks' && (
                      <NumberInput
                        className="form-control w-12 text-xs py-0.5"
                        min={1}
                        max={999}
                        value={(step.condition as { type: 'attacks'; count: number }).count}
                        onChange={(v) => updateStep(i, { condition: { type: 'attacks', count: v } })}
                      />
                    )}
                    {condType === 'hp_threshold' && (
                      <NumberInput
                        className="form-control w-14 text-xs py-0.5"
                        min={0}
                        max={monster.skills.hp}
                        value={(step.condition as { type: 'hp_threshold'; hp: number }).hp}
                        onChange={(v) => updateStep(i, { condition: { type: 'hp_threshold', hp: v } })}
                      />
                    )}

                    {/* Spec toggle */}
                    <label className="flex items-center gap-1 text-xs cursor-pointer ml-auto shrink-0">
                      <input
                        type="checkbox"
                        checked={step.useSpec}
                        onChange={(e) => updateStep(i, { useSpec: e.target.checked })}
                        className="cursor-pointer"
                      />
                      Spec
                    </label>

                    {/* Remove */}
                    <button
                      type="button"
                      className="text-gray-400 hover:text-red-400 transition-colors shrink-0"
                      onClick={() => removeStep(i)}
                      aria-label="Remove step"
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer: TTK result + add button */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-body-400 dark:border-dark-200">
            <div className="text-xs">
              {isInfiniteHealth && (
                <span className="text-gray-400">Monster has infinite health.</span>
              )}
              {!isInfiniteHealth && result === null && sequence.length === 0 && null}
              {!isInfiniteHealth && typeof result === 'string' && (
                <span className="text-yellow-500 dark:text-yellow-400">{result}</span>
              )}
              {!isInfiniteHealth && result !== null && typeof result !== 'string' && (
                <span className="font-bold text-green-600 dark:text-green-400">
                  Est. TTK:
                  {' '}
                  {formatTtk(result.ttk)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="form-control flex items-center gap-1 text-xs py-0.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              onClick={addStep}
              disabled={sequence.length >= MAX_STEPS}
            >
              <IconPlus size={13} />
              Add step
            </button>
          </div>
        </>
      )}
    </div>
  );
});

export default AttackSequencePanel;
