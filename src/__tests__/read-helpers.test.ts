import { describe, it, expect, vi, beforeEach } from "vitest";
import { findOpenMatches, getMatchDetails, getLeaderboard } from "../read-helpers.js";
import { MatchState } from "../agent.js";

// ─── Mock RPSAgent ───

function createMockAgent(overrides: {
  matchCounter?: bigint;
  matches?: Record<number, any>;
  rounds?: Record<string, any>;
} = {}) {
  const { matchCounter = 1n, matches = {}, rounds = {} } = overrides;

  return {
    address: "0xAgent1" as any,
    publicClient: {},
    arenaAddress: "0xArena" as any,
    usdcAddress: "0xUSDC" as any,
    getMatchCounter: vi.fn().mockResolvedValue(matchCounter),
    getMatch: vi.fn().mockImplementation(async (id: bigint) => {
      const m = matches[Number(id)];
      if (!m) throw new Error(`Match ${id} not found`);
      return m;
    }),
    getRound: vi.fn().mockImplementation(async (matchId: bigint, round: number) => {
      const key = `${matchId}-${round}`;
      return rounds[key] ?? {
        commitP1: "0x0000000000000000000000000000000000000000000000000000000000000000",
        commitP2: "0x0000000000000000000000000000000000000000000000000000000000000000",
        choiceP1: 0,
        choiceP2: 0,
        phase: 0,
        phaseDeadline: 0n,
        winner: "0x0000000000000000000000000000000000000000",
      };
    }),
    getMatches: vi.fn().mockImplementation(async (startId: bigint, endId: bigint) => {
      const result = new Map<bigint, any>();
      for (let id = startId; id <= endId; id++) {
        const m = matches[Number(id)];
        if (m) result.set(id, m);
      }
      return result;
    }),
    getUsdcBalance: vi.fn().mockResolvedValue(10000000n),
    getEthBalance: vi.fn().mockResolvedValue(1000000000000000n),
  } as any;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function makeMatch(overrides: Partial<{
  player1: string;
  player2: string;
  entryFee: bigint;
  pot: bigint;
  state: number;
  winsP1: number;
  winsP2: number;
  currentRound: number;
  createdAt: bigint;
  startedAt: bigint;
}> = {}) {
  return {
    player1: "0xPlayer1",
    player2: ZERO,
    entryFee: 1000000n,
    pot: 1000000n,
    state: MatchState.WAITING,
    winsP1: 0,
    winsP2: 0,
    currentRound: 0,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    startedAt: 0n,
    ...overrides,
  };
}

// ─── findOpenMatches ───

describe("findOpenMatches", () => {
  it("returns matches in WAITING state", async () => {
    const agent = createMockAgent({
      matchCounter: 2n,
      matches: {
        1: makeMatch({ state: MatchState.COMPLETE, player2: "0xP2" }),
        2: makeMatch({ state: MatchState.WAITING }),
      },
    });

    const result = await findOpenMatches(agent);
    expect(result).toHaveLength(1);
    expect(result[0].matchId).toBe(2);
    expect(result[0].state).toBe("Waiting");
  });

  it("excludes CANCELLED, COMPLETE, and ACTIVE matches", async () => {
    const agent = createMockAgent({
      matchCounter: 3n,
      matches: {
        1: makeMatch({ state: MatchState.CANCELLED }),
        2: makeMatch({ state: MatchState.COMPLETE, player2: "0xP2", winsP1: 3 }),
        3: makeMatch({ state: MatchState.ACTIVE, player2: "0xP2", currentRound: 1 }),
      },
    });

    const result = await findOpenMatches(agent);
    expect(result).toHaveLength(0);
  });

  it("uses 10-minute JOIN_TIMEOUT for waiting matches", async () => {
    const now = Math.floor(Date.now() / 1000);

    const agent = createMockAgent({
      matchCounter: 3n,
      matches: {
        // Created 3 minutes ago — should be INCLUDED (within 10 min)
        1: makeMatch({ createdAt: BigInt(now - 180) }),
        // Created 9 minutes ago — should be INCLUDED (within 10 min)
        2: makeMatch({ createdAt: BigInt(now - 540) }),
        // Created 11 minutes ago — should be EXCLUDED (past 10 min)
        3: makeMatch({ createdAt: BigInt(now - 660) }),
      },
    });

    const result = await findOpenMatches(agent);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.matchId)).toEqual([1, 2]);
  });

  it("excludes matches older than 10 minutes", async () => {
    const now = Math.floor(Date.now() / 1000);

    const agent = createMockAgent({
      matchCounter: 1n,
      matches: {
        // Created 11 minutes ago — excluded by JOIN_TIMEOUT (10 min)
        1: makeMatch({ createdAt: BigInt(now - 660) }),
      },
    });

    const result = await findOpenMatches(agent);
    expect(result).toHaveLength(0);
  });
});

