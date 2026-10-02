/** Select an already fitted demand table; no routing or fitting happens here. */
export function demandForPeriod(demand, period = 'everyday') {
  if (!demand.profiles?.[period]) {
    if (period !== 'everyday') throw Error('Unknown traffic period');
    return demand;
  }
  return {
    ...demand,
    routes: demand.routes.map((r) => ({ ...r, rate: r.rates[period] })),
  };
}
export function cumulativeWeights(weights) {
  let sum = 0;
  return weights.map((w) => {
    if (!Number.isFinite(w) || w < 0) throw Error('Invalid route weight');
    return (sum += w);
  });
}
export function sampleCumulative(cumulative, draw) {
  if (!cumulative.length || cumulative.at(-1) <= 0) return -1;
  const target = draw * cumulative.at(-1);
  let low = 0,
    high = cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cumulative[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Classify prepared paths once. Routes touching the village take precedence
// even if they also use a motorway slip road elsewhere on the journey.
export function popularityClasses(data, routes) {
  return routes.map((r) => {
    if (
      r.path.some(
        (id) =>
          data.edges[id].tags.name === 'High Street' &&
          data.edges[id].tags.ref === 'A4251',
      )
    )
      return 'village';
    if (
      r.path.some(
        (id) =>
          ['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(
            data.edges[id].tags.highway,
          ) || data.edges[id].tags.ref === 'A41',
      )
    )
      return 'bypass';
    return 'other';
  });
}

// n multiplies the village:bypass odds, not overall traffic volume. Other
// journeys and zero-rate scheduled trips retain their original arrival rates.
export function popularityRates(rates, classes, n) {
  if (!Number.isFinite(n) || n < 1 || n > 10)
    throw Error('Popularity must be between 1 and 10');
  let village = 0,
    bypass = 0;
  rates.forEach((rate, i) => {
    if (classes[i] === 'village') village += rate;
    if (classes[i] === 'bypass') bypass += rate;
  });
  if (n === 1 || !village || !bypass) return rates.slice();
  const normalise = (village + bypass) / (n * village + bypass);
  return rates.map(
    (rate, i) =>
      rate *
      (classes[i] === 'village'
        ? n * normalise
        : classes[i] === 'bypass'
          ? normalise
          : 1),
  );
}
