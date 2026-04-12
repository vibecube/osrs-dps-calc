import React, {
  useMemo, useRef, useState,
} from 'react';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';
import { useStore } from '@/state';
import NumberInput from '@/app/components/generic/NumberInput';
import Toggle from '@/app/components/generic/Toggle';
import {
  AttackSequenceLoadout, AttackSequenceStep, SequenceMonster, SequenceStepCondition,
} from '@/types/State';
import { INFINITE_HEALTH_MONSTERS, SECONDS_PER_TICK, BLOWPIPE_IDS } from '@/lib/constants';
import {
  IconGripVertical, IconPlus, IconSwords, IconTrash,
} from '@tabler/icons-react';
import skullKillImg from '@/public/img/misc/skull_kill.png';
import hitpointsImg from '@/public/img/bonuses/hitpoints.png';
import specialOnImg from '@/public/img/special.png';
import specialOffImg from '@/public/img/specialOff.png';
import weaponSlotImg from '@/public/img/slots/weapon.png';
import { EquipmentPiece } from '@/types/Player';
import {
  availableEquipment,
  CORRUPTED_GAUNTLET_EQUIPMENT_IDS,
  equipmentAliases,
  GAUNTLET_EQUIPMENT_IDS,
  noStatExceptions,
} from '@/lib/Equipment';
import { GAUNTLET_MONSTER_IDS, CORRUPTED_GAUNTLET_MONSTER_IDS } from '@/lib/constants';
import { getCdnImage, isDefined } from '@/utils';
import Combobox from '@/app/components/generic/Combobox';
import LazyImage from '@/app/components/generic/LazyImage';
import { cross } from 'd3-array';
import { CUSTOM_MONSTER_BASE } from '@/lib/Monsters';
import { Monster } from '@/types/Monster';

const MAX_STEPS = 10;
const MAX_PLAYERS = 8;
const MAX_SEQUENCE_LOADOUTS = 6;
const MAX_MONSTERS = 6;

type ConditionType = SequenceStepCondition['type'];

const CONDITION_TOOLTIPS: Record<ConditionType, string> = {
  attacks: 'For N attacks',
  hp_threshold: 'Until HP below',
  kill: 'Until killed',
};

const defaultStep = (loadoutIndex: number): AttackSequenceStep => ({
  loadoutIndex,
  useSpec: false,
  condition: { type: 'attacks', count: 1 },
});

/** Round seconds to the nearest tick, rounding down on ties. */
function roundToTick(seconds: number): number {
  const ticks = Math.ceil(seconds / SECONDS_PER_TICK - 0.5);
  return Math.max(0, ticks) * SECONDS_PER_TICK;
}

// ---- Weapon option types ----
interface WeaponOption {
  label: string;
  value: string;
  version: string;
  slot: string;
  equipment: EquipmentPiece;
}

const findDart = (name: string): EquipmentPiece | undefined => availableEquipment.find((e) => e.name === name);
const DARTS: EquipmentPiece[] = [
  'Bronze dart', 'Iron dart', 'Steel dart', 'Mithril dart',
  'Adamant dart', 'Rune dart', 'Black dart', 'Dragon dart', 'Amethyst dart',
].map(findDart).filter(isDefined) as EquipmentPiece[];

const DART_TIER: Record<string, number> = {
  'Bronze dart': 0, 'Iron dart': 1, 'Steel dart': 2, 'Black dart': 3,
  'Mithril dart': 4, 'Adamant dart': 5, 'Rune dart': 6, 'Amethyst dart': 7, 'Dragon dart': 8,
};
const MAX_DART_TIER_BY_BLOWPIPE: Record<string, number> = {
  'Camphor blowpipe': DART_TIER['Mithril dart'],
  'Ironwood blowpipe': DART_TIER['Adamant dart'],
  'Rosewood blowpipe': DART_TIER['Adamant dart'],
};

