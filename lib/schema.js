import { createHash } from 'node:crypto';

export const STORAGE = Object.freeze({ MATERIALIZED: 'materialized', REFERENCE: 'reference' });

/** Text formats whose bytes are directly usable as Markdown (no extraction needed). */
export const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html',
]);

/** Document formats that live on the text track but still need a later extractor. */
export const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/epub+zip',
]);

export const SIZE_REFERENCE_THRESHOLD = 5 * 1024 * 1024;

export const TIER_ORDER = ['L0', 'L1', 'L2', 'L3', 'BAN'];

export function checksum(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function makeId(source, seed) {
  return `${source}-${createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)}`;
}

/** Dual-track decision (§4.2): text = materialized, large media = reference-only. */
export function classifyStorage(mimeType, sizeBytes) {
  const mime = String(mimeType || 'application/octet-stream');
  if (TEXT_MIMES.has(mime) || DOCUMENT_MIMES.has(mime)) return STORAGE.MATERIALIZED;
  if (
    mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') ||
    mime === 'application/zip'
  ) return STORAGE.REFERENCE;
  return sizeBytes > SIZE_REFERENCE_THRESHOLD ? STORAGE.REFERENCE : STORAGE.MATERIALIZED;
}

export function guessSourceType(mimeType) {
  const mime = String(mimeType || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/json') return 'data';
  if (mime === 'application/zip') return 'archive';
  if (TEXT_MIMES.has(mime) || DOCUMENT_MIMES.has(mime)) return 'document';
  return 'asset';
}

/** Build the one record shape (§4.3). Undefined fields are dropped by the store. */
export function makeRecord(partial) {
  const capturedAt = partial.capturedAt ?? new Date().toISOString();
  const mimeType = partial.mimeType ?? 'application/octet-stream';
  const sizeBytes = partial.sizeBytes ?? 0;
  return {
    id: partial.id,
    source: partial.source,
    sourceType: partial.sourceType ?? guessSourceType(mimeType),
    title: partial.title ?? '(untitled)',
    capturedAt,
    occurredAt: partial.occurredAt,
    storage: partial.storage ?? classifyStorage(mimeType, sizeBytes),
    mimeType,
    sizeBytes,
    remoteRef: partial.remoteRef,
    localRef: partial.localRef,
    innerPath: partial.innerPath,
    originalPath: partial.originalPath,
    mdPath: partial.mdPath,
    transcriptPath: partial.transcriptPath,
    thumbnailPath: partial.thumbnailPath,
    tags: partial.tags ?? [],
    conversation: partial.conversation,
    checksum: partial.checksum,
    extractStatus: partial.extractStatus,
    shadowStatus: partial.shadowStatus,
  };
}

/** Strip null/undefined so manifest.jsonl stays compact. */
export function cleanRecord(rec) {
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined && v !== null));
}
