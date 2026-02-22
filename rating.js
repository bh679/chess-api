// Glicko-2 Rating System
// Reference: http://www.glicko.net/glicko/glicko2.pdf

const TAU = 0.5;              // System volatility constant
const INITIAL_RATING = 1500;
const INITIAL_RD = 350;
const INITIAL_VOL = 0.06;
const CONVERGENCE_TOL = 0.000001;
const RATING_FLOOR = 100;
const PROVISIONAL_THRESHOLD = 15; // Games before rating is no longer provisional

// Scale factor between Glicko and Glicko-2
const GLICKO2_SCALE = 173.7178;

// Time control classification (FIDE formula: minutes + 40 * increment / 60)
function classifyTimeControl(timeControlStr) {
  if (!timeControlStr || timeControlStr === 'none') return null;

  // Parse "M+S" format (e.g., "5+3", "10+0")
  const match = timeControlStr.match(/^(\d+)\+(\d+)$/);
  if (!match) {
    // Try named formats
    const lower = timeControlStr.toLowerCase();
    if (lower.includes('bullet')) return 'bullet';
    if (lower.includes('blitz')) return 'blitz';
    if (lower.includes('rapid')) return 'rapid';
    if (lower.includes('classical') || lower.includes('classic')) return 'classical';
    return null;
  }

  const minutes = parseInt(match[1], 10);
  const increment = parseInt(match[2], 10);
  const estimatedTotal = minutes + (40 * increment / 60);

  if (estimatedTotal < 3) return 'bullet';
  if (estimatedTotal < 10) return 'blitz';
  if (estimatedTotal < 30) return 'rapid';
  return 'classical';
}

// Convert Glicko rating to Glicko-2 scale
function toGlicko2(rating) {
  return (rating - 1500) / GLICKO2_SCALE;
}

// Convert Glicko-2 rating back to Glicko scale
function fromGlicko2(mu) {
  return mu * GLICKO2_SCALE + 1500;
}

// Convert RD to Glicko-2 scale
function rdToGlicko2(rd) {
  return rd / GLICKO2_SCALE;
}

// Convert RD back from Glicko-2 scale
function rdFromGlicko2(phi) {
  return phi * GLICKO2_SCALE;
}

// g(phi) function — reduces the impact of games against opponents with high RD
function g(phi) {
  return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
}

// E(mu, mu_j, phi_j) — expected score
function E(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

// Core Glicko-2 rating update for a single game
// score: 1 = win, 0.5 = draw, 0 = loss
function updateRating(playerRating, playerRD, playerVol, opponentRating, opponentRD, score) {
  // Step 1: Convert to Glicko-2 scale
  const mu = toGlicko2(playerRating);
  const phi = rdToGlicko2(playerRD);
  const sigma = playerVol;
  const muJ = toGlicko2(opponentRating);
  const phiJ = rdToGlicko2(opponentRD);

  // Step 2: Compute estimated variance v
  const gPhiJ = g(phiJ);
  const eVal = E(mu, muJ, phiJ);
  const v = 1 / (gPhiJ * gPhiJ * eVal * (1 - eVal));

  // Step 3: Compute estimated improvement delta
  const delta = v * gPhiJ * (score - eVal);

  // Step 4: Compute new volatility sigma' using Illinois algorithm
  const a = Math.log(sigma * sigma);
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  function f(x) {
    const ex = Math.exp(x);
    const num1 = ex * (deltaSq - phiSq - v - ex);
    const den1 = 2 * (phiSq + v + ex) * (phiSq + v + ex);
    const num2 = x - a;
    const den2 = TAU * TAU;
    return num1 / den1 - num2 / den2;
  }

  // Find bounds A and B
  let A = a;
  let B;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) {
      k++;
    }
    B = a - k * TAU;
  }

  // Illinois algorithm to find root
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > CONVERGENCE_TOL) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }

  const newSigma = Math.exp(A / 2);

  // Step 5: Update RD to pre-rating period value
  const phiStar = Math.sqrt(phiSq + newSigma * newSigma);

  // Step 6: Update rating and RD
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gPhiJ * (score - eVal);

  // Step 7: Convert back to Glicko scale
  let newRating = fromGlicko2(newMu);
  let newRD = rdFromGlicko2(newPhi);

  // Apply rating floor
  if (newRating < RATING_FLOOR) newRating = RATING_FLOOR;

  // Clamp RD to reasonable bounds
  if (newRD < 30) newRD = 30;
  if (newRD > 350) newRD = 350;

  return {
    rating: Math.round(newRating * 10) / 10,
    rd: Math.round(newRD * 10) / 10,
    volatility: Math.round(newSigma * 100000) / 100000
  };
}

function isProvisional(gamesPlayed) {
  return gamesPlayed < PROVISIONAL_THRESHOLD;
}

module.exports = {
  updateRating,
  classifyTimeControl,
  isProvisional,
  INITIAL_RATING,
  INITIAL_RD,
  INITIAL_VOL,
  PROVISIONAL_THRESHOLD
};
