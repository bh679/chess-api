'use strict';

/**
 * Reusable input validators for chess-api route handlers.
 * Each validator returns { valid: true } or { valid: false, error: '<message>' }.
 */

/**
 * Room code: exactly 6 alphanumeric characters.
 */
function validateRoomCode(code) {
  if (typeof code !== 'string') {
    return { valid: false, error: 'roomCode must be a string' };
  }
  if (!/^[A-Za-z0-9]{6}$/.test(code)) {
    return { valid: false, error: 'roomCode must be exactly 6 alphanumeric characters' };
  }
  return { valid: true };
}

/**
 * SAN (Standard Algebraic Notation): basic structural check.
 * Accepts moves like e4, Nf3, O-O, O-O-O, exd5, Qxh7+, e8=Q#, etc.
 */
function validateSAN(san) {
  if (typeof san !== 'string') {
    return { valid: false, error: 'san must be a string' };
  }
  if (san.length === 0 || san.length > 10) {
    return { valid: false, error: 'san must be between 1 and 10 characters' };
  }
  // Castling
  if (/^O-O(-O)?[+#]?$/.test(san)) return { valid: true };
  // Standard piece move / pawn move
  if (!/^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?$/.test(san)) {
    return { valid: false, error: `"${san}" is not a valid SAN move` };
  }
  return { valid: true };
}

/**
 * Time control: "N+N" (minutes + increment) or "N/N+N" (odds format).
 * N is a non-negative integer.
 */
function validateTimeControl(tc) {
  if (typeof tc !== 'string') {
    return { valid: false, error: 'timeControl must be a string' };
  }
  if (!/^\d+\/\d+\+\d+$/.test(tc) && !/^\d+\+\d+$/.test(tc)) {
    return { valid: false, error: 'timeControl must be in "N+N" or "N/N+N" format (e.g. "5+3" or "2/5+0")' };
  }
  return { valid: true };
}

/**
 * FEN: basic structure check — 6 space-separated fields, first field has 8 ranks.
 */
function validateFEN(fen) {
  if (typeof fen !== 'string') {
    return { valid: false, error: 'fen must be a string' };
  }
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 6) {
    return { valid: false, error: 'fen must have 4-6 space-separated fields' };
  }
  const ranks = parts[0].split('/');
  if (ranks.length !== 8) {
    return { valid: false, error: 'fen position field must have 8 ranks separated by "/"' };
  }
  // Each rank should contain only valid FEN characters
  const validRank = /^[pPnNbBrRqQkK1-8]+$/;
  for (const rank of ranks) {
    if (!validRank.test(rank)) {
      return { valid: false, error: `fen contains invalid rank data: "${rank}"` };
    }
  }
  return { valid: true };
}

/**
 * Pagination: page/offset and limit must be non-negative integers, limit <= 100.
 * Pass raw query/body values (strings or numbers); they will be coerced.
 */
function validatePagination(page, limit) {
  const p = parseInt(page, 10);
  const l = parseInt(limit, 10);

  if (page !== undefined && page !== null && (isNaN(p) || p < 0)) {
    return { valid: false, error: 'offset/page must be a non-negative integer' };
  }
  if (limit !== undefined && limit !== null) {
    if (isNaN(l) || l < 1) {
      return { valid: false, error: 'limit must be a positive integer' };
    }
    if (l > 100) {
      return { valid: false, error: 'limit must not exceed 100' };
    }
  }
  return { valid: true };
}

module.exports = { validateRoomCode, validateSAN, validateTimeControl, validateFEN, validatePagination };
