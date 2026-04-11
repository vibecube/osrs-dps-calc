import React, { useCallback, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/state';
import Select from '@/app/components/generic/Select';
import { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { toJS } from 'mobx';
import { max } from 'd3-array';
import SectionAccordion from '@/app/components/generic/SectionAccordion';
import hourglass from '@/public/img/Hourglass.png';
import LazyImage from '@/app/components/generic/LazyImage';
import { INFINITE_HEALTH_MONSTERS } from '@/lib/constants';
import { IconAlertTriangle, IconSwords } from '@tabler/icons-react';

const SECONDS_PER_TICK = 0.6;

enum XAxisType {
  TICKS,
  SECONDS,
}

const XAxisOptions = [
  { label: 'Ticks', value: XAxisType.TICKS },
  { label: 'Seconds', value: XAxisType.SECONDS },
];

interface CustomTooltipProps extends TooltipProps<ValueType, NameType> {
  xAxisOption: typeof XAxisOptions[0],
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({
  active, payload, label, xAxisOption,
}) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white shadow rounded p-2 text-sm text-black flex items-center gap-2">
        <div>
          <p>
            <strong>
              Within
              {' '}
              {label}
              {' '}
              {xAxisOption.label}
            </strong>
          </p>
          {payload.map((p) => (
            <div key={p.name} className="flex justify-between w-48 gap-1">
              <div className="flex items-center gap-1 leading-3 overflow-hidden">
                <div>
                  <div
                    className="w-3 h-3 inline-block border border-gray-400 rounded-lg"
                    style={{ backgroundColor: p.color }}
                  />
                </div>
                {p.name}
              </div>
              <span className="text-gray-400 font-bold">
                {p.value === 'NaN' ? '---' : `${p.value}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

const LINE_COLOUR = '#f97316'; // orange-500 to match the sequence tab indicator

const SequenceTtkComparison: React.FC = observer(() => {
  const store = useStore();
  const { showSequenceTtkComparison, attackSequenceEnabled, attackSequence: sequence } = store.prefs;
  const sequenceTtkDist = toJS(store.calc.sequenceTtkDist);

  const [xAxisType, setXAxisType] = useState<{ label: string, value: XAxisType } | null | undefined>(XAxisOptions[0]);

  const infiniteHealth = useMemo(() => INFINITE_HEALTH_MONSTERS.includes(store.monster.id), [store.monster.id]);
  const hasKillStep = useMemo(() => sequence.some((s) => s.condition.type === 'kill'), [sequence]);

  const data = useMemo(() => {
    if (!sequenceTtkDist || sequenceTtkDist.size === 0) return [];

    const xLabeller = xAxisType?.value === XAxisType.SECONDS
      ? (x: number) => (x * SECONDS_PER_TICK).toFixed(1)
      : (x: number) => x.toString();

    const uniqueTtks = max(sequenceTtkDist.keys()) || 0;
    const lines: { name: string; 'Attack Sequence': string }[] = [];
    let runningTotal = 0;

    for (let ttk = 0; ttk <= uniqueTtks; ttk++) {
      const v = sequenceTtkDist.get(ttk);
      if (v) runningTotal += v;
      lines.push({ name: xLabeller(ttk), 'Attack Sequence': (runningTotal * 100).toFixed(2) });
    }
    return lines;
  }, [sequenceTtkDist, xAxisType]);

  const showChart = attackSequenceEnabled && !infiniteHealth && hasKillStep && sequenceTtkDist && sequenceTtkDist.size > 0;

  return (
    <SectionAccordion
      defaultIsOpen={showSequenceTtkComparison}
      onIsOpenChanged={(o) => store.updatePreferences({ showSequenceTtkComparison: o })}
      title={(
        <div className="flex items-center gap-2">
          <div className="w-6 flex justify-center"><LazyImage src={hourglass.src} /></div>
          <h3 className="font-serif font-bold">
            Sequence Time-to-Kill Graph
          </h3>
          <IconSwords size={16} className="text-orange-400" />
        </div>
      )}
    >
      {!attackSequenceEnabled && (
        <div className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
          Enable the attack sequence (
          <IconSwords size={14} className="inline-block align-text-bottom mx-0.5" />
          ) to see a time-to-kill distribution for your rotation.
        </div>
      )}

      {attackSequenceEnabled && infiniteHealth && (
        <div className="w-full bg-yellow-500 text-white px-4 py-1 text-sm border-b border-yellow-400 flex items-center gap-2">
          <IconAlertTriangle className="text-orange-200" />
          <div>A time-to-kill distribution cannot be shown for this monster.</div>
        </div>
      )}

      {attackSequenceEnabled && !infiniteHealth && sequence.length === 0 && (
        <div className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
          Add steps to your attack sequence to see a TTK distribution.
        </div>
      )}

      {attackSequenceEnabled && !infiniteHealth && sequence.length > 0 && !hasKillStep && (
        <div className="px-6 py-4 text-sm text-yellow-600 dark:text-yellow-400">
          Add a final &quot;Until killed&quot; step to your sequence to see a TTK distribution.
        </div>
      )}

      {attackSequenceEnabled && !infiniteHealth && hasKillStep && !sequenceTtkDist && (
        <div className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
          Computing…
        </div>
      )}

      {showChart && (
        <div className="px-6 py-4">
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={data} margin={{ top: 40, right: 20 }}>
              <XAxis
                allowDecimals
                dataKey="name"
                stroke="#777777"
                interval="equidistantPreserveStart"
                tickFormatter={(v: string) => `${parseFloat(v)}`}
                label={{ value: xAxisType?.label, position: 'insideBottom', offset: -15 }}
              />
              <YAxis
                stroke="#777777"
                domain={[0, 100]}
                interval="equidistantPreserveStart"
                tickFormatter={(v: number) => `${v}%`}
                label={{
                  value: 'chance', position: 'insideLeft', angle: -90, style: { textAnchor: 'middle' },
                }}
              />
              <CartesianGrid stroke="gray" strokeDasharray="5 5" />
              <Tooltip
                content={(props) => <CustomTooltip {...props} xAxisOption={xAxisType || XAxisOptions[0]} />}
              />
              <Legend wrapperStyle={{ fontSize: '.9em', top: 0 }} />
              <Line
                isAnimationActive={false}
                type="monotone"
                dataKey="Attack Sequence"
                stroke={LINE_COLOUR}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="my-4 flex gap-4 max-w-lg m-auto dark:text-white">
            <div className="basis-full md:basis-1/2">
              <h3 className="font-serif font-bold mb-2">X axis</h3>
              <Select
                id="sequence-ttk-x"
                items={XAxisOptions}
                value={xAxisType || undefined}
                onSelectedItemChange={(i) => setXAxisType(i)}
              />
            </div>
          </div>
        </div>
      )}
    </SectionAccordion>
  );
});

export default SequenceTtkComparison;
