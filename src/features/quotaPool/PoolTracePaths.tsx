import {
  metricField,
  verticalResetSteps,
  type ChartMode,
  type ChartSample,
  type SegmentRun,
} from './chartGeometry';

export function PoolTracePaths({
  samples,
  mode,
  x,
  y,
  segmentRuns,
  stroke,
  strokeWidth,
  fillId,
  fillProjected = false,
  includeProjected = true,
  showResetRisers = false,
  sparseProjection,
  keyPrefix,
}: {
  samples: readonly ChartSample[];
  mode: ChartMode;
  x: (atMs: number) => number;
  y: (value: number) => number;
  segmentRuns: (projected: boolean, series?: ChartSample[]) => SegmentRun[];
  stroke: string;
  strokeWidth: number;
  fillId: string;
  fillProjected?: boolean;
  includeProjected?: boolean;
  showResetRisers?: boolean;
  sparseProjection: boolean;
  keyPrefix: string;
}) {
  const field = metricField[mode];
  const sampleList = samples as ChartSample[];
  const phases = includeProjected ? [false, true] : [false];

  return (
    <>
      {phases.map((projected) =>
        segmentRuns(projected, sampleList).map((run, segIdx) => (
          <g key={`${keyPrefix}-${projected}-${segIdx}`}>
            {mode === 'remaining' && (!projected || fillProjected) && (
              <path
                d={`${run.path} L${run.lastX},${y(0)} L${run.firstX},${y(0)} Z`}
                fill={`url(#${fillId})`}
              />
            )}
            <path
              d={run.path}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray={projected ? '7 5' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))
      )}
      {showResetRisers &&
        mode === 'remaining' &&
        includeProjected &&
        verticalResetSteps(samples, mode, x, y).map((step, stepIdx) => (
          <line
            key={`${keyPrefix}-step-${stepIdx}`}
            x1={step.x}
            x2={step.x}
            y1={step.y1}
            y2={step.y2}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        ))}
      {samples.map(({ point, projected }, sampleIdx) => {
        const value = point[field];
        if (value === null || (projected && (!includeProjected || !sparseProjection))) return null;
        return (
          <circle
            key={`${keyPrefix}-pt-${sampleIdx}`}
            cx={x(point.atMs)}
            cy={y(value)}
            r={samples.length < 3 ? 3 : 1.5}
            fill={stroke}
            opacity={projected ? 0.6 : 1}
          />
        );
      })}
    </>
  );
}
