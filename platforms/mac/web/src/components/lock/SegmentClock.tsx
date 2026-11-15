import { DIGIT_SEGMENTS, SEG, segmentLayout, segmentPolygons } from '../../lib/lockScreen';

const LIT = '#f4f4f5';
const GHOST = 'rgba(255,255,255,0.025)';

/** "HH:MM:SS" as a seven-segment LCD read-out. Height is any CSS length; width follows. */
export default function SegmentClock({ text, height }: { text: string; height: string }) {
  const { offsets, width } = segmentLayout(text);
  return (
    <svg viewBox={`0 0 ${width} ${SEG.h}`} style={{ height }} role="img" aria-label={text}>
      {[...text].map((ch, i) => {
        const ox = offsets[i];
        if (ch === ':') {
          const cx = ox + SEG.colonW / 2;
          return (
            <g key={i} fill={LIT}>
              <rect x={cx - SEG.t / 2} y={SEG.h * 0.3 - SEG.t / 2} width={SEG.t} height={SEG.t} />
              <rect x={cx - SEG.t / 2} y={SEG.h * 0.7 - SEG.t / 2} width={SEG.t} height={SEG.t} />
            </g>
          );
        }
        const on = DIGIT_SEGMENTS[ch] ?? '';
        const polys = segmentPolygons(ox);
        return (
          <g key={i}>
            {Object.entries(polys).map(([seg, pts]) => <polygon key={seg} points={pts} fill={on.includes(seg) ? LIT : GHOST} />)}
          </g>
        );
      })}
    </svg>
  );
}
