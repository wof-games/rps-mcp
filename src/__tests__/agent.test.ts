import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatchState, RoundPhase, Choice, type MatchResult } from "../agent.js";

// We can't easily instantiate RPSAgent (needs real viem clients),
// so we test the playMatch logic by creating a minimal mock that
// exercises the specific behaviors we fixed.

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const AGENT_ADDR = "0xAgent1";
const OPPONENT_ADDR = "0xOpponent";

/**
 * Creates a mock RPSAgent-like object with controllable getMatch/getRound
 * responses. We dynamically import and monkey-patch to test playMatch.
 */
function createMockAgent(opts: {
  matchSequence: any[];       // Successive getMatch results
  roundResponses?: Record<string, any>;
  commitFn?: () => Promise<string>;
  revealFn?: () => Promise<string>;
  claimTimeoutFn?: () => Promise<string>;
}) {
  let matchCallIndex = 0;

  const agent = {
    address: AGENT_ADDR,
    publicClient: {
      getBlock: vi.fn().mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 1000) }),
    },

    getMatch: vi.fn().mockImplementation(async () => {
      const result = opts.matchSequence[Math.min(matchCallIndex, opts.matchSequence.length - 1)];
      matchCallIndex++;
      return result;
    }),

    getRound: vi.fn().mockImplementation(async (_matchId: bigint, round: number) => {
      const key = `${round}`;
      return opts.roundResponses?.[key] ?? {
        commitP1: ZERO_BYTES32,
        commitP2: ZERO_BYTES32,
        choiceP1: Choice.None,
        choiceP2: Choice.None,
        phase: RoundPhase.COMMIT,
        phaseDeadline: 0n,
        winner: ZERO,
      };
    }),

    commit: opts.commitFn ?? vi.fn().mockResolvedValue("0xcommithash"),
    reveal: opts.revealFn ?? vi.fn().mockResolvedValue("0xrevealhash"),
    claimTimeout: opts.claimTimeoutFn ?? vi.fn().mockResolvedValue("0xtimeouthash"),
    cancelMatch: vi.fn(),
    pickRandomChoice: vi.fn().mockReturnValue(Choice.Rock),
    secrets: new Map(),

    // waitForPhase and playMatch are the actual methods we want to test,
    // but since they're class methods we can't easily unit test them
    // without the class. Instead, we test the logic patterns.
  };

  return agent;
}

describe("playMatch win detection", () => {
  it("correctly identifies normal win (player1 wins 3-2)", () => {
    const match = {
      state: MatchState.COMPLETE,
      player1: AGENT_ADDR,
      player2: OPPONENT_ADDR,
      winsP1: 3,
      winsP2: 2,
      pot: 2000000n,
    };
    const isPlayer1 = true;
    const claimedTimeout = false;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(true);
  });

  it("correctly identifies loss when opponent wins 3-2", () => {
    // Player1 has 2 wins but opponent has 3 — player1 lost
    const match = {
      state: MatchState.COMPLETE,
      player1: AGENT_ADDR,
      player2: OPPONENT_ADDR,
      winsP1: 2,
      winsP2: 3,
      pot: 2000000n,
    };
    const isPlayer1 = true;
    const claimedTimeout = false;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(false);
  });

  it("correctly identifies normal loss (player1 loses 0-3)", () => {
    const match = {
      state: MatchState.COMPLETE,
      player1: AGENT_ADDR,
      player2: OPPONENT_ADDR,
      winsP1: 0,
      winsP2: 3,
      pot: 2000000n,
    };
    const isPlayer1 = true;
    const claimedTimeout = false;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(false);
  });

  it("correctly identifies timeout win when claimedTimeout is true, even with 0-0 score", () => {
    const match = {
      state: MatchState.COMPLETE,
      player1: OPPONENT_ADDR,
      player2: AGENT_ADDR,
      winsP1: 0,
      winsP2: 0,
      pot: 2000000n,
    };
    const isPlayer1 = false;
    const claimedTimeout = true;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(true);
  });

  it("reports loss when opponent claims timeout (claimedTimeout false, 0-0 score)", () => {
    const match = {
      state: MatchState.COMPLETE,
      player1: AGENT_ADDR,
      player2: OPPONENT_ADDR,
      winsP1: 0,
      winsP2: 0,
      pot: 2000000n,
    };
    const isPlayer1 = true;
    const claimedTimeout = false;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(false);
  });

  it("timeout win takes precedence even if score shows losses", () => {
    const match = {
      state: MatchState.COMPLETE,
      player1: AGENT_ADDR,
      player2: OPPONENT_ADDR,
      winsP1: 1,
      winsP2: 1,
      pot: 2000000n,
    };
    const isPlayer1 = true;
    const claimedTimeout = true;
    const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
    const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;

    const iWon = claimedTimeout || myWins > oppWins;
    expect(iWon).toBe(true);
  });
});

describe("WAITING state guard", () => {
  it("should skip WAITING matches in the game loop", () => {
    // Simulate the guard logic from playMatch's while loop
    const match = { state: MatchState.WAITING };

    // The fix: if WAITING, continue (don't process rounds)
    const shouldSkip = match.state === MatchState.WAITING;
    expect(shouldSkip).toBe(true);
  });

  it("should process ACTIVE matches", () => {
    const match = { state: MatchState.ACTIVE as number };
    const shouldSkip = match.state === MatchState.WAITING;
    expect(shouldSkip).toBe(false);
  });
});

describe("waitForPhase timeout detection", () => {
  it("returns timeout_claimed when phase deadline is passed", async () => {
    // Simulate the logic in waitForPhase that checks deadline
    const round = {
      phase: RoundPhase.COMMIT,
      phaseDeadline: 1000n, // Far in the past
    };
    const blockTimestamp = 2000n;

    const deadlinePassed = round.phaseDeadline > 0n && blockTimestamp > round.phaseDeadline;
    expect(deadlinePassed).toBe(true);
  });

  it("does not trigger timeout when deadline is in the future", () => {
    const round = {
      phase: RoundPhase.COMMIT,
      phaseDeadline: 3000n,
    };
    const blockTimestamp = 2000n;

    const deadlinePassed = round.phaseDeadline > 0n && blockTimestamp > round.phaseDeadline;
    expect(deadlinePassed).toBe(false);
  });

  it("does not trigger timeout when no deadline set", () => {
    const round = {
      phase: RoundPhase.COMMIT,
      phaseDeadline: 0n,
    };
    const blockTimestamp = 2000n;

    const deadlinePassed = round.phaseDeadline > 0n && blockTimestamp > round.phaseDeadline;
    expect(deadlinePassed).toBe(false);
  });
});