function buildWeaponOptions(monsterId: number): WeaponOption[] {
  const blowpipeEntries: WeaponOption[] = [];
  const entries: WeaponOption[] = [];

  for (const v of availableEquipment.filter((eq) => {
    if (eq.slot !== 'weapon') return false;
    if (
      (
        Object.values(eq.bonuses).every((val) => val === 0)
        && Object.values(eq.offensive).every((val) => val === 0)
        && Object.values(eq.defensive).every((val) => val === 0)
        && (eq.speed === 4 || eq.speed <= 0)
        && !noStatExceptions.includes(eq.name)
      )
      || eq.version.match(/^(Broken|Inactive|Locked)$/)
      || eq.name.match(/\((Last Man Standing|historical|beta)\)$/)
      || eq.name.match(/(Fine mesh net|Wilderness champion amulet|\(Wilderness Wars)/)
      || eq.name.match(/^Crystal .* \(i\)$/)
    ) return false;
    return true;
  })) {
    const e: WeaponOption = {
      label: v.name,
      value: v.id.toString(),
      version: v.version || '',
      slot: v.slot,
      equipment: v,
    };
    if (BLOWPIPE_IDS.includes(v.id)) blowpipeEntries.push(e);
    else entries.push(e);
  }

  cross(blowpipeEntries, DARTS)
    .filter(([blowpipe, dart]) => {
      const maxTier = MAX_DART_TIER_BY_BLOWPIPE[blowpipe.label];
      if (maxTier === undefined) return true;
      const dartTier = DART_TIER[dart.name];
      if (dartTier === undefined) return true;
      return dartTier <= maxTier;
    })
    .forEach(([blowpipe, dart]) => {
      entries.push({
        ...blowpipe,
        label: `${blowpipe.label} (${dart.name.replace(' dart', '')})`,
        value: `${blowpipe.value}_${dart.id}`,
        equipment: { ...blowpipe.equipment, itemVars: { blowpipeDartName: dart.name, blowpipeDartId: dart.id } },
      });
    });

  const gauntletSort = (items: WeaponOption[]) => {
    if (GAUNTLET_MONSTER_IDS.includes(monsterId)) {
      return items.sort((a, b) => {
        const ap = GAUNTLET_EQUIPMENT_IDS.includes(a.equipment.id);
        const bp = GAUNTLET_EQUIPMENT_IDS.includes(b.equipment.id);
        if (ap && !bp) return -1;
        if (!ap && bp) return 1;
        return a.label.localeCompare(b.label);
      });
    }
    if (CORRUPTED_GAUNTLET_MONSTER_IDS.includes(monsterId)) {
      return items.sort((a, b) => {
        const ap = CORRUPTED_GAUNTLET_EQUIPMENT_IDS.includes(a.equipment.id);
        const bp = CORRUPTED_GAUNTLET_EQUIPMENT_IDS.includes(b.equipment.id);
        if (ap && !bp) return -1;
        if (!ap && bp) return 1;
        return a.label.localeCompare(b.label);
      });
    }
    return items.sort((a, b) => {
      const ap = GAUNTLET_EQUIPMENT_IDS.includes(a.equipment.id) || CORRUPTED_GAUNTLET_EQUIPMENT_IDS.includes(a.equipment.id);
      const bp = GAUNTLET_EQUIPMENT_IDS.includes(b.equipment.id) || CORRUPTED_GAUNTLET_EQUIPMENT_IDS.includes(b.equipment.id);
      if (ap && !bp) return 1;
      if (!ap && bp) return -1;
      return a.label.localeCompare(b.label);
    });
  };

  return gauntletSort(entries);
}

// ---- Weapon picker ----
interface WeaponPickerProps {
  monsterId: number;
  currentOverride: EquipmentPiece | null | undefined;
  onSelect: (weapon: EquipmentPiece) => void;
  onClear: () => void;
}

const WeaponPicker: React.FC<WeaponPickerProps> = ({
  monsterId, currentOverride, onSelect, onClear,
}) => {
  const options = useMemo(() => buildWeaponOptions(monsterId), [monsterId]);

  const variantFilter = (v: WeaponOption[]) => {
    const remainingVariantGroups: { [k: number]: number[] } = {};
    const remainingVariantMemberships: { [k: number]: number } = {};
    for (const eqOpt of v) {
      const eqId = eqOpt.equipment.id;
      for (const [base, vars] of Object.entries(equipmentAliases)) {
        const baseId = parseInt(base);
        if (baseId === eqId || vars.includes(eqId)) {
          remainingVariantGroups[baseId] = remainingVariantGroups[baseId] ? [...remainingVariantGroups[baseId], eqId] : [eqId];
          remainingVariantMemberships[eqId] = baseId;
        }
      }
    }
    return v.filter((eqOpt) => {
      const eqId = eqOpt.equipment.id;
      const baseId: number | undefined = remainingVariantMemberships[eqId];
      if (baseId === eqId) return true;
      if (baseId !== undefined) {
        const group = remainingVariantGroups[baseId];
        if (group.includes(eqId)) return group.indexOf(eqId) === 0 && !v.find((o) => o.equipment.id === baseId);
      }
      return true;
    });
  };

  return (
    <div className="mt-1.5 pt-1.5 border-t border-body-400 dark:border-dark-200 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <Combobox<WeaponOption>
          id="weapon-override-select"
          className="w-full"
          items={options}
          value={currentOverride?.name}
          placeholder="Search for weapon override..."
          resetAfterSelect={false}
          blurAfterSelect
          onSelectedItemChange={(item) => { if (item) onSelect(item.equipment); }}
          CustomItemComponent={({ item, itemString }) => (
            <div className="flex items-center gap-2">
              <div className="basis-4 flex justify-center h-[20px] w-auto">
                {item.equipment.image && (
                  <LazyImage responsive src={getCdnImage(`equipment/${item.equipment.image}`)} alt="" />
                )}
              </div>
              <div>
                {itemString}
                {item.version && (
                  <span className="text-xs text-gray-400 dark:text-gray-300">#{item.version}</span>
                )}
              </div>
            </div>
          )}
          customFilter={(v) => variantFilter(v)}
          customSort={(v) => {
            const gs = buildWeaponOptions(monsterId);
            return v.sort((a, b) => gs.findIndex((x) => x.value === a.value) - gs.findIndex((x) => x.value === b.value));
          }}
        />
      </div>
      {currentOverride && (
        <button
          type="button"
          className="text-xs text-gray-400 hover:text-red-400 transition-colors shrink-0"
          onClick={onClear}
        >
          Clear
        </button>
      )}
    </div>
  );
};

// ---- Monster option for inline search ----
interface MonsterOption {
  label: string;
  value: number; // monster id
  version: string;
  monster: Omit<Monster, 'inputs'>;
}

// ---- Step list sub-component ----
interface StepListProps {
  sequence: AttackSequenceStep[];
  loadouts: ReturnType<typeof useStore>['loadouts'];
  monsterHp: number;
  monsterId: number;
  onUpdateSequence: (seq: AttackSequenceStep[]) => void;
}

const StepList: React.FC<StepListProps> = observer(({
  sequence, loadouts, monsterHp, monsterId, onUpdateSequence,
}) => {
  const [weaponPickerStep, setWeaponPickerStep] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);
  const dragBlocked = useRef(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const removeStep = (index: number) => {
    if (weaponPickerStep === index) setWeaponPickerStep(null);
    onUpdateSequence(sequence.filter((_, i) => i !== index));
  };

  const moveStep = (from: number, to: number) => {
    const newSeq = [...sequence];
    const [moved] = newSeq.splice(from, 1);
    newSeq.splice(to, 0, moved);
    onUpdateSequence(newSeq);
    if (weaponPickerStep === from) setWeaponPickerStep(to);
  };

  const updateStep = (index: number, partial: Partial<AttackSequenceStep>) => {
    onUpdateSequence(sequence.map((step, i) => (i === index ? { ...step, ...partial } : step)));
  };

  const updateConditionType = (index: number, type: ConditionType) => {
    let condition: SequenceStepCondition;
    if (type === 'attacks') condition = { type: 'attacks', count: 1 };
    else if (type === 'hp_threshold') condition = { type: 'hp_threshold', hp: Math.floor(monsterHp / 2) };
    else condition = { type: 'kill' };
    updateStep(index, { condition });
  };

  const onDragStart = (i: number) => { dragIndex.current = i; };
  const onDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOverIndex(i); };
  const onDrop = (e: React.DragEvent, i: number) => {
    e.preventDefault();
    if (dragIndex.current !== null && dragIndex.current !== i) moveStep(dragIndex.current, i);
    dragIndex.current = null;
    setDragOverIndex(null);
  };
  const onDragEnd = () => { dragIndex.current = null; setDragOverIndex(null); };

  if (sequence.length === 0) {
    return (
      <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">
        No steps yet. Click &quot;Add step&quot; to begin.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sequence.map((step, i) => {
        const condType = step.condition.type;
        const isDragOver = dragOverIndex === i;
        const hasOverride = step.weaponOverride !== undefined;
        const overrideWeapon = step.weaponOverride ?? null;
        const loadoutWeapon = loadouts[step.loadoutIndex]?.equipment?.weapon ?? null;
        const displayWeapon = hasOverride ? overrideWeapon : loadoutWeapon;
        const isPickerOpen = weaponPickerStep === i;

        return (
          // eslint-disable-next-line react/no-array-index-key
          <div
            key={i}
            draggable
            onMouseDown={(e) => {
              dragBlocked.current = !!(e.target as HTMLElement).closest('input, select, textarea');
            }}
            onDragStart={(e) => {
              if (dragBlocked.current) { e.preventDefault(); return; }
              onDragStart(i);
            }}
            onDragOver={(e) => onDragOver(e, i)}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={onDragEnd}
            className={`rounded border px-2 py-1.5 transition-colors ${
              isDragOver
                ? 'border-orange-400 bg-orange-400/10'
                : 'border-body-400 dark:border-dark-200'
            }`}
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-gray-500 cursor-grab active:cursor-grabbing shrink-0">
                <IconGripVertical size={14} />
              </span>

              <span className="text-xs font-bold text-gray-400 w-4 shrink-0">{i + 1}.</span>

              {/* Loadout badge */}
              <button
                type="button"
                className="shrink-0 flex items-center justify-center w-[26px] h-[26px] rounded bg-body-100 dark:bg-dark-400 border border-body-300 dark:border-dark-300 text-xs font-bold text-white hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
                onClick={() => updateStep(i, { loadoutIndex: (step.loadoutIndex + 1) % loadouts.length })}
                disabled={loadouts.length <= 1}
                title={loadouts[step.loadoutIndex]?.name || `Loadout ${step.loadoutIndex + 1}`}
                aria-label="Cycle loadout"
              >
                {step.loadoutIndex + 1}
              </button>

              {/* Weapon override button */}
              <button
                type="button"
                className={`shrink-0 relative flex items-center justify-center w-[26px] h-[26px] rounded border transition-colors ${
                  hasOverride
                    ? 'border-orange-400 bg-orange-400/10 hover:bg-orange-400/20'
                    : 'border-body-400 dark:border-dark-300 hover:border-gray-400 dark:hover:border-gray-500 bg-body-100 dark:bg-dark-400'
                } ${isPickerOpen ? 'ring-1 ring-orange-400' : ''}`}
                onClick={() => setWeaponPickerStep(isPickerOpen ? null : i)}
                title={hasOverride ? `Weapon override: ${overrideWeapon?.name}` : 'Click to override weapon for this step'}
                aria-label="Toggle weapon override"
              >
                {displayWeapon?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={getCdnImage(`equipment/${displayWeapon.image}`)}
                    alt={displayWeapon.name}
                    className={`max-w-[20px] max-h-[20px] ${!hasOverride ? 'opacity-40' : ''}`}
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={weaponSlotImg.src}
                    alt="weapon slot"
                    className="w-[16px] h-[16px] opacity-25 dark:filter dark:invert"
                  />
                )}
                {hasOverride && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400" />
                )}
              </button>

              {/* Condition type toggle */}
              <div className="flex shrink-0 rounded overflow-hidden border border-body-400 dark:border-dark-300">
                {(['attacks', 'hp_threshold', 'kill'] as ConditionType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`flex items-center justify-center w-[26px] h-[26px] transition-colors ${
                      condType === t
                        ? 'bg-orange-500 dark:bg-orange-600 text-white'
                        : 'bg-body-100 dark:bg-dark-400 text-gray-400 hover:text-white hover:bg-body-200 dark:hover:bg-dark-300'
                    }`}
                    onClick={() => updateConditionType(i, t)}
                    data-tooltip-id="tooltip"
                    data-tooltip-content={CONDITION_TOOLTIPS[t]}
                    aria-label={CONDITION_TOOLTIPS[t]}
                  >
                    {t === 'attacks' && <span className="text-xs font-bold leading-none">#</span>}
                    {t === 'hp_threshold' && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={hitpointsImg.src} alt="HP" className="w-[14px] h-[14px]" />
                    )}
                    {t === 'kill' && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={skullKillImg.src} alt="Until killed" className="w-[14px] h-[14px]" />
                    )}
                  </button>
                ))}
              </div>

              {condType === 'attacks' && (
                <NumberInput
                  className="form-control w-10 text-xs py-0.5"
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
                  max={monsterHp}
                  value={(step.condition as { type: 'hp_threshold'; hp: number }).hp}
                  onChange={(v) => updateStep(i, { condition: { type: 'hp_threshold', hp: v } })}
                />
              )}

              {/* Spec icon */}
              <button
                type="button"
                className="ml-auto shrink-0 opacity-80 hover:opacity-100 transition-opacity"
                onClick={() => updateStep(i, { useSpec: !step.useSpec })}
                title={step.useSpec ? 'Spec: ON' : 'Spec: OFF'}
                aria-label={step.useSpec ? 'Disable spec' : 'Enable spec'}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={step.useSpec ? specialOnImg.src : specialOffImg.src}
                  alt={step.useSpec ? 'Spec on' : 'Spec off'}
                  width={22}
                  height={22}
                />
              </button>

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

            {isPickerOpen && (
              <WeaponPicker
                monsterId={monsterId}
                currentOverride={overrideWeapon}
                onSelect={(weapon) => {
                  updateStep(i, { weaponOverride: weapon });
                  setWeaponPickerStep(null);
                }}
                onClear={() => {
                  updateStep(i, { weaponOverride: undefined });
                  setWeaponPickerStep(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

// ---- Monster section header ----
interface MonsterSectionProps {
  monsterIdx: number;
  sequenceMonster: SequenceMonster;
  resolvedMonster: Omit<Monster, 'inputs'> | undefined;
  monsterOptions: MonsterOption[];
  canRemove: boolean;
  canAdd: boolean;
  onChangeMonster: (monsterId: number) => void;
  onChangeStartingHp: (hp: number | undefined) => void;
  onAdd: () => void;
  onRemove: () => void;
}

const MonsterSection: React.FC<MonsterSectionProps> = ({
  monsterIdx,
  sequenceMonster,
  resolvedMonster,
  monsterOptions,
  canRemove,
  canAdd,
  onChangeMonster,
  onChangeStartingHp,
  onAdd,
  onRemove,
}) => {
  const [hpOpen, setHpOpen] = useState(false);
  const maxHp = resolvedMonster?.skills.hp ?? 1000;
  const currentHp = sequenceMonster.startingHp ?? maxHp;

  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-1">
      {/* Monster number badge */}
      <span className="text-xs font-bold text-gray-400 shrink-0">
        {`M${monsterIdx + 1}`}
      </span>

      {/* Monster search */}
      <div className="flex-1 min-w-0">
        <Combobox<MonsterOption>
          id={`seq-monster-select-${monsterIdx}`}
          className="w-full"
          items={monsterOptions}
          value={resolvedMonster ? `${resolvedMonster.name}${resolvedMonster.version ? ` #${resolvedMonster.version}` : ''}` : ''}
          placeholder="Search for monster..."
          resetAfterSelect={false}
          blurAfterSelect
          customFilter={(items, iv) => {
            if (!iv) return items;
            return items.filter((item) => item.value !== -1);
          }}
          onSelectedItemChange={(item) => {
            if (item && item.value !== -1) onChangeMonster(item.value);
          }}
          CustomItemComponent={({ item }) => {
            if (item.value === -1) return null;
            return (
              <div>
                {item.label}
                {item.version && (
                  <span className="text-xs text-gray-400 dark:text-gray-300">#{item.version}</span>
                )}
              </div>
            );
          }}
        />
      </div>

      {/* HP override button */}
      <div className="relative">
        <button
          type="button"
          className={`shrink-0 flex items-center justify-center w-[26px] h-[26px] rounded border transition-colors ${
            sequenceMonster.startingHp !== undefined
              ? 'border-orange-400 bg-orange-400/10 hover:bg-orange-400/20'
              : 'border-body-400 dark:border-dark-300 hover:border-gray-400 dark:hover:border-gray-500 bg-body-100 dark:bg-dark-400'
          } ${hpOpen ? 'ring-1 ring-orange-400' : ''}`}
          onClick={() => setHpOpen((o) => !o)}
          title={sequenceMonster.startingHp !== undefined ? `Starting HP: ${sequenceMonster.startingHp}` : 'Click to override starting HP'}
          aria-label="Toggle HP override"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={hitpointsImg.src} alt="HP" className="w-[14px] h-[14px]" />
          {sequenceMonster.startingHp !== undefined && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400" />
          )}
        </button>
        {hpOpen && (
          <div className="absolute right-0 top-8 z-10 bg-white dark:bg-dark-400 border border-body-300 dark:border-dark-300 rounded shadow-lg p-2 flex items-center gap-2 min-w-[140px]">
            <span className="text-xs text-gray-400 shrink-0">Start HP</span>
            <NumberInput
              className="form-control w-16 text-xs py-0.5"
              min={1}
              max={maxHp}
              value={currentHp}
              onChange={(v) => onChangeStartingHp(v >= maxHp ? undefined : v)}
            />
            {sequenceMonster.startingHp !== undefined && (
              <button
                type="button"
                className="text-xs text-gray-400 hover:text-red-400 shrink-0"
                onClick={() => { onChangeStartingHp(undefined); setHpOpen(false); }}
              >
                Reset
              </button>
            )}
          </div>
        )}
      </div>

      {canRemove && (
        <button
          type="button"
          className="shrink-0 text-gray-400 hover:text-red-400 transition-colors"
          onClick={onRemove}
          aria-label={`Remove monster ${monsterIdx + 1}`}
        >
          <IconTrash size={14} />
        </button>
      )}

      {canAdd && (
        <button
          type="button"
          className="shrink-0 flex items-center justify-center w-[26px] h-[26px] rounded border border-body-300 dark:border-dark-300 text-gray-400 hover:text-white hover:border-gray-400 dark:hover:border-gray-500 bg-body-100 dark:bg-dark-400 transition-colors"
          onClick={onAdd}
          aria-label="Add monster"
          title="Add next monster"
        >
          <IconPlus size={13} />
        </button>
      )}
    </div>
  );
};

// ---- Main panel ----
const AttackSequencePanel: React.FC = observer(() => {
  const store = useStore();
  const { prefs, loadouts, monster } = store;

  const {
    attackSequenceEnabled,
    attackSequenceLoadouts,
    attackSequenceActiveLoadout,
    attackSequenceTargetTtkSeconds: targetTtkSeconds,
  } = prefs;

  const isInfiniteHealth = INFINITE_HEALTH_MONSTERS.includes(monster.id);
  const sequenceTtkDists = toJS(store.calc.sequenceTtkDists);

  const [targetInput, setTargetInput] = useState<string>(() => parseFloat(targetTtkSeconds.toFixed(10)).toString());
  const [editingLoadoutIdx, setEditingLoadoutIdx] = useState<number | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  const activeLoadoutIdx = Math.min(attackSequenceActiveLoadout, attackSequenceLoadouts.length - 1);
  const activeLoadout: AttackSequenceLoadout = attackSequenceLoadouts[activeLoadoutIdx] ?? {
    name: 'Sequence 1',
    monsters: [{ monsterId: monster.id }],
    playerSteps: [[[]]],
    activePlayer: 0,
    activeMonster: 0,
  };
  const activePlayerIdx = Math.min(activeLoadout.activePlayer, (activeLoadout.playerSteps?.length ?? 1) - 1);
  const playerSteps = activeLoadout.playerSteps ?? [[[]]];

  // Monster options for the inline combobox
  const monsterOptions: MonsterOption[] = useMemo(() => [
    ...store.availableMonsters.map((m) => ({
      label: m.name,
      value: m.id,
      version: m.version || '',
      monster: m,
    })),
  ], [store.availableMonsters]);

  const commitTarget = (raw: string) => {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const rounded = roundToTick(parsed);
    store.updatePreferences({ attackSequenceTargetTtkSeconds: rounded });
    setTargetInput(parseFloat(rounded.toFixed(10)).toString());
  };

  const hasKillStep = useMemo(
    () => attackSequenceLoadouts.some((sl) => sl.playerSteps?.flat(2).some((s) => s.condition.type === 'kill')),
    [attackSequenceLoadouts],
  );

  const chanceWithinTarget = useMemo(() => {
    const dist = sequenceTtkDists?.[activeLoadoutIdx];
    if (!dist || dist.size === 0) return null;
    const targetTicks = Math.round(targetTtkSeconds / SECONDS_PER_TICK);
    let cumulative = 0;
    for (const [tick, prob] of dist) {
      if (tick <= targetTicks) cumulative += prob;
    }
    return cumulative * 100;
  }, [sequenceTtkDists, activeLoadoutIdx, targetTtkSeconds]);

  // --- Sequence loadout helpers ---
  const updateActiveLoadout = (partial: Partial<AttackSequenceLoadout>) => {
    const newLoadouts = attackSequenceLoadouts.map((sl, i) => (i === activeLoadoutIdx ? { ...sl, ...partial } : sl));
    store.updatePreferences({ attackSequenceLoadouts: newLoadouts });
  };

  const addSequenceLoadout = () => {
    if (attackSequenceLoadouts.length >= MAX_SEQUENCE_LOADOUTS) return;
    // Copy monsters from the active loadout but start with empty steps.
    const srcMonsters = activeLoadout.monsters ?? [{ monsterId: monster.id }];
    const newLoadout: AttackSequenceLoadout = {
      name: `Sequence ${attackSequenceLoadouts.length + 1}`,
      monsters: srcMonsters.map((m) => ({ ...m })),
      playerSteps: [srcMonsters.map(() => [])],
      activePlayer: 0,
      activeMonster: 0,
    };
    const newLoadouts = [...attackSequenceLoadouts, newLoadout];
    store.updatePreferences({ attackSequenceLoadouts: newLoadouts, attackSequenceActiveLoadout: newLoadouts.length - 1 });
  };

  const removeSequenceLoadout = (idx: number) => {
    if (attackSequenceLoadouts.length <= 1) return;
    const newLoadouts = attackSequenceLoadouts.filter((_, i) => i !== idx);
    const newActive = Math.min(attackSequenceActiveLoadout, newLoadouts.length - 1);
    store.updatePreferences({ attackSequenceLoadouts: newLoadouts, attackSequenceActiveLoadout: newActive });
  };

  const startEditingName = (idx: number) => {
    setEditingLoadoutIdx(idx);
    setEditingName(attackSequenceLoadouts[idx].name);
  };

  const commitName = () => {
    if (editingLoadoutIdx === null) return;
    const trimmed = editingName.trim() || `Sequence ${editingLoadoutIdx + 1}`;
    const newLoadouts = attackSequenceLoadouts.map((sl, i) => (i === editingLoadoutIdx ? { ...sl, name: trimmed } : sl));
    store.updatePreferences({ attackSequenceLoadouts: newLoadouts });
    setEditingLoadoutIdx(null);
  };

  // --- Player helpers ---
  const updatePlayerMonsterSteps = (playerIdx: number, monsterIdx: number, newSeq: AttackSequenceStep[]) => {
    const newPlayerSteps = playerSteps.map((seqs, pi) => (pi === playerIdx
      ? seqs.map((s, mi) => (mi === monsterIdx ? newSeq : s))
      : seqs));
    updateActiveLoadout({ playerSteps: newPlayerSteps });
  };

  const addPlayer = () => {
    if (playerSteps.length >= MAX_PLAYERS) return;
    const monsterCount = activeLoadout.monsters?.length ?? 1;
    const newPlayerSteps = [...playerSteps, Array.from({ length: monsterCount }, () => [] as AttackSequenceStep[])];
    updateActiveLoadout({ playerSteps: newPlayerSteps, activePlayer: newPlayerSteps.length - 1 });
  };

  const removePlayer = (playerIdx: number) => {
    if (playerSteps.length <= 1) return;
    const newPlayerSteps = playerSteps.filter((_, i) => i !== playerIdx);
    const newActive = Math.min(activeLoadout.activePlayer, newPlayerSteps.length - 1);
    updateActiveLoadout({ playerSteps: newPlayerSteps, activePlayer: newActive });
  };

  // --- Monster helpers ---
  const addMonster = () => {
    const currentMonsters = activeLoadout.monsters ?? [{ monsterId: monster.id }];
    if (currentMonsters.length >= MAX_MONSTERS) return;
    const newMonsters = [...currentMonsters, { monsterId: monster.id }];
    const newPlayerSteps = playerSteps.map((seqs) => [...seqs, []]);
    updateActiveLoadout({ monsters: newMonsters, playerSteps: newPlayerSteps });
  };

  const removeMonster = (monsterIdx: number) => {
    const currentMonsters = activeLoadout.monsters ?? [];
    if (currentMonsters.length <= 1) return;
    const newMonsters = currentMonsters.filter((_, i) => i !== monsterIdx);
    const newPlayerSteps = playerSteps.map((seqs) => seqs.filter((_, i) => i !== monsterIdx));
    const newActiveMonster = Math.min(activeLoadout.activeMonster ?? 0, newMonsters.length - 1);
    updateActiveLoadout({ monsters: newMonsters, playerSteps: newPlayerSteps, activeMonster: newActiveMonster });
  };

  const updateMonsterInLoadout = (monsterIdx: number, patch: Partial<SequenceMonster>) => {
    const currentMonsters = activeLoadout.monsters ?? [];
    const newMonsters = currentMonsters.map((m, i) => (i === monsterIdx ? { ...m, ...patch } : m));
    updateActiveLoadout({ monsters: newMonsters });
  };

  const monsters = activeLoadout.monsters ?? [{ monsterId: monster.id }];

  return (
    <div className="px-6 my-4 flex flex-col gap-3">
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
          {/* Target TTK + % chance */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400 shrink-0">Target TTK</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step="any"
                className="form-control w-20 text-xs py-0.5"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onBlur={(e) => commitTarget(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitTarget((e.target as HTMLInputElement).value); }}
              />
              <span className="text-xs text-gray-400">s</span>
            </div>
            {isInfiniteHealth && <span className="text-xs text-gray-400">Monster has infinite health.</span>}
            {!isInfiniteHealth && !hasKillStep && attackSequenceLoadouts.some((sl) => sl.playerSteps?.flat(2).length > 0) && (
              <span className="text-xs text-yellow-500 dark:text-yellow-400">
                Add an &quot;Until killed&quot; step to see % chance.
              </span>
            )}
            {!isInfiniteHealth && hasKillStep && sequenceTtkDists === undefined && (
              <span className="text-xs text-gray-400">Computing…</span>
            )}
            {!isInfiniteHealth && hasKillStep && chanceWithinTarget !== null && (
              <span className="text-xs font-bold text-green-600 dark:text-green-400">
                {chanceWithinTarget.toFixed(1)}
                {'% within '}
                {targetTtkSeconds}
                s
              </span>
            )}
          </div>

          {/* Sequence loadout tabs */}
          <div className="flex items-center gap-1 flex-wrap border-b border-body-400 dark:border-dark-200 pb-2">
            {attackSequenceLoadouts.map((sl, si) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={si} className="relative group">
                {editingLoadoutIdx === si ? (
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    type="text"
                    className="h-[26px] px-1.5 text-xs rounded border border-orange-400 bg-body-100 dark:bg-dark-400 text-white outline-none w-24"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingLoadoutIdx(null); }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => store.updatePreferences({ attackSequenceActiveLoadout: si })}
                    onDoubleClick={() => startEditingName(si)}
                    onContextMenu={(e) => { e.preventDefault(); startEditingName(si); }}
                    className={`flex items-center justify-center h-[26px] px-2 rounded text-xs font-bold transition-colors max-w-[96px] truncate ${
                      si === activeLoadoutIdx
                        ? 'bg-orange-500 dark:bg-orange-600 text-white'
                        : 'bg-body-100 dark:bg-dark-400 border border-body-300 dark:border-dark-300 text-gray-400 hover:text-white hover:border-gray-400 dark:hover:border-gray-500'
                    }`}
                    title={`${sl.name} (double-click or right-click to rename)`}
                  >
                    {sl.name}
                  </button>
                )}
                {attackSequenceLoadouts.length > 1 && editingLoadoutIdx !== si && (
                  <button
                    type="button"
                    onClick={() => removeSequenceLoadout(si)}
                    aria-label={`Remove ${sl.name}`}
                    className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[9px] leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {attackSequenceLoadouts.length < MAX_SEQUENCE_LOADOUTS && (
              <button
                type="button"
                onClick={addSequenceLoadout}
                aria-label="Add sequence"
                className="flex items-center justify-center w-[26px] h-[26px] rounded border border-body-300 dark:border-dark-300 text-gray-400 hover:text-white hover:border-gray-400 dark:hover:border-gray-500 bg-body-100 dark:bg-dark-400 transition-colors"
              >
                <IconPlus size={13} />
              </button>
            )}
          </div>

          {/* Player tabs */}
          <div className="flex items-center gap-1 flex-wrap">
            {playerSteps.map((_, pi) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={pi} className="relative group">
                <button
                  type="button"
                  onClick={() => updateActiveLoadout({ activePlayer: pi })}
                  className={`flex items-center justify-center min-w-[32px] h-[26px] px-2 rounded text-xs font-bold transition-colors ${
                    pi === activePlayerIdx
                      ? 'bg-orange-500 dark:bg-orange-600 text-white'
                      : 'bg-body-100 dark:bg-dark-400 border border-body-300 dark:border-dark-300 text-gray-400 hover:text-white hover:border-gray-400 dark:hover:border-gray-500'
                  }`}
                >
                  {`P${pi + 1}`}
                </button>
                {playerSteps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removePlayer(pi)}
                    aria-label={`Remove P${pi + 1}`}
                    className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[9px] leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {playerSteps.length < MAX_PLAYERS && (
              <button
                type="button"
                onClick={addPlayer}
                aria-label="Add player"
                className="flex items-center justify-center w-[26px] h-[26px] rounded border border-body-300 dark:border-dark-300 text-gray-400 hover:text-white hover:border-gray-400 dark:hover:border-gray-500 bg-body-100 dark:bg-dark-400 transition-colors"
              >
                <IconPlus size={13} />
              </button>
            )}
          </div>

          {/* Per-monster sections */}
          {monsters.map((sm, mi) => {
            const resolvedBase = store.availableMonsters.find((m) => m.id === sm.monsterId);
            const resolvedHp = resolvedBase?.skills.hp ?? 1000;
            const seq = playerSteps[activePlayerIdx]?.[mi] ?? [];
            const isLast = mi === monsters.length - 1;

            return (
              // eslint-disable-next-line react/no-array-index-key
              <div key={mi} className="flex flex-col gap-2 border border-body-400 dark:border-dark-200 rounded p-2">
                <MonsterSection
                  monsterIdx={mi}
                  sequenceMonster={sm}
                  resolvedMonster={resolvedBase}
                  monsterOptions={monsterOptions}
                  canRemove={monsters.length > 1}
                  canAdd={isLast && monsters.length < MAX_MONSTERS}
                  onChangeMonster={(id) => updateMonsterInLoadout(mi, { monsterId: id, startingHp: undefined })}
                  onChangeStartingHp={(hp) => updateMonsterInLoadout(mi, { startingHp: hp })}
                  onAdd={addMonster}
                  onRemove={() => removeMonster(mi)}
                />

                <StepList
                  sequence={seq}
                  loadouts={loadouts}
                  monsterHp={resolvedHp}
                  monsterId={sm.monsterId}
                  onUpdateSequence={(newSeq) => updatePlayerMonsterSteps(activePlayerIdx, mi, newSeq)}
                />

                <div className="flex justify-end pt-1 border-t border-body-400 dark:border-dark-200">
                  <button
                    type="button"
                    className="form-control flex items-center gap-1 text-xs py-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={() => updatePlayerMonsterSteps(activePlayerIdx, mi, [...seq, defaultStep(0)])}
                    disabled={seq.length >= MAX_STEPS}
                  >
                    <IconPlus size={13} />
                    Add step
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
});

export default AttackSequencePanel;
