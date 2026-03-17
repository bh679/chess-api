const { Chess } = require('chess.js');

/**
 * Bughouse drop validation and piece pool management.
 *
 * chess.js does not support piece drops, so we validate drops by
 * manipulating the FEN directly and verifying legality with a
 * temporary Chess instance.
 */

// Empty piece pool — counts per piece type
function createEmptyPool() {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

// Create initial pools for a board (both colors start empty)
function createBoardPools() {
  return { w: createEmptyPool(), b: createEmptyPool() };
}

/**
 * Add a captured piece to the partner board's pool.
 * In bughouse, captured pieces change color: if white captures a black
 * knight on Board A, Board B's white player gains a white knight to drop.
 *
 * @param {object} partnerPools - The partner board's pools { w: {...}, b: {...} }
 * @param {string} capturedPiece - Piece type that was captured (p, n, b, r, q)
 * @param {string} capturerColor - Color of the player who captured ('w' or 'b')
 */
function addCapturedPiece(partnerPools, capturedPiece, capturerColor) {
  const piece = capturedPiece.toLowerCase();
  if (!partnerPools[capturerColor] || partnerPools[capturerColor][piece] === undefined) return;
  // The capturer's partner (same color on the other board) gets the piece
  partnerPools[capturerColor][piece] += 1;
}

/**
 * Remove a piece from a player's pool (after a successful drop).
 *
 * @param {object} boardPools - The board's pools { w: {...}, b: {...} }
 * @param {string} color - Color of the dropping player ('w' or 'b')
 * @param {string} piece - Piece type being dropped (p, n, b, r, q)
 * @returns {boolean} true if piece was available and removed
 */
function removePieceFromPool(boardPools, color, piece) {
  const p = piece.toLowerCase();
  if (!boardPools[color] || boardPools[color][p] === undefined || boardPools[color][p] <= 0) {
    return false;
  }
  boardPools[color][p] -= 1;
  return true;
}

/**
 * Parse a FEN string into its components.
 */
function parseFen(fen) {
  const parts = fen.split(' ');
  return {
    position: parts[0],
    turn: parts[1],
    castling: parts[2],
    enPassant: parts[3],
    halfmove: parseInt(parts[4], 10),
    fullmove: parseInt(parts[5], 10),
  };
}

/**
 * Convert algebraic square (e.g., 'e4') to rank/file indices (0-based).
 */
function squareToIndices(square) {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7
  const rank = parseInt(square[1], 10) - 1;               // 0-7
  return { rank, file };
}

/**
 * Convert FEN position string to an 8x8 array.
 * board[0] = rank 8 (top), board[7] = rank 1 (bottom)
 */
function fenPositionToBoard(positionStr) {
  const rows = positionStr.split('/');
  const board = [];
  for (const row of rows) {
    const boardRow = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch, 10); i++) boardRow.push(null);
      } else {
        boardRow.push(ch);
      }
    }
    board.push(boardRow);
  }
  return board;
}

/**
 * Convert 8x8 board array back to FEN position string.
 */
function boardToFenPosition(board) {
  const rows = [];
  for (const boardRow of board) {
    let row = '';
    let emptyCount = 0;
    for (const cell of boardRow) {
      if (cell === null) {
        emptyCount++;
      } else {
        if (emptyCount > 0) { row += emptyCount; emptyCount = 0; }
        row += cell;
      }
    }
    if (emptyCount > 0) row += emptyCount;
    rows.push(row);
  }
  return rows.join('/');
}

/**
 * Check if a square is empty on the board.
 */
function isSquareEmpty(board, rank, file) {
  // FEN rows go from rank 8 (index 0) to rank 1 (index 7)
  const rowIndex = 7 - rank;
  return board[rowIndex][file] === null;
}

/**
 * Place a piece on the board.
 */
function placePiece(board, rank, file, piece) {
  const rowIndex = 7 - rank;
  board[rowIndex][file] = piece;
}

/**
 * Validate whether a drop is legal in bughouse.
 *
 * Rules:
 * 1. The target square must be empty
 * 2. Pawns cannot be dropped on rank 1 or rank 8
 * 3. The drop must not leave the player's own king in check
 * 4. The player must have the piece in their pool (checked externally)
 *
 * @param {string} fen - Current board FEN
 * @param {string} color - Color dropping ('w' or 'b')
 * @param {string} piece - Piece type (p, n, b, r, q)
 * @param {string} targetSquare - Algebraic notation (e.g., 'e4')
 * @returns {{ valid: boolean, newFen?: string, error?: string }}
 */
