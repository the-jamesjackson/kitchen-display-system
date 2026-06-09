const { pool } = require('./db');

// Average over recent history only, so predictions track how the kitchen runs now.
const ROLLING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Same-hour samples needed before the hour-specific average is trusted over the item average.
const MIN_HOUR_SAMPLES = 3;
// Used only when there is no cook-time history at all.
const DEFAULT_COOK_SECONDS = 300;

// Predicts cook seconds for each name at the given hour of day.
// Returns { [itemName]: seconds }. Falls back from hour-specific average,
// to the item's overall average, to the global average, to a fixed default.
async function predictCookSeconds(names, hour) {
  const unique = [...new Set(names.map(String))];
  if (unique.length === 0) return {};
  const since = Date.now() - ROLLING_WINDOW_MS;

  const { rows } = await pool.query(
    `SELECT item_name,
            AVG((completed_at - fired_at) / 1000.0) FILTER (WHERE hour_of_day = $2) AS hour_avg,
            COUNT(*) FILTER (WHERE hour_of_day = $2) AS hour_count,
            AVG((completed_at - fired_at) / 1000.0) AS item_avg,
            COUNT(*) AS item_count
       FROM cook_time_logs
      WHERE item_name = ANY($1)
        AND created_at > $3
        AND completed_at > fired_at
      GROUP BY item_name`,
    [unique, hour, since]
  );

  const { rows: g } = await pool.query(
    `SELECT AVG((completed_at - fired_at) / 1000.0) AS global_avg
       FROM cook_time_logs
      WHERE created_at > $1 AND completed_at > fired_at`,
    [since]
  );
  const globalAvg = g[0].global_avg != null ? Number(g[0].global_avg) : DEFAULT_COOK_SECONDS;

  const byName = new Map(rows.map((r) => [r.item_name, r]));
  const result = {};
  for (const name of unique) {
    const r = byName.get(name);
    let seconds;
    if (r && Number(r.hour_count) >= MIN_HOUR_SAMPLES && r.hour_avg != null) {
      seconds = Number(r.hour_avg);
    } else if (r && Number(r.item_count) >= 1 && r.item_avg != null) {
      seconds = Number(r.item_avg);
    } else {
      seconds = globalAvg;
    }
    result[name] = Math.round(seconds);
  }
  return result;
}

module.exports = { predictCookSeconds, DEFAULT_COOK_SECONDS };
