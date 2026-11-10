// 效率节拍 · 目标产能：pick a process, say how many runs it has to do in how many seconds, and see
// whether it keeps up — required interval vs the process takt, and how many machines each station
// would need. Pure; the dock tab in main.js builds the process list and the HTML around it.

// process: { stations: [{ name, cycle (s per run on one machine), units (machines) }], lead (s for
// the first run from empty) }; goal: { count, seconds } = `count` runs every `seconds` seconds.
export function rateCheck(process, goal) {
  const need = goal.seconds / goal.count;
  const rows = process.stations.map((s) => {
    const takt = s.cycle / s.units;
    return { ...s, takt, needUnits: Math.max(1, Math.ceil(s.cycle / need - 1e-9)), ok: takt <= need + 1e-9 };
  });
  const neck = rows.reduce((a, b) => (b.takt > a.takt ? b : a));
  const takt = neck.takt;
  const lead = process.lead ?? takt;
  return {
    need,
    takt,
    meets: takt <= need + 1e-9,
    gap: takt - need,
    neck: neck.name,
    // steady state: one run per takt once the line is full
    steady: goal.seconds / takt,
    // from empty: the first run takes the whole lead time, then one per takt
    fromEmpty: goal.seconds < lead ? 0 : Math.floor((goal.seconds - lead) / takt + 1e-9) + 1,
    lead,
    perHour: 3600 / takt,
    rows,
  };
}

// "每分钟 3 次" style label for a goal.
export function goalLabel({ count, seconds }) {
  const per = { 60: '每分钟', 3600: '每小时', 28800: '每 8 小时班' }[seconds]
    ?? (seconds % 3600 === 0 ? `每 ${seconds / 3600} 小时` : seconds % 60 === 0 ? `每 ${seconds / 60} 分钟` : `每 ${seconds} 秒`);
  return `${per} ${count} 次`;
}
