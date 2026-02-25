import type { Address } from "viem";
import { RPSAgent, MatchState, Choice, formatUsdc, formatEthBalance, type MatchInfo } from "./agent.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const STATE_NAMES = ["Waiting", "Active", "Complete", "Cancelled"];
const JOIN_TIMEOUT = 600; // 10 minutes, matches contract's JOIN_TIMEOUT for waiting matches
const WINS_REQUIRED = 3;

/**
 * Find matches in WAITING state (available to join).
 * Scans the most recent matches for open ones.
 */
export async function findOpenMatches(agent: RPSAgent): Promise<MatchInfo[]> {
  const counter = await agent.getMatchCounter();
  const open: MatchInfo[] = [];

  // Scan last 50 matches (or all if fewer)
  const start = counter > 50n ? counter - 50n + 1n : 1n;

  const allMatches = await agent.getMatches(start, counter);

  for (const [id, match] of allMatches) {
    if (match.state === MatchState.WAITING) {
      // Check join timeout (10 min)
      const now = Math.floor(Date.now() / 1000);
      if (now <= Number(match.createdAt) + JOIN_TIMEOUT) {
        open.push({
          matchId: Number(id),
          player1: match.player1,
          player2: match.player2,
          entryFee: formatUsdc(match.entryFee) + " USDC",
          pot: formatUsdc(match.pot) + " USDC",
          state: STATE_NAMES[match.state],
          winsP1: match.winsP1,
          winsP2: match.winsP2,
          currentRound: match.currentRound,
          createdAt: Number(match.createdAt),
          startedAt: Number(match.startedAt),
        });
      }
    }
  }

  return open;
}

/**
 * Get detailed info about a specific match, including round data.
 */
export async function getMatchDetails(agent: RPSAgent, matchId: number) {
  const mid = BigInt(matchId);
  const match = await agent.getMatch(mid);

  const rounds = [];
  let lastRawRound: { commitP1: string; commitP2: string; choiceP1: number; choiceP2: number } | undefined;
  const maxRound = match.currentRound;
  for (let r = 1; r <= maxRound; r++) {
    try {
      const round = await agent.getRound(mid, r);
      rounds.push({
        round: r,
        phase: ["Commit", "Reveal", "Complete"][round.phase],
        choiceP1: ["None", "Rock", "Paper", "Scissors"][round.choiceP1],
        choiceP2: ["None", "Rock", "Paper", "Scissors"][round.choiceP2],
        winner: round.winner === ZERO_ADDRESS ? "Draw" : round.winner,
        phaseDeadline: round.phaseDeadline > 0n ? Number(round.phaseDeadline) : null,
      });
      lastRawRound = {
        commitP1: round.commitP1,
        commitP2: round.commitP2,
        choiceP1: round.choiceP1,
        choiceP2: round.choiceP2,
      };
    } catch {
      break;
    }
  }

  // Determine winner (handles both normal and timeout/forfeit wins)
  let winner: string | null = null;
  if (match.state === MatchState.COMPLETE) {
    winner = determineMatchWinner(
      { player1: match.player1, player2: match.player2, state: match.state, winsP1: match.winsP1, winsP2: match.winsP2 },
      lastRawRound,
    ) ?? "timeout";
  }

  return {
    matchId,
    player1: match.player1,
    player2: match.player2 === ZERO_ADDRESS ? "None (waiting)" : match.player2,
    entryFee: formatUsdc(match.entryFee) + " USDC",
    pot: formatUsdc(match.player2 !== ZERO_ADDRESS ? match.entryFee * 2n : match.entryFee) + " USDC",
    state: STATE_NAMES[match.state],
    winner,
    score: `${match.winsP1} - ${match.winsP2}`,
    currentRound: match.currentRound,
    createdAt: new Date(Number(match.createdAt) * 1000).toISOString(),
    rounds,
  };
}

interface PlayerStats {
  address: string;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  roundsWon: number;
  roundsLost: number;
  winRate: string;
  totalWagered: string;
  profitLoss: string;
}

/**
 * Build leaderboard from completed matches.
 */