function validateDrop(fen, color, piece, targetSquare) {
  const p = piece.toLowerCase();
  if (!['p', 'n', 'b', 'r', 'q'].includes(p)) {
    return { valid: false, error: 'Invalid piece type' };
  }

  const { rank, file } = squareToIndices(targetSquare);
  if (rank < 0 || rank > 7 || file < 0 || file > 7) {
    return { valid: false, error: 'Invalid square' };
  }

  // Pawns cannot be dropped on rank 1 or rank 8
  if (p === 'p' && (rank === 0 || rank === 7)) {
    return { valid: false, error: 'Pawns cannot be dropped on the first or last rank' };
  }

  const parsed = parseFen(fen);

  // Must be this player's turn
  if (parsed.turn !== color) {
    return { valid: false, error: 'Not your turn' };
  }

  const board = fenPositionToBoard(parsed.position);

  // Square must be empty
  if (!isSquareEmpty(board, rank, file)) {
    return { valid: false, error: 'Square is occupied' };
  }

  // Place the piece
  const fenChar = color === 'w' ? p.toUpperCase() : p.toLowerCase();
  const newBoard = board.map(row => [...row]);
  placePiece(newBoard, rank, file, fenChar);

  // Build new FEN: swap turn, reset en passant, increment move counter
  const newTurn = color === 'w' ? 'b' : 'w';
  const newFullmove = color === 'b' ? parsed.fullmove + 1 : parsed.fullmove;
  const newFen = `${boardToFenPosition(newBoard)} ${newTurn} ${parsed.castling} - 0 ${newFullmove}`;

  // Verify the drop doesn't leave own king in check
  try {
    const testChess = new Chess(newFen);
    // After placing and swapping turn, check if the side that just dropped
    // has their king in check. We need to check the *dropping* side's king.
    // chess.js isCheck() checks the current turn's king being in check,
    // but we swapped turns. So we check if the opponent (now to move) is
    // giving check to the dropping side. We can do this by checking if
    // the position is valid — if the side NOT to move is in check, the
    // position is illegal.
    //
    // chess.js doesn't directly expose "is side X in check", but we can
    // check: after the drop, the opponent's turn begins. If the dropping
    // player's king is in check, the position is illegal.
    // We'll swap back to check:
    const checkFen = `${boardToFenPosition(newBoard)} ${color} ${parsed.castling} - 0 ${newFullmove}`;
    const checkChess = new Chess(checkFen);
    if (checkChess.isCheck()) {
      return { valid: false, error: 'Drop would leave your king in check' };
    }
  } catch (e) {
    return { valid: false, error: 'Invalid position after drop' };
  }

  return { valid: true, newFen };
}

/**
 * Apply a drop to a chess.js instance.
 *
 * @param {Chess} chessInstance - The chess.js instance to modify
 * @param {string} color - Color dropping ('w' or 'b')
 * @param {string} piece - Piece type (p, n, b, r, q)
 * @param {string} targetSquare - Algebraic notation (e.g., 'e4')
 * @returns {{ success: boolean, newFen?: string, error?: string }}
 */
function applyDrop(chessInstance, color, piece, targetSquare) {
  const result = validateDrop(chessInstance.fen(), color, piece, targetSquare);
  if (!result.valid) return { success: false, error: result.error };

  chessInstance.load(result.newFen);
  return { success: true, newFen: result.newFen };
}

/**
 * Get all legal drop squares for a piece.
 *
 * @param {string} fen - Current board FEN
 * @param {string} color - Color dropping ('w' or 'b')
 * @param {string} piece - Piece type (p, n, b, r, q)
 * @returns {string[]} Array of algebraic squares where the drop is legal
 */
function getLegalDropSquares(fen, color, piece) {
  const squares = [];
  const files = 'abcdefgh';
  for (let rank = 1; rank <= 8; rank++) {
    for (let f = 0; f < 8; f++) {
      const square = files[f] + rank;
      const result = validateDrop(fen, color, piece, square);
      if (result.valid) squares.push(square);
    }
  }
  return squares;
}

/**
 * Check if a position has checkmate (for the side to move).
 * Used after a drop to detect if it delivers checkmate.
 *
 * @param {string} fen - FEN after the drop was applied
 * @returns {boolean}
 */
function isCheckmate(fen) {
  try {
    const chess = new Chess(fen);
    return chess.isCheckmate();
  } catch (e) {
    return false;
  }
}

/**
 * Check if a position has check.
 *
 * @param {string} fen - FEN to check
 * @returns {boolean}
 */
function isCheck(fen) {
  try {
    const chess = new Chess(fen);
    return chess.isCheck();
  } catch (e) {
    return false;
  }
}

/**
 * Generate a SAN-like notation for a drop move.
 * Standard notation: P@e4 (piece @ square)
 *
 * @param {string} piece - Piece type (p, n, b, r, q)
 * @param {string} square - Target square
 * @param {string} newFen - FEN after the drop (for check/checkmate detection)
 * @returns {string}
 */
function dropToSan(piece, square, newFen) {
  const pieceChar = piece.toUpperCase() === 'P' ? 'P' : piece.toUpperCase();
  let san = `${pieceChar}@${square}`;
  if (isCheckmate(newFen)) {
    san += '#';
  } else if (isCheck(newFen)) {
    san += '+';
  }
  return san;
}

module.exports = {
  createEmptyPool,
  createBoardPools,
  addCapturedPiece,
  removePieceFromPool,
  validateDrop,
  applyDrop,
  getLegalDropSquares,
  isCheckmate,
  isCheck,
  dropToSan,
};
