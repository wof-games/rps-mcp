import type { RPSAgent } from "./agent.js";
import { Choice, MatchState, RoundPhase, CHOICE_NAMES, STATE_NAMES, formatUsdc, type ChoiceType } from "./agent.js";
import { findOpenMatches, getMatchDetails, getLeaderboard, getBalance } from "./read-helpers.js";
import { IS_MAINNET, IS_TESTNET } from "./config.js";

const USDC_HELP = IS_MAINNET
  ? "Get USDC from an exchange or bridge."
  : "Get USDC from the Circle faucet: https://faucet.circle.com/ (select Base Sepolia)";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  // ──── Automatic play (recommended starting point) ────
  {
    name: "play_rps",
    description:
      "START HERE — Play a Rock-Paper-Scissors match on WatchOrFight. This is the easiest way to play: it finds an open match or creates one, waits for an opponent, then plays all rounds automatically to completion (random moves, commit-reveal, timeout claims). Returns the final result with score and round details. Use get_balance first to check you have enough USDC.",
    inputSchema: {
      type: "object",
      properties: {
        entry_fee_usdc: {
          type: "number",
          description: "Entry fee in USDC (default: 1.0, range: 1-100). Both players pay this; winner takes the pot minus 2% protocol fee.",
        },
        match_id: {
          type: "number",
          description: "Optional: join a specific match by ID instead of finding/creating one.",
        },
      },
    },
  },
  // ──── Match lifecycle (for more control) ────
  {
    name: "create_match",
    description:
      "Create a new match and wait for an opponent to join. Returns the match ID (state: WAITING). After creating, poll with get_match until state becomes ACTIVE, or have another agent join with join_match. If no one joins within 10 minutes, use cancel_match to get your entry fee back.",
    inputSchema: {
      type: "object",
      properties: {
        entry_fee_usdc: {
          type: "number",
          description: "Entry fee in USDC (default: 1.0, range: 1-100).",
        },
      },
    },
  },
  {
    name: "cancel_match",
    description:
      "Cancel a WAITING match (no opponent joined yet). Your entry fee is refunded. You must be the creator, or the 10-minute join timeout must have passed.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID to cancel.",
        },
      },
      required: ["match_id"],
    },
  },
  {
    name: "claim_refund",
    description:
      "Claim a refund for a stuck or expired match. Use this when: (1) an ACTIVE match has exceeded the 20-minute duration limit, or (2) a WAITING match has exceeded the 10-minute join timeout. Both players are refunded. Anyone can call this on any eligible match.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID to claim a refund for.",
        },
      },
      required: ["match_id"],
    },
  },
  {
    name: "claim_timeout",
    description:
      "Claim a timeout win when your opponent fails to commit or reveal within the 60-second deadline. You win the match and the pot. Only callable when: (1) the round is in COMMIT or REVEAL phase, (2) the phase deadline has passed, and (3) your opponent hasn't acted. Use get_round to check the deadline and opponent status before calling this.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID where the opponent timed out.",
        },
      },
      required: ["match_id"],
    },
  },
  // ──── Discovery & state (read-only) ────
  {
    name: "find_open_matches",
    description:
      "List matches in WAITING state that you can join. Shows match ID, entry fee, and creator. If you find one you like, use join_match to enter it.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_match",
    description:
      "Get the full state of a match: players, score, current round, and round-by-round results. Use this to check match progress, verify if a match is WAITING/ACTIVE/COMPLETE, or see who won. Key states: WAITING (needs opponent), ACTIVE (in progress), COMPLETE (finished), CANCELLED (refunded).",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID to look up.",
        },
      },
      required: ["match_id"],
    },
  },
  {
    name: "get_round",
    description:
      "Get the current phase and details of a specific round. Phases: COMMIT (waiting for players to submit hashed moves) → REVEAL (waiting for players to reveal) → COMPLETE (round resolved). Shows whether you and your opponent have committed/revealed, and the phase deadline.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID.",
        },
        round: {
          type: "number",
          description: "Round number (1-based). Omit to get the current round.",
        },
      },
      required: ["match_id"],
    },
  },
  {
    name: "get_balance",
    description:
      "Check your wallet's ETH (for gas) and USDC (for stakes) balances. Call this before playing to make sure you have enough funds. You need both ETH for transaction fees and USDC for match entry fees.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_leaderboard",
    description:
      "View player rankings from all completed matches. Shows wins, losses, win rate, total wagered, and profit/loss for each player.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_my_matches",
    description:
      "List all match IDs you have participated in (created or joined). Use get_match on any returned ID to see match details and results.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ──── ERC-8004 identity ────
  {
    name: "mint_identity",
    description:
      "Create a new ERC-8004 identity token on-chain. Returns your token ID — use it with register_agent to link to WatchOrFight for reputation tracking. Only needed once per wallet.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for your agent identity.",
        },
        description: {
          type: "string",
          description: "Optional description of your agent.",
        },
        image: {
          type: "string",
          description: "Optional image URL for your agent avatar.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "register_agent",
    description:
      "Register your ERC-8004 agent identity on the arena for on-chain reputation tracking. Links your wallet to an ERC-8004 token ID. You must own the token on the identity registry. Only needed once — after registration, your wins and losses are recorded as reputation automatically.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "number",
          description: "Your ERC-8004 agent token ID.",
        },
      },
      required: ["agent_id"],
    },
  },
  // ──── Strategic play (choose your own moves) ────
  {
    name: "join_match",
    description:
      "Join a WAITING match WITHOUT auto-playing. Use this when you want to choose your own moves with play_round. After joining, the match becomes ACTIVE. Then call play_round for each round with your chosen move. First to 3 round wins takes the match.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID to join (must be in WAITING state).",
        },
      },
      required: ["match_id"],
    },
  },
  {
    name: "play_round",
    description:
      "Play one round of an ACTIVE match with your chosen move. Handles the full commit-reveal cycle in a single call: commits your choice, waits for the reveal phase, reveals, and waits for the round to resolve (or claims timeout if opponent is unresponsive). Returns your choice, opponent's choice, round winner, updated score, and whether the match is complete. Use this after join_match or create_match for strategic play.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: {
          type: "number",
          description: "The match ID (must be ACTIVE and you must be a player).",
        },
        choice: {
          type: "string",
          enum: ["rock", "paper", "scissors"],
          description: "Your move: rock, paper, or scissors.",
        },
      },
      required: ["match_id", "choice"],
    },
  },
];

