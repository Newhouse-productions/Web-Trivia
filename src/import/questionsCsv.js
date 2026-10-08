// Parses and validates the questions CSV template. Validate and preview
// before committing; never half-import (technical-design §9.4) — this
// build treats any blocking error as failing the whole file, not just that
// row, since a silently incomplete question set is worse than a rejected
// import. Pipe-separated lists for options/aliases; filenames only for
// images (technical-design §9.3a).
import { parse } from 'csv-parse/sync';

const VALID_TYPES = ['mcq', 'text'];
const VALID_LAYOUTS = ['standard', 'image', 'media', 'statement', 'text-answer'];

function splitPipe(value) {
  if (!value) return null;
  const parts = String(value).split('|').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

function truthy(value) {
  return String(value || '').trim().toLowerCase() === 'y';
}

export function parseQuestionsCsv(text) {
  // CSV saved on Windows carries CRLF (CLAUDE.md dev environment note).
  const records = parse(text.replace(/\r\n/g, '\n'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  });

  const seenOrderNos = new Set();
  let anyError = false;

  const rows = records.map((record, index) => {
    const errors = [];
    const warnings = [];
    const rowNumber = index + 2; // header is row 1

    const type = String(record.type || '').trim().toLowerCase();
    if (!VALID_TYPES.includes(type)) errors.push('type must be "mcq" or "text"');

    const prompt = String(record.prompt || '').trim();
    if (!prompt) errors.push('prompt is required');

    const isPractice = truthy(record.is_practice);
    const isReserve = truthy(record.is_reserve);

    let round = null;
    let orderNo = null;
    if (!isPractice && !isReserve) {
      round = Number(record.round);
      orderNo = Number(record.order_no);
      if (!Number.isInteger(round) || round < 1) errors.push('round must be a positive integer');
      if (!Number.isInteger(orderNo) || orderNo < 1) {
        errors.push('order_no must be a positive integer');
      } else if (seenOrderNos.has(orderNo)) {
        errors.push(`duplicate order_no ${orderNo}`);
      } else {
        seenOrderNos.add(orderNo);
      }
    }

    const options = splitPipe(record.options);
    const aliases = splitPipe(record.aliases);
    const correctAnswer = String(record.correct_answer || '').trim();

    if (type === 'mcq') {
      if (!options || options.length < 2) errors.push('mcq requires at least 2 pipe-separated options');
      if (!correctAnswer) errors.push('correct_answer is required');
      else if (options && !options.includes(correctAnswer)) errors.push('correct_answer must match one of the options');
    } else if (type === 'text' && !correctAnswer) {
      errors.push('correct_answer is required');
    }

    const pointsRaw = String(record.points ?? '').trim();
    const points = Number(pointsRaw);
    if (pointsRaw === '' || !Number.isInteger(points) || points < 0) {
      errors.push('points must be a non-negative integer');
    }

    const imageFile = String(record.image_file || '').trim();
    const imageAlt = String(record.image_alt || '').trim();
    // Lowercase every uploaded filename on import (CLAUDE.md dev environment
    // note) — Windows and Linux disagree on case, and this is the seam
    // where that bites.
    const imageRef = imageFile ? imageFile.toLowerCase() : null;
    if (imageFile) {
      if (!imageAlt) errors.push('image_alt is required when image_file is set (CLAUDE.md #16)');
      warnings.push(`image "${imageRef}" must be uploaded separately in Media`);
    }

    // Audio questions must be answerable without hearing (scope §2
    // "Accessibility"). A warning, not an error, so older sheets without
    // the av_alt column still import — pre-flight counts what's missing.
    const avCue = String(record.av_cue || '').trim();
    const avAlt = String(record.av_alt || '').trim();
    if (avCue && !avAlt) {
      warnings.push('av_alt is empty — add a text alternative so the question works without hearing the clip');
    }

    const layout = String(record.layout || '').trim().toLowerCase();
    if (layout && !VALID_LAYOUTS.includes(layout)) {
      errors.push(`layout "${layout}" is not one of ${VALID_LAYOUTS.join(', ')}`);
    }

    if (errors.length) anyError = true;

    return {
      rowNumber,
      round,
      order_no: orderNo,
      type,
      prompt,
      options,
      correct_answer: correctAnswer || null,
      aliases,
      points: Number.isInteger(points) ? points : null,
      image_ref: imageRef,
      image_alt: imageAlt || null,
      video_url: String(record.video_url || '').trim() || null,
      av_cue: avCue || null,
      av_alt: avAlt || null,
      layout: layout || null,
      is_practice: isPractice,
      is_reserve: isReserve,
      errors,
      warnings
    };
  });

  return { rows, valid: !anyError && rows.length > 0 };
}