// ─── getMatchDetails ───

describe("getMatchDetails", () => {
  describe("winner field", () => {
    it("returns player1 address when player1 wins 3-2", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({
            state: MatchState.COMPLETE,
            player1: "0xWinner",
            player2: "0xLoser",
            winsP1: 3,
            winsP2: 2,
            currentRound: 5,
            pot: 0n, // pot zeroed after completion (CEI pattern)
          }),
        },
        rounds: {
          "1-1": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
          "1-2": { commitP1: "0x1", commitP2: "0x1", choiceP1: 2, choiceP2: 1, phase: 2, phaseDeadline: 0n, winner: "0xLoser" },
          "1-3": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
          "1-4": { commitP1: "0x1", commitP2: "0x1", choiceP1: 3, choiceP2: 1, phase: 2, phaseDeadline: 0n, winner: "0xLoser" },
          "1-5": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.winner).toBe("0xWinner");
      expect(details.state).toBe("Complete");
    });

    it("returns player2 address when player2 wins 3-0", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({
            state: MatchState.COMPLETE,
            player1: "0xLoser",
            player2: "0xWinner",
            winsP1: 0,
            winsP2: 3,
            currentRound: 3,
            pot: 0n,
          }),
        },
        rounds: {
          "1-1": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 2, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
          "1-2": { commitP1: "0x1", commitP2: "0x1", choiceP1: 3, choiceP2: 1, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
          "1-3": { commitP1: "0x1", commitP2: "0x1", choiceP1: 2, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xWinner" },
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.winner).toBe("0xWinner");
    });

    it("returns timeout winner when match complete but equal score (commit timeout)", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({
            state: MatchState.COMPLETE,
            player1: "0xP1",
            player2: "0xP2",
            winsP1: 0,
            winsP2: 0,
            currentRound: 1,
            pot: 0n,
          }),
        },
        rounds: {
          "1-1": { commitP1: "0x1", commitP2: "0x0000000000000000000000000000000000000000000000000000000000000000", choiceP1: 0, choiceP2: 0, phase: 0, phaseDeadline: 100n, winner: ZERO },
        },
      });

      const details = await getMatchDetails(agent, 1);
      // P1 committed, P2 didn't — P1 wins the timeout
      expect(details.winner).toBe("0xP1");
    });

    it("returns null for non-complete matches", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({ state: MatchState.WAITING }),
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.winner).toBeNull();
    });

    it("returns null for cancelled matches", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({ state: MatchState.CANCELLED, player2: "0xP2" }),
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.winner).toBeNull();
    });

    it("returns null for active matches", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({ state: MatchState.ACTIVE, player2: "0xP2", currentRound: 1 }),
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.winner).toBeNull();
    });
  });

  it("shows pot derived from entryFee even when pot is zeroed (CEI fix regression)", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({
            state: MatchState.COMPLETE,
            player1: "0xP1",
            player2: "0xP2",
            winsP1: 3,
            winsP2: 0,
            currentRound: 3,
            entryFee: 1000000n, // 1 USDC
            pot: 0n, // zeroed after completion
          }),
        },
        rounds: {
          "1-1": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xP1" },
          "1-2": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 0n, winner: "0xP1" },
        },
      });

      const details = await getMatchDetails(agent, 1);
      // Should show 2.00 USDC (entryFee * 2) not 0.00 USDC
      expect(details.pot).toBe("2.00 USDC");
    });

    it("shows entryFee as pot for waiting matches (single player)", async () => {
      const agent = createMockAgent({
        matchCounter: 1n,
        matches: {
          1: makeMatch({
            state: MatchState.WAITING,
            player1: "0xP1",
            player2: "0x0000000000000000000000000000000000000000",
            entryFee: 5000000n, // 5 USDC
            pot: 5000000n,
          }),
        },
      });

      const details = await getMatchDetails(agent, 1);
      expect(details.pot).toBe("5.00 USDC");
    });

  it("includes all round data", async () => {
    const agent = createMockAgent({
      matchCounter: 1n,
      matches: {
        1: makeMatch({
          state: MatchState.COMPLETE,
          player1: "0xP1",
          player2: "0xP2",
          winsP1: 3,
          winsP2: 0,
          currentRound: 3,
          pot: 0n,
        }),
      },
      rounds: {
        "1-1": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 1000n, winner: "0xP1" },
        "1-2": { commitP1: "0x1", commitP2: "0x1", choiceP1: 2, choiceP2: 1, phase: 2, phaseDeadline: 2000n, winner: "0xP1" },
        "1-3": { commitP1: "0x1", commitP2: "0x1", choiceP1: 1, choiceP2: 3, phase: 2, phaseDeadline: 3000n, winner: "0xP1" },
      },
    });

    const details = await getMatchDetails(agent, 1);
    expect(details.rounds).toHaveLength(3);
    expect(details.rounds[0].choiceP1).toBe("Rock");
    expect(details.rounds[0].choiceP2).toBe("Scissors");
    expect(details.rounds[1].choiceP1).toBe("Paper");
    expect(details.rounds[1].choiceP2).toBe("Rock");
    expect(details.rounds[2].choiceP1).toBe("Rock");
    expect(details.rounds[2].choiceP2).toBe("Scissors");
  });
});