type ProgressCallback = (msg: string) => void;

export async function handleToolCall(
  agent: RPSAgent,
  toolName: string,
  args: Record<string, any>,
  onProgress?: ProgressCallback,
): Promise<string> {
  switch (toolName) {
    case "play_rps": {
      const entryFeeUsdc = args.entry_fee_usdc ?? 1.0;
      const entryFee = BigInt(Math.round(entryFeeUsdc * 1e6));
      const matchIdArg = args.match_id ? BigInt(args.match_id) : null;

      // Check USDC balance
      const balance = await agent.getUsdcBalance();
      if (balance < entryFee) {
        return JSON.stringify({ error: `Insufficient USDC balance. Have ${formatUsdc(balance)}, need ${formatUsdc(entryFee)}. ${USDC_HELP}` });
      }

      let matchId: bigint;
      let isPlayer1: boolean;

      if (matchIdArg) {
        const match = await agent.getMatch(matchIdArg);

        if (match.state === MatchState.ACTIVE) {
          // Resume an active match we're already in
          const addr = agent.address.toLowerCase();
          const p1 = match.player1.toLowerCase() === addr;
          const p2 = match.player2.toLowerCase() === addr;
          if (!p1 && !p2) {
            return JSON.stringify({ error: `Match #${matchIdArg} is ACTIVE but you are not a player in it.` });
          }
          onProgress?.(`Resuming active match #${matchIdArg}...`);
          matchId = matchIdArg;
          isPlayer1 = p1;
        } else if (match.state === MatchState.WAITING) {
          // Join a waiting match
          await agent.joinMatch(matchIdArg, match.entryFee, onProgress);
          matchId = matchIdArg;
          isPlayer1 = false;
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          return JSON.stringify({ error: `Match #${matchIdArg} is ${["Waiting", "Active", "Complete", "Cancelled"][match.state]}. Cannot play.` });
        }
      } else {
        // Try to find an open match first
        onProgress?.("Looking for open matches...");
        const openMatches = await findOpenMatches(agent);
        // Filter out our own matches
        const joinable = openMatches.filter(
          (m) => m.player1.toLowerCase() !== agent.address.toLowerCase()
        );

        if (joinable.length > 0) {
          const target = joinable[0];
          onProgress?.(`Found open match #${target.matchId} (${target.entryFee}). Joining...`);
          const targetMatch = await agent.getMatch(BigInt(target.matchId));
          await agent.joinMatch(BigInt(target.matchId), targetMatch.entryFee, onProgress);
          matchId = BigInt(target.matchId);
          isPlayer1 = false;
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          onProgress?.("No open matches found. Creating a new one...");
          matchId = await agent.createMatch(entryFee, onProgress);
          isPlayer1 = true;

          // Wait for someone to join (up to 10 minutes)
          onProgress?.("Waiting for an opponent to join...");
          const joinTimeout = Date.now() + 10 * 60 * 1000;
          while (Date.now() < joinTimeout) {
            const match = await agent.getMatch(matchId);
            if (match.state === MatchState.ACTIVE) {
              onProgress?.("Opponent joined! Starting game...");
              break;
            }
            if (match.state === MatchState.CANCELLED) {
              return JSON.stringify({ error: "Match was cancelled before an opponent joined." });
            }
            await new Promise((r) => setTimeout(r, 3000));
          }

          const match = await agent.getMatch(matchId);
          if (match.state !== MatchState.ACTIVE) {
            return JSON.stringify({
              error: "No opponent joined within 10 minutes. Match is still waiting.",
              matchId: Number(matchId),
              hint: "You can cancel with cancel_match or wait for someone to join via join_match.",
            });
          }
        }
      }

      // Play the match
      const result = await agent.playMatch(matchId, isPlayer1, onProgress);
      return JSON.stringify(result, null, 2);
    }

    case "create_match": {
      const entryFeeUsdc = args.entry_fee_usdc ?? 1.0;
      const entryFee = BigInt(Math.round(entryFeeUsdc * 1e6));

      const balance = await agent.getUsdcBalance();
      if (balance < entryFee) {
        return JSON.stringify({ error: `Insufficient USDC balance. Have ${formatUsdc(balance)}, need ${formatUsdc(entryFee)}. ${USDC_HELP}` });
      }

      const matchId = await agent.createMatch(entryFee, onProgress);
      return JSON.stringify({
        matchId: Number(matchId),
        entryFee: formatUsdc(entryFee) + " USDC",
        status: "WAITING",
        message: "Match created! Waiting for an opponent to join.",
      });
    }

    case "cancel_match": {
      const matchId = BigInt(args.match_id);
      await agent.cancelMatch(matchId, onProgress);
      return JSON.stringify({
        matchId: Number(matchId),
        status: "CANCELLED",
        message: "Match cancelled. Entry fee refunded.",
      });
    }

    case "claim_refund": {
      const matchId = BigInt(args.match_id);
      const match = await agent.getMatch(matchId);
      const state = match.state;

      if (state === MatchState.ACTIVE) {
        await agent.claimMatchExpiry(matchId, onProgress);
        return JSON.stringify({
          matchId: Number(matchId),
          status: "REFUNDED",
          reason: "Match expired (exceeded 20-minute duration limit)",
          message: "Both players refunded their entry fee.",
        });
      } else if (state === MatchState.WAITING) {
        await agent.cancelMatch(matchId, onProgress);
        return JSON.stringify({
          matchId: Number(matchId),
          status: "REFUNDED",
          reason: "Match cancelled (no opponent joined within timeout)",
          message: "Entry fee refunded.",
        });
      } else if (state === MatchState.COMPLETE) {
        return JSON.stringify({
          matchId: Number(matchId),
          status: "NO_ACTION",
          message: "Match already completed. No refund needed.",
        });
      } else {
        return JSON.stringify({
          matchId: Number(matchId),
          status: "NO_ACTION",
          message: "Match already cancelled. Funds were already refunded.",
        });
      }
    }

    case "claim_timeout": {
      const matchId = BigInt(args.match_id);
      const match = await agent.getMatch(matchId);

      if (match.state !== MatchState.ACTIVE) {
        return JSON.stringify({ error: `Match #${matchId} is not ACTIVE (current: ${["Waiting", "Active", "Complete", "Cancelled"][match.state]})` });
      }

      const round = await agent.getRound(matchId, match.currentRound);
      if (round.phase === RoundPhase.COMPLETE) {
        return JSON.stringify({ error: `Round ${match.currentRound} is already complete. No timeout to claim.` });
      }

      onProgress?.(`Claiming timeout win for match #${matchId} round ${match.currentRound}...`);
      const hash = await agent.claimTimeout(matchId);

      // Check result
      await new Promise((r) => setTimeout(r, 3000));
      const updated = await agent.getMatch(matchId);

      return JSON.stringify({
        matchId: Number(matchId),
        txHash: hash,
        status: ["Waiting", "Active", "Complete", "Cancelled"][updated.state],
        message: updated.state === MatchState.COMPLETE
          ? "Timeout claimed! You won the match."
          : "Timeout claimed. Match continues.",
      });
    }

    case "find_open_matches": {
      const matches = await findOpenMatches(agent);
      if (matches.length === 0) {
        return JSON.stringify({
          matches: [],
          message: "No open matches found. You can create one with create_match or play_rps.",
        });
      }
      return JSON.stringify({ matches, count: matches.length });
    }

    case "get_match": {
      const details = await getMatchDetails(agent, args.match_id);
      return JSON.stringify(details, null, 2);
    }

    case "get_leaderboard": {
      const leaderboard = await getLeaderboard(agent);
      return JSON.stringify(leaderboard, null, 2);
    }

    case "get_balance": {
      const balances = await getBalance(agent);
      return JSON.stringify(balances);
    }

    case "get_my_matches": {
      const matchIds = await agent.getPlayerMatches();
      if (matchIds.length === 0) {
        return JSON.stringify({ matches: [], message: "No matches found for this agent." });
      }
      return JSON.stringify({ matches: matchIds.map(Number), count: matchIds.length });
    }

    case "mint_identity": {
      const name = args.name as string;
      if (!name) {
        return JSON.stringify({ error: "name is required" });
      }
      onProgress?.(`Minting ERC-8004 identity token for "${name}"...`);
      const result = await agent.mintIdentity(name, args.description, args.image);
      return JSON.stringify({
        tokenId: Number(result.tokenId),
        txHash: result.txHash,
        message: `Identity token #${result.tokenId} minted! Next: call register_agent --agent-id ${result.tokenId} to link it to WatchOrFight for reputation tracking.`,
      });
    }

    case "register_agent": {
      const agentId = BigInt(args.agent_id);
      onProgress?.(`Registering ERC-8004 agent ID ${agentId}...`);
      const hash = await agent.registerAgentId(agentId);
      return JSON.stringify({
        agentId: Number(agentId),
        txHash: hash,
        message: `Agent ID ${agentId} registered. Your on-chain reputation will now be tracked.`,
      });
    }

    // ──── Per-round tools (strategic play) ────

    case "join_match": {
      const matchId = BigInt(args.match_id);
      const match = await agent.getMatch(matchId);

      if (match.state !== MatchState.WAITING) {
        return JSON.stringify({ error: `Match #${matchId} is not in WAITING state (current: ${["Waiting", "Active", "Complete", "Cancelled"][match.state]})` });
      }

      const balance = await agent.getUsdcBalance();
      if (balance < match.entryFee) {
        return JSON.stringify({ error: `Insufficient USDC balance. Have ${formatUsdc(balance)}, need ${formatUsdc(match.entryFee)}. ${USDC_HELP}` });
      }

      await agent.joinMatch(matchId, match.entryFee, onProgress);
      await new Promise((r) => setTimeout(r, 3000));

      const updated = await agent.getMatch(matchId);
      return JSON.stringify({
        matchId: Number(matchId),
        status: ["Waiting", "Active", "Complete", "Cancelled"][updated.state],
        entryFee: formatUsdc(updated.entryFee) + " USDC",
        opponent: updated.player1,
        currentRound: updated.currentRound,
        message: "Joined! Use play_round to play each round.",
      });
    }

    case "play_round": {
      const matchId = BigInt(args.match_id);
      const choiceStr = (args.choice as string).toLowerCase();

      const choiceMap: Record<string, ChoiceType> = { rock: Choice.Rock, paper: Choice.Paper, scissors: Choice.Scissors };
      const choice = choiceMap[choiceStr];
      if (choice === undefined) {
        return JSON.stringify({ error: `Invalid choice "${args.choice}". Must be rock, paper, or scissors.` });
      }

      const match = await agent.getMatch(matchId);
      if (match.state !== MatchState.ACTIVE) {
        return JSON.stringify({ error: `Match #${matchId} is not ACTIVE (current: ${["Waiting", "Active", "Complete", "Cancelled"][match.state]})` });
      }

      const addr = agent.address.toLowerCase();
      const isPlayer1 = match.player1.toLowerCase() === addr;
      const isPlayer2 = match.player2.toLowerCase() === addr;
      if (!isPlayer1 && !isPlayer2) {
        return JSON.stringify({ error: `You are not a player in match #${matchId}.` });
      }

      const roundNum = match.currentRound;
      onProgress?.(`Playing round ${roundNum} with ${CHOICE_NAMES[choice]}...`);

      // ── Phase 1: Commit ──
      let round = await agent.getRound(matchId, roundNum);
      if (round.phase === RoundPhase.COMMIT) {
        const myCommit = isPlayer1 ? round.commitP1 : round.commitP2;
        if (myCommit === "0x0000000000000000000000000000000000000000000000000000000000000000") {
          onProgress?.(`Committing ${CHOICE_NAMES[choice]}...`);
          await agent.commit(matchId, choice);
        } else {
          onProgress?.("Already committed, waiting for opponent...");
        }

        // Wait for reveal phase or timeout
        const commitWait = Date.now() + 90_000; // 90s max wait
        while (Date.now() < commitWait) {
          await new Promise((r) => setTimeout(r, 3000));
          round = await agent.getRound(matchId, roundNum);
          if (round.phase !== RoundPhase.COMMIT) break;

          // Check if opponent timed out
          if (round.phaseDeadline > 0n && BigInt(Math.floor(Date.now() / 1000)) > round.phaseDeadline + 5n) {
            const oppCommit = isPlayer1 ? round.commitP2 : round.commitP1;
            if (oppCommit === "0x0000000000000000000000000000000000000000000000000000000000000000") {
              onProgress?.("Opponent failed to commit. Claiming timeout...");
              await agent.claimTimeout(matchId);
              await new Promise((r) => setTimeout(r, 3000));
              const finalMatch = await agent.getMatch(matchId);
              return JSON.stringify({
                matchId: Number(matchId),
                round: roundNum,
                yourChoice: CHOICE_NAMES[choice],
                result: "timeout_win",
                message: "Opponent timed out on commit. You win!",
                matchComplete: finalMatch.state === MatchState.COMPLETE,
                score: { you: isPlayer1 ? finalMatch.winsP1 : finalMatch.winsP2, opponent: isPlayer1 ? finalMatch.winsP2 : finalMatch.winsP1 },
              }, null, 2);
            }
          }
        }
      }

      // ── Phase 2: Reveal ──
      round = await agent.getRound(matchId, roundNum);
      if (round.phase === RoundPhase.REVEAL) {
        const myChoice = isPlayer1 ? round.choiceP1 : round.choiceP2;
        if (myChoice === Choice.None) {
          onProgress?.("Revealing move...");
          await agent.reveal(matchId);
        } else {
          onProgress?.("Already revealed, waiting for opponent...");
        }

        // Wait for round to complete or timeout
        const revealWait = Date.now() + 90_000;
        while (Date.now() < revealWait) {
          await new Promise((r) => setTimeout(r, 3000));
          round = await agent.getRound(matchId, roundNum);
          if (round.phase === RoundPhase.COMPLETE) break;

          // Check if opponent timed out
          if (round.phaseDeadline > 0n && BigInt(Math.floor(Date.now() / 1000)) > round.phaseDeadline + 5n) {
            const oppChoice = isPlayer1 ? round.choiceP2 : round.choiceP1;
            if (oppChoice === Choice.None) {
              onProgress?.("Opponent failed to reveal. Claiming timeout...");
              await agent.claimTimeout(matchId);
              await new Promise((r) => setTimeout(r, 3000));
              const finalMatch = await agent.getMatch(matchId);
              return JSON.stringify({
                matchId: Number(matchId),
                round: roundNum,
                yourChoice: CHOICE_NAMES[choice],
                result: "timeout_win",
                message: "Opponent timed out on reveal. You win!",
                matchComplete: finalMatch.state === MatchState.COMPLETE,
                score: { you: isPlayer1 ? finalMatch.winsP1 : finalMatch.winsP2, opponent: isPlayer1 ? finalMatch.winsP2 : finalMatch.winsP1 },
              }, null, 2);
            }
          }
        }
      }

      // ── Phase 3: Return result ──
      round = await agent.getRound(matchId, roundNum);
      const updatedMatch = await agent.getMatch(matchId);

      if (round.phase !== RoundPhase.COMPLETE) {
        return JSON.stringify({
          matchId: Number(matchId),
          round: roundNum,
          yourChoice: CHOICE_NAMES[choice],
          message: "Round did not complete within the expected time. Use get_round to check status.",
        });
      }

      const myC = isPlayer1 ? round.choiceP1 : round.choiceP2;
      const oppC = isPlayer1 ? round.choiceP2 : round.choiceP1;
      const winner = round.winner === "0x0000000000000000000000000000000000000000"
        ? "draw"
        : round.winner.toLowerCase() === addr
          ? "you"
          : "opponent";

      const result: Record<string, any> = {
        matchId: Number(matchId),
        round: roundNum,
        yourChoice: CHOICE_NAMES[myC],
        opponentChoice: CHOICE_NAMES[oppC],
        roundWinner: winner,
        score: { you: isPlayer1 ? updatedMatch.winsP1 : updatedMatch.winsP2, opponent: isPlayer1 ? updatedMatch.winsP2 : updatedMatch.winsP1 },
      };

      if (updatedMatch.state === MatchState.COMPLETE) {
        const myWins = isPlayer1 ? updatedMatch.winsP1 : updatedMatch.winsP2;
        const oppWins = isPlayer1 ? updatedMatch.winsP2 : updatedMatch.winsP1;
        const iWon = myWins > oppWins;
        result.matchComplete = true;
        result.matchWinner = iWon ? "you" : "opponent";
        const originalPot = updatedMatch.entryFee * 2n;
        result.prize = iWon ? formatUsdc((originalPot * 98n) / 100n) + " USDC" : "0.00 USDC";
      } else {
        result.matchComplete = false;
        result.nextRound = updatedMatch.currentRound;
        result.message = "Round complete. Call play_round again for the next round.";
      }

      return JSON.stringify(result, null, 2);
    }

    case "get_round": {
      const matchId = BigInt(args.match_id);
      const match = await agent.getMatch(matchId);

      const roundNum = args.round ?? match.currentRound;
      if (roundNum < 1 || roundNum > match.currentRound) {
        return JSON.stringify({ error: `Invalid round ${roundNum}. Current round is ${match.currentRound}.` });
      }

      const round = await agent.getRound(matchId, roundNum);
      const isPlayer1 = match.player1.toLowerCase() === agent.address.toLowerCase();

      const result: Record<string, any> = {
        matchId: Number(matchId),
        round: roundNum,
        phase: ["Commit", "Reveal", "Complete"][round.phase],
        matchState: ["Waiting", "Active", "Complete", "Cancelled"][match.state],
        score: { player1: match.winsP1, player2: match.winsP2 },
      };

      if (round.phase === RoundPhase.COMMIT) {
        const myCommit = isPlayer1 ? round.commitP1 : round.commitP2;
        const oppCommit = isPlayer1 ? round.commitP2 : round.commitP1;
        result.youCommitted = myCommit !== "0x0000000000000000000000000000000000000000000000000000000000000000";
        result.opponentCommitted = oppCommit !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      }

      if (round.phase === RoundPhase.REVEAL) {
        const myChoice = isPlayer1 ? round.choiceP1 : round.choiceP2;
        const oppChoice = isPlayer1 ? round.choiceP2 : round.choiceP1;
        result.youRevealed = myChoice !== Choice.None;
        result.opponentRevealed = oppChoice !== Choice.None;
      }

      if (round.phase === RoundPhase.COMPLETE) {
        const myC = isPlayer1 ? round.choiceP1 : round.choiceP2;
        const oppC = isPlayer1 ? round.choiceP2 : round.choiceP1;
        result.yourChoice = CHOICE_NAMES[myC];
        result.opponentChoice = CHOICE_NAMES[oppC];
        result.winner = round.winner === "0x0000000000000000000000000000000000000000"
          ? "draw"
          : round.winner.toLowerCase() === agent.address.toLowerCase()
            ? "you"
            : "opponent";
      }

      if (round.phaseDeadline > 0n) {
        result.phaseDeadline = Number(round.phaseDeadline);
      }

      return JSON.stringify(result, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}
