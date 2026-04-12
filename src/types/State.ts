import { PartialDeep } from 'type-fest';
import { EquipmentPiece, Player } from '@/types/Player';
import { Monster } from '@/types/Monster';
import UserIssueType from '@/enums/UserIssueType';
import { DetailEntry } from '@/lib/CalcDetails';

export interface UserIssue {
  type: UserIssueType;
  message: string;
  loadout?: string;
}

/**
 * UI-specific toggled behaviour and state.
 */
export interface UI {
  showPreferencesModal: boolean;
  showShareModal: boolean;
  username: string;
  isDefensiveReductionsExpanded: boolean;
}

export type SequenceStepCondition =
  | { type: 'attacks'; count: number }
  | { type: 'hp_threshold'; hp: number }
  | { type: 'kill' };

export interface AttackSequenceStep {
  loadoutIndex: number;
  useSpec: boolean;
  condition: SequenceStepCondition;
  /** When set, overrides the weapon slot from the referenced loadout for this step only. */
  weaponOverride?: EquipmentPiece | null;
}

/** One monster slot in a multi-monster sequence. */
export interface SequenceMonster {
  /** ID matching an entry in availableMonsters (-1 = custom monster). */
  monsterId: number;
  /** Override starting HP. Undefined = full HP from the monster definition. */
  startingHp?: number;
}

export interface AttackSequenceLoadout {
  name: string;
  /** Ordered list of monsters to fight sequentially. */
  monsters: SequenceMonster[];
  /**
   * [playerIdx][monsterIdx] = steps for that player against that monster.
   * Invariant: playerSteps.length === number of players,
   *            playerSteps[pi].length === monsters.length.
   */
  playerSteps: AttackSequenceStep[][][];
  /** Index of the currently-viewed player tab within this loadout. */
  activePlayer: number;
  /** Index of the monster section currently focused in the UI. */
  activeMonster: number;
  /**
   * @deprecated Legacy field present only in old saved data — used during migration.
   * Never written by new code.
   */
  players?: AttackSequenceStep[][];
}

/**
 * User preferences that we store in the user's localStorage. You should not add any keys here that shouldn't be
 * saved locally and persist between sessions.
 */
export interface Preferences {
  manualMode: boolean;
  rememberUsername: boolean;
  showHitDistribution: boolean;
  showLoadoutComparison: boolean;
  showTtkComparison: boolean;
  showNPCVersusPlayerResults: boolean;
  hitDistsHideZeros: boolean; // legacy name
  hitDistShowSpec: boolean;
  resultsExpanded: boolean;
  attackSequenceEnabled: boolean;
  attackSequenceLoadouts: AttackSequenceLoadout[];
  attackSequenceActiveLoadout: number;
  attackSequenceTargetTtkSeconds: number;
  showSequenceTtkComparison: boolean;
}

export interface ChartEntry {
  name: string | number,
  [k: string]: string | number,
}

export interface ChartAnnotation {
  value: number,
  label: string
}

/**
 * The result of running the calculator on a specific player loadout.
 */
export interface CalculatedLoadout {
  userIssues?: UserIssue[],
}

export interface PlayerVsNPCCalculatedLoadout extends CalculatedLoadout {
  details?: DetailEntry[],
  specDetails?: DetailEntry[],

  // Player vs NPC metrics
  npcDefRoll?: number,
  maxHit?: number,
  expectedHit?: number,
  maxAttackRoll?: number,
  accuracy?: number,
  dps?: number,
  ttk?: number,
  hitDist?: ChartEntry[],
  ttkDist?: Map<number, number>,

  specAccuracy?: number,
  specMaxHit?: number,
  specExpected?: number,
  specMomentDps?: number,
  specFullDps?: number,
  specHitDist?: ChartEntry[],
}

// NPC vs Player metrics
export interface NPCVsPlayerCalculatedLoadout extends CalculatedLoadout {
  npcDetails?: DetailEntry[],

  playerDefRoll?: number,
  npcMaxAttackRoll?: number,
  npcMaxHit?: number,
  npcDps?: number,
  npcAccuracy?: number,
  avgDmgTaken?: number,
}

/** One weapon swing recorded during a single debug trace run of the sequence simulation. */
export interface SequenceSwingEvent {
  tick: number;
  playerIdx: number;
  monsterIdx: number;
  weaponName: string;
  damage: number;
  hpBefore: number;
  hpAfter: number;
  defBefore: number;
  defAfter: number;
  /** 'attacks' = fixed-count step; 'kill' = open-ended kill/threshold step */
  phase: 'attacks' | 'kill';
  isKill: boolean;
}

export interface Calculator {
  loadouts: (PlayerVsNPCCalculatedLoadout & NPCVsPlayerCalculatedLoadout)[];
  sequenceTtkDists?: Map<number, number>[];
  sequenceDebugTrace?: SequenceSwingEvent[];
  /** [loadoutIdx][monsterIdx] = median kill tick for that monster in that loadout. */
  sequenceMonsterKillTicks?: number[][];
}

/**
 * The exported data version, which can be used to perform lazy migrations on load,
 * if the application changes since the data was written to storage.
 * This value should be incremented every time {@link ImportableData},
 * or any of its subproperties, are updated in a non-backwards-compatible manner,
 * or also in any manner that could affect the migrations required on load.
 */
export const IMPORT_VERSION = 8 as const;

/**
 * This is the state that can be exported and imported (through shortlinks).
 * If you change the schema here without taking precautions, you **will** break existing shortlinks.
 */
export interface ImportableData {
  // can be any number <= IMPORT_VERSION
  serializationVersion: number;

  loadouts: PartialDeep<Player>[];
  selectedLoadout: number;

  monster: Monster;
}

/**
 * The interface for the global app state, which includes not only the import(ed|able) data, but also the UI state,
 * and the user's preferences.
 */
export interface State extends ImportableData {
  ui: UI;
  prefs: Preferences;
  calc: Calculator;

  /**
   * All monsters that a player can fight.
   */
  availableMonsters: Omit<Monster, 'inputs'>[];
}
