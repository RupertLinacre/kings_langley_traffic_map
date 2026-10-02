// Evidence and limitations: docs/junction20-audit.md. Never overwrite raw OSM tags.
export const J20_CIRCULATORY_WAYS = new Set([
  19891590, 103593415, 103593416, 157927309, 970926331, 970926332, 1057576181,
]);
export const J20_INACTIVE_SIGNALS = new Set([1617318427, 1617318590]);
// Circulatory stop / entering stop. Physical conflict pairs, not a recovered
// controller specification. Offset/green splits are illustrative parameters.
export const J20_SIGNAL_PAIRS = [
  {
    name: 'A41 from Aylesbury',
    circulating: 1162215572,
    entering: 1617318415,
    offset: 0,
  },
  {
    name: 'A41 from Watford',
    circulating: 1162218467,
    entering: 1162228639,
    offset: 0,
  },
  {
    name: 'M25 clockwise off-slip',
    circulating: 1479476510,
    entering: 242068853,
    offset: 0.28,
  },
  {
    name: 'M25 anticlockwise off-slip',
    circulating: 208683641,
    entering: 208684246,
    offset: 0.62,
  },
];
export function junction20Signal(nodeId, time, cycle) {
  if (J20_INACTIVE_SIGNALS.has(nodeId)) return 'none';
  const pair = J20_SIGNAL_PAIRS.find(
    (p) => p.circulating === nodeId || p.entering === nodeId,
  );
  if (!pair) return null;
  const phase =
    (((time +
      cycle * pair.offset +
      (nodeId === pair.entering ? cycle / 2 : 0)) %
      cycle) +
      cycle) %
    cycle;
  // Three seconds amber plus two seconds clearance before the opposed green.
  return phase < cycle / 2 - 5
    ? 'green'
    : phase < cycle / 2 - 2
      ? 'amber'
      : 'red';
}
export function isCirculatory(tags) {
  return tags.junction === 'roundabout' || tags.junction === 'circular';
}