export async function getLeaderboard(agent: RPSAgent): Promise<{
  players: PlayerStats[];
  totalMatches: number;
  totalVolume: string;
}> {
  const counter = await agent.getMatchCounter();
  const statsMap = new Map<string, {
    address: string;
    matchesPlayed: number;
    matchesWon: number;
    matchesLost: number;
    roundsWon: number;
    roundsLost: number;
    totalEarnings: bigint;
    totalWagered: bigint;
  }>();

  let volume = 0n;
  let completedMatches = 0;

  const allMatches = await agent.getMatches(1n, counter);

  // Collect forfeit matches (COMPLETE but neither player reached WINS_REQUIRED)
  // so we can batch-fetch their last round to determine the winner
  const forfeitRounds = new Map<string, { commitP1: string; commitP2: string; choiceP1: number; choiceP2: number }>();
  for (const [matchId, match] of allMatches) {
    if (match.state === MatchState.COMPLETE && match.winsP1 < WINS_REQUIRED && match.winsP2 < WINS_REQUIRED && match.currentRound > 0) {
      try {
        const round = await agent.getRound(matchId, match.currentRound);
        forfeitRounds.set(`${matchId}-${match.currentRound}`, {
          commitP1: round.commitP1,
          commitP2: round.commitP2,
          choiceP1: round.choiceP1,
          choiceP2: round.choiceP2,
        });
      } catch { /* skip if round can't be fetched */ }
    }
  }

  for (const [matchId, match] of allMatches) {
    if (match.state !== MatchState.COMPLETE) continue;

    completedMatches++;
    const p1 = match.player1.toLowerCase();
    const p2 = match.player2.toLowerCase();

    if (!statsMap.has(p1)) {
      statsMap.set(p1, { address: match.player1, matchesPlayed: 0, matchesWon: 0, matchesLost: 0, roundsWon: 0, roundsLost: 0, totalEarnings: 0n, totalWagered: 0n });
    }
    if (p2 !== ZERO_ADDRESS && !statsMap.has(p2)) {
      statsMap.set(p2, { address: match.player2, matchesPlayed: 0, matchesWon: 0, matchesLost: 0, roundsWon: 0, roundsLost: 0, totalEarnings: 0n, totalWagered: 0n });
    }

    const s1 = statsMap.get(p1)!;
    const s2 = p2 !== ZERO_ADDRESS ? statsMap.get(p2)! : null;

    s1.matchesPlayed++;
    s1.totalWagered += match.entryFee;
    s1.roundsWon += match.winsP1;
    s1.roundsLost += match.winsP2;

    if (s2) {
      s2.matchesPlayed++;
      s2.totalWagered += match.entryFee;
      s2.roundsWon += match.winsP2;
      s2.roundsLost += match.winsP1;
      volume += match.entryFee * 2n;
    }

    // Determine winner (handles both normal and forfeit/timeout wins)
    const lastRound = forfeitRounds.get(`${matchId}-${match.currentRound}`);
    const winner = determineMatchWinner(match, lastRound);
    const originalPot = match.entryFee * 2n;
    const prize = (originalPot * 98n) / 100n;

    if (winner) {
      const winnerIsP1 = winner.toLowerCase() === p1;
      if (winnerIsP1) {
        s1.matchesWon++;
        s1.totalEarnings += prize;
        if (s2) s2.matchesLost++;
      } else {
        s1.matchesLost++;
        if (s2) {
          s2.matchesWon++;
          s2.totalEarnings += prize;
        }
      }
    }
  }

  const players: PlayerStats[] = [];
  statsMap.forEach((s) => {
    if (s.matchesPlayed > 0) {
      const winRate = ((s.matchesWon / s.matchesPlayed) * 100).toFixed(0);
      const profitLoss = s.totalEarnings - s.totalWagered;
      players.push({
        address: s.address,
        matchesPlayed: s.matchesPlayed,
        matchesWon: s.matchesWon,
        matchesLost: s.matchesLost,
        roundsWon: s.roundsWon,
        roundsLost: s.roundsLost,
        winRate: `${winRate}%`,
        totalWagered: formatUsdc(s.totalWagered) + " USDC",
        profitLoss: (profitLoss >= 0n ? "+" : "") + formatUsdc(profitLoss) + " USDC",
      });
    }
  });

  // Sort by wins, then profit
  players.sort((a, b) => {
    if (b.matchesWon !== a.matchesWon) return b.matchesWon - a.matchesWon;
    return 0;
  });

  return {
    players,
    totalMatches: completedMatches,
    totalVolume: formatUsdc(volume) + " USDC",
  };
}

/**
 * Determine the true winner of a completed match, handling both normal and forfeit/timeout wins.
 */
function determineMatchWinner(
  match: { player1: string; player2: string; state: number; winsP1: number; winsP2: number },
  lastRound?: { commitP1: string; commitP2: string; choiceP1: number; choiceP2: number },
): string | null {
  if (match.state !== MatchState.COMPLETE) return null;

  // Normal wins — one player reached WINS_REQUIRED
  if (match.winsP1 >= WINS_REQUIRED) return match.player1;
  if (match.winsP2 >= WINS_REQUIRED) return match.player2;

  // Forfeit: neither player reached WINS_REQUIRED. Use last round to determine who timed out.
  if (lastRound) {
    const p1Committed = lastRound.commitP1 !== ZERO_BYTES32;
    const p2Committed = lastRound.commitP2 !== ZERO_BYTES32;

    // Commit phase timeout: one player committed, the other didn't
    if (p1Committed && !p2Committed) return match.player1;
    if (p2Committed && !p1Committed) return match.player2;

    // Reveal phase timeout: both committed, but only one revealed
    if (p1Committed && p2Committed) {
      const p1Revealed = lastRound.choiceP1 > 0;
      const p2Revealed = lastRound.choiceP2 > 0;
      if (p1Revealed && !p2Revealed) return match.player1;
      if (p2Revealed && !p1Revealed) return match.player2;
    }
  }

  // Fallback: compare round-win counts
  if (match.winsP1 > match.winsP2) return match.player1;
  if (match.winsP2 > match.winsP1) return match.player2;

  return null;
}

/**
 * Get agent's ETH and USDC balances.
 */
export async function getBalance(agent: RPSAgent) {
  const [ethBalance, usdcBalance] = await Promise.all([
    agent.getEthBalance(),
    agent.getUsdcBalance(),
  ]);

  return {
    address: agent.address,
    eth: formatEthBalance(ethBalance) + " ETH",
    usdc: formatUsdc(usdcBalance) + " USDC",
  };
}
