// Results CSV: per-answer rows plus a final-scores block. Team names and
// scores only, no usernames (CLAUDE.md/scope §6 data retention). Shared by
// admin's export and the host's final-screen export so the two never drift.
function csvField(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildResultsCsv(db, eventId) {
  const rows = db.prepare(`
    SELECT t.table_number, t.team_name, q.round, q.order_no, q.is_practice, q.is_reserve,
           q.prompt, q.type, q.points, a.value, a.is_correct
    FROM answers a
    JOIN teams t ON t.id = a.team_id
    JOIN questions q ON q.id = a.question_id
    WHERE a.event_id = ?
    ORDER BY CAST(t.table_number AS INTEGER), q.round, q.order_no
  `).all(eventId);

  const header = ['table_number', 'team_name', 'round', 'order_no', 'prompt', 'type', 'points', 'value', 'is_correct', 'points_earned'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const label = r.is_practice ? 'practice' : r.is_reserve ? 'reserve' : String(r.order_no ?? '');
    const pointsEarned = r.is_correct === 1 ? r.points : 0;
    lines.push([
      r.table_number, r.team_name || `Table ${r.table_number}`, r.round ?? '', label, r.prompt,
      r.type, r.points, r.value, r.is_correct === null ? 'unmarked' : (r.is_correct ? 'correct' : 'wrong'),
      pointsEarned
    ].map(csvField).join(','));
  }

  const scores = db.prepare(`
    SELECT t.table_number, t.team_name,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 THEN q.points ELSE 0 END), 0) AS answer_points,
           COALESCE((SELECT SUM(points) FROM bonuses b WHERE b.team_id = t.id), 0) AS bonus_points
    FROM teams t
    LEFT JOIN answers a ON a.team_id = t.id
    LEFT JOIN questions q ON q.id = a.question_id
    WHERE t.event_id = ? AND t.archived = 0
    GROUP BY t.id
    ORDER BY (answer_points + bonus_points) DESC, CAST(t.table_number AS INTEGER)
  `).all(eventId);

  lines.push('');
  lines.push('table_number,team_name,final_score');
  for (const s of scores) {
    lines.push([s.table_number, s.team_name || `Table ${s.table_number}`, s.answer_points + s.bonus_points]
      .map(csvField).join(','));
  }

  return lines.join('\r\n');
}
