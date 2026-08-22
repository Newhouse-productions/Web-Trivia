// Dispute evidence, not a security control (CLAUDE.md "Conventions"). Every
// state change, override, alias edit and answer-entered-on-behalf goes here.
export function makeAuditLogger(db) {
  const insert = db.prepare(`
    INSERT INTO audit (event_id, role, operator, action, target, reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return function logAudit({ eventId, role, operator = null, action, target = null, reason = null }) {
    insert.run(eventId, role, operator, action, target, reason, new Date().toISOString());
  };
}
