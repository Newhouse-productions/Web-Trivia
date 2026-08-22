// Media pipeline (technical-design §9.6, §18.1). Compress on upload — resize
// to 1200px, WebP — and serve from a content-hashed filename: unguessable,
// CDN-cacheable, never state-gated (technical-design §7.1). State-gating and
// CDN caching are mutually exclusive, so protection here is the filename,
// not an access check.
import { createHash } from 'node:crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readOpsSession } from '../opsSession.js';
import { makeAuditLogger } from '../audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEDIA_DIR = join(ROOT, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 150 * 1024;
const FILENAME_RE = /^[a-f0-9]{64}\.webp$/;

export function registerMediaRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);
  const upsertManifest = db.prepare(`
    INSERT INTO media_manifest (event_id, filename, sha256, uploaded_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id, filename) DO UPDATE SET sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at
  `);
  const listManifest = db.prepare(
    'SELECT filename, sha256, uploaded_at FROM media_manifest WHERE event_id = ? ORDER BY uploaded_at DESC'
  );

  app.addContentTypeParser(/^image\//, { parseAs: 'buffer' }, (req, body, done) => done(null, body));

  app.get('/media/:filename', async (req, reply) => {
    const filename = req.params.filename;
    if (!FILENAME_RE.test(filename)) return reply.code(404).send();
    try {
      const data = await fs.readFile(join(MEDIA_DIR, filename));
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.type('image/webp').send(data);
    } catch {
      return reply.code(404).send();
    }
  });

  app.get('/admin/media', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    return { files: listManifest.all(ops.eventId) };
  });

  app.post('/admin/media/upload', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event) return reply.code(409).send({ error: 'event_not_running' });

    const name = String(req.query?.name || '').trim().toLowerCase(); // lowercase on import (CLAUDE.md dev note)
    if (!name) return reply.code(400).send({ error: 'name_required' });

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return reply.code(400).send({ error: 'empty_upload' });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return reply.code(413).send({ error: 'too_large', max_bytes: MAX_UPLOAD_BYTES });
    }

    let processed;
    try {
      // Real MIME sniffed after decode, not trusted from the extension
      // (technical-design §18.1) — sharp only decodes real image bytes.
      processed = await sharp(buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      return reply.code(400).send({ error: 'invalid_image' });
    }

    if (processed.length > MAX_OUTPUT_BYTES) {
      return reply.code(413).send({ error: 'output_too_large', processed_size: processed.length });
    }

    const hash = createHash('sha256').update(processed).digest('hex');
    await fs.writeFile(join(MEDIA_DIR, `${hash}.webp`), processed);

    db.transaction(() => {
      upsertManifest.run(event.id, name, hash, new Date().toISOString());
      logAudit({
        eventId: event.id, role: 'admin', operator: ops.name, action: 'uploadMedia',
        target: name, reason: `${buffer.length} -> ${processed.length} bytes`
      });
    })();

    return {
      ok: true, filename: name, sha256: hash,
      original_size: buffer.length, processed_size: processed.length
    };
  });
}