// ─── getLeaderboard ───

describe("getLeaderboard", () => {
  it("counts only COMPLETE matches, skips WAITING and CANCELLED", async () => {
    const agent = createMockAgent({
      matchCounter: 3n,
      matches: {
        1: makeMatch({
          state: MatchState.COMPLETE,
          player1: "0xAlice",
          player2: "0xBob",
          entryFee: 1000000n,
          winsP1: 3,
          winsP2: 1,
          currentRound: 4,
        }),
        2: makeMatch({ state: MatchState.CANCELLED, player1: "0xAlice" }),
        3: makeMatch({ state: MatchState.WAITING, player1: "0xCharlie" }),
      },
    });

    const result = await getLeaderboard(agent);
    expect(result.totalMatches).toBe(1);
    expect(result.players).toHaveLength(2); // Alice and Bob only
  });

  it("computes player stats correctly for a completed match", async () => {
    const agent = createMockAgent({
      matchCounter: 1n,
      matches: {
        1: makeMatch({
          state: MatchState.COMPLETE,
          player1: "0xAlice",
          player2: "0xBob",
          entryFee: 5000000n, // 5 USDC
          winsP1: 3,
          winsP2: 0,
          currentRound: 3,
        }),
      },
    });

    const result = await getLeaderboard(agent);
    expect(result.totalMatches).toBe(1);
    expect(result.totalVolume).toBe("10.00 USDC");

    const alice = result.players.find(p => p.address === "0xAlice")!;
    expect(alice.matchesWon).toBe(1);
    expect(alice.matchesLost).toBe(0);
    expect(alice.roundsWon).toBe(3);
    expect(alice.roundsLost).toBe(0);
    expect(alice.winRate).toBe("100%");

    const bob = result.players.find(p => p.address === "0xBob")!;
    expect(bob.matchesWon).toBe(0);
    expect(bob.matchesLost).toBe(1);
  });

  it("sorts players by wins descending", async () => {
    const agent = createMockAgent({
      matchCounter: 2n,
      matches: {
        1: makeMatch({
          state: MatchState.COMPLETE,
          player1: "0xAlice",
          player2: "0xBob",
          entryFee: 1000000n,
          winsP1: 0,
          winsP2: 3,
          currentRound: 3,
        }),
        2: makeMatch({
          state: MatchState.COMPLETE,
          player1: "0xBob",
          player2: "0xAlice",
          entryFee: 1000000n,
          winsP1: 3,
          winsP2: 0,
          currentRound: 3,
        }),
      },
    });

    const result = await getLeaderboard(agent);
    // Bob won both matches
    expect(result.players[0].address).toBe("0xBob");
    expect(result.players[0].matchesWon).toBe(2);
  });
});
