import { Player } from '@/types/Player';
import { Monster } from '@/types/Monster';
import { AttackSequenceStep, NPCVsPlayerCalculatedLoadout, PlayerVsNPCCalculatedLoadout, SequenceSwingEvent } from '@/types/State';
import { CalcOpts } from '@/lib/BaseCalc';
import {
  CompareResult, CompareXAxis, CompareYAxis,
} from '@/lib/Comparator';

/**
 * Requests
 */

export enum WorkerRequestType {
  COMPUTE_BASIC,
  COMPUTE_REVERSE,
  COMPUTE_TTK_PARALLEL,
  COMPUTE_TTK,
  COMPARE,
  COMPUTE_SEQUENCE_TTK,
}

export interface WorkerRequest<T extends WorkerRequestType> {
  type: T,
  sequenceId?: number,
}

export interface WorkerCalcOpts {
  hitDistHideMisses?: boolean,
  detailedOutput?: CalcOpts['detailedOutput'],
  disableMonsterScaling?: CalcOpts['disableMonsterScaling'],
}

export interface ComputeBasicRequest extends WorkerRequest<WorkerRequestType.COMPUTE_BASIC> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  }
}

export interface ComputeReverseRequest extends WorkerRequest<WorkerRequestType.COMPUTE_REVERSE> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  }
}

export interface CompareRequest extends WorkerRequest<WorkerRequestType.COMPARE> {
  data: {
    axes: {
      x: CompareXAxis,
      y: CompareYAxis,
    },
    loadouts: Player[],
    monster: Monster,
  },
}

export interface TtkRequest extends WorkerRequest<WorkerRequestType.COMPUTE_TTK> {
  data: {
    loadouts: Player[],
    monster: Monster,
    calcOpts: WorkerCalcOpts,
  },
}

export interface TtkRequestParallel extends WorkerRequest<WorkerRequestType.COMPUTE_TTK_PARALLEL> {
  data: TtkRequest['data']
}

/** One monster slot as resolved by state.tsx before being sent to the worker. */
export interface SequenceWorkerMonster {
  monster: Monster;
  /** [playerIdx] = steps for that player against this monster. */
  playerSteps: AttackSequenceStep[][];
}

/** One sequence loadout as resolved for the worker (monster IDs replaced with full Monster objects). */
export interface SequenceWorkerLoadout {
  name: string;
  monsters: SequenceWorkerMonster[];
}

export interface SequenceTtkRequest extends WorkerRequest<WorkerRequestType.COMPUTE_SEQUENCE_TTK> {
  data: {
    sequenceLoadouts: SequenceWorkerLoadout[];
    loadouts: Player[];
  }
}

export type CalcRequestsUnion =
  ComputeBasicRequest |
  ComputeReverseRequest |
  CompareRequest |
  TtkRequest |
  TtkRequestParallel |
  SequenceTtkRequest;

/**
 * Responses
 */

export interface WorkerResponse<T extends WorkerRequestType> {
  type: T,
  sequenceId: number,
  error?: string,
  payload: unknown,
}

export interface ComputeBasicResponse extends WorkerResponse<WorkerRequestType.COMPUTE_BASIC> {
  payload: Omit<PlayerVsNPCCalculatedLoadout, 'ttkDist'>[],
}

export interface ComputeReverseResponse extends WorkerResponse<WorkerRequestType.COMPUTE_REVERSE> {
  payload: NPCVsPlayerCalculatedLoadout[],
}

export interface CompareResponse extends WorkerResponse<WorkerRequestType.COMPARE> {
  payload: CompareResult,
}

export interface TtkResponse extends WorkerResponse<WorkerRequestType.COMPUTE_TTK> {
  payload: Pick<PlayerVsNPCCalculatedLoadout, 'ttkDist'>[],
}

export interface TtkResponseParallel extends WorkerResponse<WorkerRequestType.COMPUTE_TTK_PARALLEL> {
  payload: TtkResponse['payload'],
}

export interface SequenceTtkResponse extends WorkerResponse<WorkerRequestType.COMPUTE_SEQUENCE_TTK> {
  payload: {
    dists: Map<number, number>[],
    debugTrace: SequenceSwingEvent[],
    /** [loadoutIdx][monsterIdx] = median kill tick for that monster. */
    monsterKillTicks: number[][],
  },
}

export type CalcResponsesUnion =
  ComputeBasicResponse |
  ComputeReverseResponse |
  CompareResponse |
  TtkResponse |
  TtkResponseParallel |
  SequenceTtkResponse;
export type CalcResponse<T extends WorkerRequestType> = CalcResponsesUnion & { type: T };

export type Handler<T extends WorkerRequestType> = (data: Extract<CalcRequestsUnion, { type: T }>['data'], rawRequest: CalcRequestsUnion) => Promise<CalcResponse<T>['payload']>;

export const WORKER_JSON_REPLACER = (k: string, v: Map<unknown, unknown> | never) => {
  if (v instanceof Map) {
    return {
      _dataType: 'Map',
      m: Array.from(v),
    };
  }
  return v;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKER_JSON_REVIVER = (k: string, v: any) => {
  if (typeof v === 'object' && v?._dataType === 'Map') {
    return new Map(v.m);
  }
  return v;
};
