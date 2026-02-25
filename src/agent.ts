import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rpsArenaAbi, erc20Abi, identityRegistryAbi } from "./abi.js";
import type { Config } from "./config.js";

// ============ PERSISTENT SECRET STORAGE ============
// Secrets must survive MCP server restarts, otherwise reveals fail
// after a process restart because the in-memory Map is wiped.

interface StoredSecret {
  choice: number;
  secret: Hex;
}

const SECRETS_FILE = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".wof-rps-secrets.json",
);

function loadSecrets(): Map<string, StoredSecret> {
  try {
    const data = readFileSync(SECRETS_FILE, "utf-8");
    const entries: [string, StoredSecret][] = JSON.parse(data);
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function saveSecrets(secrets: Map<string, StoredSecret>): void {
  try {
    const dir = dirname(SECRETS_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(SECRETS_FILE, JSON.stringify([...secrets]), "utf-8");
  } catch (e: any) {
    process.stderr.write(`[wof] Warning: failed to persist secrets: ${e.message}\n`);
  }
}

// Game constants
export const Choice = {
  None: 0,
  Rock: 1,
  Paper: 2,
  Scissors: 3,
} as const;

export const MatchState = {
  WAITING: 0,
  ACTIVE: 1,
  COMPLETE: 2,
  CANCELLED: 3,
} as const;

export const RoundPhase = {
  COMMIT: 0,
  REVEAL: 1,
  COMPLETE: 2,
} as const;

export const CHOICE_NAMES = ["None", "Rock", "Paper", "Scissors"];
export const STATE_NAMES = ["Waiting", "Active", "Complete", "Cancelled"];

export type ChoiceType = (typeof Choice)[keyof typeof Choice];

export interface RoundResult {
  round: number;
  myChoice: string;
  opponentChoice: string;
  winner: string;
}

export interface MatchResult {
  matchId: number;
  won: boolean;
  score: { player: number; opponent: number };
  rounds: RoundResult[];
  prize: string;
  opponentAddress: string;
}

export interface MatchInfo {
  matchId: number;
  player1: string;
  player2: string;
  entryFee: string;
  pot: string;
  state: string;
  winsP1: number;
  winsP2: number;
  currentRound: number;
  createdAt: number;
  startedAt: number;
}

type ProgressCallback = (msg: string) => void;

export class RPSAgent {
  public readonly address: Address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly walletClient: any;
  public readonly arenaAddress: Address;
  public readonly usdcAddress: Address;
  public readonly identityRegistry: Address;
  private readonly chainId: number;

  private secrets: Map<string, StoredSecret>;

  constructor(config: Config) {
    const account = privateKeyToAccount(config.privateKey);
    this.address = account.address;

    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account,
      chain: config.chain,
      transport: http(config.rpcUrl),
    });

    this.arenaAddress = config.arenaAddress;
    this.usdcAddress = config.usdcAddress;
    this.identityRegistry = config.identityRegistry;
    this.chainId = config.chain.id;
    this.secrets = loadSecrets();
  }

  // ============ SETUP ============

  async approveUsdc(amount: bigint, onProgress?: ProgressCallback): Promise<Hex> {
    onProgress?.(`Approving ${formatUsdc(amount)} USDC for arena...`);
    const hash = await this.walletClient.writeContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.arenaAddress, amount],
    });
    await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    await new Promise((r) => setTimeout(r, 1000));
    return hash;
  }

  async getUsdcBalance(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.address],
    });
  }

  async getEthBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.address });
  }

  // ============ MATCH ACTIONS ============

  async createMatch(entryFee: bigint, onProgress?: ProgressCallback): Promise<bigint> {
    await this.approveUsdc(entryFee, onProgress);

    onProgress?.("Creating match on-chain...");
    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "createMatch",
      args: [entryFee],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === this.arenaAddress.toLowerCase() && log.topics.length >= 2) {
        const matchId = BigInt(log.topics[1]!);
        onProgress?.(`Match #${matchId} created! Waiting for opponent...`);
        return matchId;
      }
    }

    const matchId = await this.getMatchCounter();
    onProgress?.(`Match #${matchId} created! Waiting for opponent...`);
    return matchId;
  }

  async joinMatch(matchId: bigint, entryFee?: bigint, onProgress?: ProgressCallback): Promise<Hex> {
    let fee = entryFee;
    if (!fee) {
      for (let i = 0; i < 5; i++) {
        const match = await this.getMatch(matchId);
        if (match.entryFee > 0n) {
          fee = match.entryFee;
          break;
        }
        onProgress?.("Waiting for RPC to sync match data...");
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!fee || fee === 0n) {
        throw new Error(`Could not get entry fee for match ${matchId}`);
      }
    }

    await this.approveUsdc(fee, onProgress);
    onProgress?.(`Joining match #${matchId}...`);

    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "joinMatch",
      args: [matchId],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    onProgress?.(`Joined match #${matchId}!`);
    return hash;
  }

  async commit(matchId: bigint, choice: ChoiceType): Promise<Hex> {
    const match = await this.getMatch(matchId);
    const key = `${this.chainId}-${matchId}-${match.currentRound}`;

    // Never overwrite an existing secret — a prior commit for this round
    // already went on-chain and only the original secret can reveal it.
    const existing = this.secrets.get(key);
    if (existing) {
      // Reuse the existing secret so the commitment matches what's on-chain
      const commitment = keccak256(
        encodePacked(["uint8", "bytes32"], [existing.choice, existing.secret])
      );
      const hash = await this.walletClient.writeContract({
        address: this.arenaAddress,
        abi: rpsArenaAbi,
        functionName: "commit",
        args: [matchId, commitment],
        gas: 150000n,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Commit transaction failed: ${hash}`);
      }
      return hash;
    }

    // Generate cryptographically secure random secret
    const secret = `0x${randomBytes(32).toString("hex")}` as Hex;
    const commitment = keccak256(
      encodePacked(["uint8", "bytes32"], [choice, secret])
    );

    // Persist BEFORE sending tx — if process dies mid-tx, secret survives
    this.secrets.set(key, { choice, secret });
    saveSecrets(this.secrets);

    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "commit",
      args: [matchId, commitment],
      gas: 150000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Commit transaction failed: ${hash}`);
    }
    return hash;
  }

  async reveal(matchId: bigint): Promise<Hex> {
    const match = await this.getMatch(matchId);
    const key = `${this.chainId}-${matchId}-${match.currentRound}`;
    const stored = this.secrets.get(key);

    if (!stored) {
      throw new Error(`No stored secret for match ${matchId} round ${match.currentRound}`);
    }

    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "reveal",
      args: [matchId, stored.choice, stored.secret],
      gas: 500000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Reveal transaction failed: ${hash}`);
    }

    // Clean up persisted secret after successful reveal
    this.secrets.delete(key);
    saveSecrets(this.secrets);

    return hash;
  }

  // ============ READ FUNCTIONS ============

  async getMatchCounter(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "matchCounter",
    });
  }

  async getMatch(matchId: bigint) {
    const result = await this.publicClient.readContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "getMatch",
      args: [matchId],
    });

    return {
      player1: result[0],
      player2: result[1],
      entryFee: result[2],
      pot: result[3],
      state: result[4],
      winsP1: result[5],
      winsP2: result[6],
      currentRound: result[7],
      createdAt: result[8],
      startedAt: result[9],
    };
  }

  async getRound(matchId: bigint, round: number) {
    const result = await this.publicClient.readContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "getRound",
      args: [matchId, round],
    });

    return {
      commitP1: result[0],
      commitP2: result[1],
      choiceP1: result[2],
      choiceP2: result[3],
      phase: result[4],
      phaseDeadline: result[5],
      winner: result[6],
    };
  }

  // ============ PLAYER HISTORY ============

  async getPlayerMatches(): Promise<bigint[]> {
    const result = await this.publicClient.readContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "getPlayerMatches",
      args: [this.address],
    });
    return result as bigint[];
  }

  // ============ ERC-8004 IDENTITY ============

  async registerAgentId(agentId: bigint): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "registerAgentId",
      args: [agentId],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async getPlayerAgentId(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "getPlayerAgentId",
      args: [this.address],
    });
  }

  async mintIdentity(
    name: string,
    description?: string,
    image?: string,
  ): Promise<{ txHash: Hex; tokenId: bigint }> {
    const metadata: Record<string, unknown> = {
      name,
      description: description ?? `${name} — WatchOrFight RPS agent`,
      attributes: [{ trait_type: "platform", value: "watchorfight" }],
    };
    if (image) metadata.image = image;

    const json = JSON.stringify(metadata);
    const tokenURI = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;

    const hash = await this.walletClient.writeContract({
      address: this.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "register",
      args: [tokenURI],
      gas: 500000n,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`mint identity transaction failed: ${hash}`);
    }

    // Parse token ID from Transfer event logs
    // ERC-8004 registry is NOT ERC-721 Enumerable — cannot use tokenOfOwnerByIndex
    const transferSig = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    let tokenId: bigint | undefined;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === this.identityRegistry.toLowerCase() &&
        log.topics[0] === transferSig &&
        log.topics.length >= 4
      ) {
        tokenId = BigInt(log.topics[3]!);
        break;
      }
    }

    if (tokenId === undefined) {
      throw new Error(`Mint succeeded (${hash}) but could not parse token ID from logs`);
    }

    return { txHash: hash, tokenId };
  }

  // ============ BATCH FETCH ============

  static readonly MULTICALL_BATCH = 500;

  async getMatches(startId: bigint, endId: bigint): Promise<Map<bigint, {
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
  }>> {
    const matches = new Map<bigint, {
      player1: string; player2: string; entryFee: bigint; pot: bigint;
      state: number; winsP1: number; winsP2: number; currentRound: number;
      createdAt: bigint; startedAt: bigint;
    }>();

    const batchSize = BigInt(RPSAgent.MULTICALL_BATCH);

    for (let batchStart = startId; batchStart <= endId; batchStart += batchSize) {
      const batchEnd = batchStart + batchSize - 1n > endId ? endId : batchStart + batchSize - 1n;

      const contracts = [];
      for (let id = batchStart; id <= batchEnd; id++) {
        contracts.push({
          address: this.arenaAddress,
          abi: rpsArenaAbi,
          functionName: "getMatch" as const,
          args: [id],
        });
      }

      const results = await this.publicClient.multicall({ contracts, allowFailure: true });

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "success") {
          const res = r.result;
          matches.set(batchStart + BigInt(j), {
            player1: res[0],
            player2: res[1],
            entryFee: res[2],
            pot: res[3],
            state: res[4],
            winsP1: res[5],
            winsP2: res[6],
            currentRound: res[7],
            createdAt: res[8],
            startedAt: res[9],
          });
        }
      }
    }

    return matches;
  }

  // ============ TIMEOUT HANDLING ============

  async claimTimeout(matchId: bigint): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "claimTimeout",
      args: [matchId],
      gas: 500000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`claimTimeout failed: ${hash}`);
    }
    return hash;
  }

  async claimMatchExpiry(matchId: bigint, onProgress?: ProgressCallback): Promise<Hex> {
    onProgress?.(`Claiming refund for expired match #${matchId}...`);
    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "claimMatchExpiry",
      args: [matchId],
      gas: 500000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`claimMatchExpiry failed: ${hash}`);
    }
    onProgress?.(`Match #${matchId} expired. Both players refunded.`);
    return hash;
  }

  async cancelMatch(matchId: bigint, onProgress?: ProgressCallback): Promise<Hex> {
    onProgress?.(`Cancelling match #${matchId}...`);
    const hash = await this.walletClient.writeContract({
      address: this.arenaAddress,
      abi: rpsArenaAbi,
      functionName: "cancelMatch",
      args: [matchId],
      gas: 150000n,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`cancelMatch failed: ${hash}`);
    }
    onProgress?.(`Match #${matchId} cancelled. Entry fee refunded.`);
    return hash;
  }

  // ============ GAME LOGIC ============

  pickRandomChoice(): ChoiceType {
    const choices = [Choice.Rock, Choice.Paper, Choice.Scissors];
    return choices[randomInt(3)];
  }

  async waitForPhase(matchId: bigint, targetPhase: number, onProgress?: ProgressCallback, timeoutMs = 180000): Promise<"ok" | "timeout_claimed" | "match_ended"> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = await this.getMatch(matchId);
      if (match.state === MatchState.COMPLETE || match.state === MatchState.CANCELLED) {
        return "match_ended";
      }
      const round = await this.getRound(matchId, match.currentRound);
      if (round.phase === targetPhase) {
        return "ok";
      }

      if (round.phaseDeadline > 0n) {
        const block = await this.publicClient.getBlock();
        if (block.timestamp > round.phaseDeadline) {
          onProgress?.("Opponent timed out! Claiming timeout...");
          try {
            await this.claimTimeout(matchId);
            onProgress?.("Timeout claimed successfully!");
            return "timeout_claimed";
          } catch (e: any) {
            onProgress?.(`Timeout claim failed: ${e.message}`);
          }
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Timeout waiting for phase change");
  }

  /**
   * Play a full match to completion. Returns structured result.
   */
  async playMatch(matchId: bigint, isPlayer1: boolean, onProgress?: ProgressCallback): Promise<MatchResult> {
    const roundResults: RoundResult[] = [];
    let claimedTimeout = false;

    onProgress?.(`Playing match #${matchId} as Player ${isPlayer1 ? 1 : 2}...`);

    // Wait for match to be active with round >= 1
    const waitStart = Date.now();
    while (Date.now() - waitStart < 120000) {
      const m = await this.getMatch(matchId);
      if (m.state === MatchState.ACTIVE && m.currentRound >= 1) break;
      if (m.state === MatchState.COMPLETE || m.state === MatchState.CANCELLED) break;
      onProgress?.(`Waiting for match to become active (state=${STATE_NAMES[m.state]}, round=${m.currentRound})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    while (true) {
      const match = await this.getMatch(matchId);

      if (match.state === MatchState.WAITING) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (match.state === MatchState.COMPLETE) {
        const myWins = isPlayer1 ? match.winsP1 : match.winsP2;
        const oppWins = isPlayer1 ? match.winsP2 : match.winsP1;
        const iWon = claimedTimeout || myWins > oppWins;
        const originalPot = match.entryFee * 2n;
        const prize = iWon ? formatUsdc((originalPot * 98n) / 100n) : "0.00";
        const opponent = isPlayer1 ? match.player2 : match.player1;

        // Rebuild complete round history from on-chain data to avoid gaps
        const fullRounds: RoundResult[] = [];
        for (let r = 1; r <= match.currentRound; r++) {
          try {
            const rd = await this.getRound(matchId, r);
            if (rd.choiceP1 > 0 && rd.choiceP2 > 0) {
              const myC = isPlayer1 ? rd.choiceP1 : rd.choiceP2;
              const oppC = isPlayer1 ? rd.choiceP2 : rd.choiceP1;
              const winner =
                rd.winner === "0x0000000000000000000000000000000000000000"
                  ? "Draw"
                  : rd.winner.toLowerCase() === this.address.toLowerCase()
                    ? "You"
                    : "Opponent";
              fullRounds.push({
                round: r,
                myChoice: CHOICE_NAMES[myC],
                opponentChoice: CHOICE_NAMES[oppC],
                winner,
              });
            }
          } catch {
            // Skip unreadable rounds
          }
        }

        onProgress?.(`Match complete! ${iWon ? "YOU WON" : "You lost"} (${myWins}-${oppWins})`);

        return {
          matchId: Number(matchId),
          won: iWon,
          score: { player: myWins, opponent: oppWins },
          rounds: fullRounds,
          prize: `${prize} USDC`,
          opponentAddress: opponent,
        };
      }

      if (match.state === MatchState.CANCELLED) {
        onProgress?.("Match was cancelled.");
        return {
          matchId: Number(matchId),
          won: false,
          score: { player: 0, opponent: 0 },
          rounds: roundResults,
          prize: "0.00 USDC (refunded)",
          opponentAddress: "N/A",
        };
      }

      const round = await this.getRound(matchId, match.currentRound);

      if (round.phase === RoundPhase.COMMIT) {
        const myCommit = isPlayer1 ? round.commitP1 : round.commitP2;
        if (myCommit === "0x0000000000000000000000000000000000000000000000000000000000000000") {
          const choice = this.pickRandomChoice();
          onProgress?.(`Round ${match.currentRound}: Committing ${CHOICE_NAMES[choice]}...`);
          await this.commit(matchId, choice);
        }
        const result = await this.waitForPhase(matchId, RoundPhase.REVEAL, onProgress);
        if (result === "timeout_claimed") {
          claimedTimeout = true;
          continue;
        }
        if (result === "match_ended") {
          continue;
        }
      } else if (round.phase === RoundPhase.REVEAL) {
        const myChoice = isPlayer1 ? round.choiceP1 : round.choiceP2;
        if (myChoice === Choice.None) {
          onProgress?.(`Round ${match.currentRound}: Revealing choice...`);
          await this.reveal(matchId);
        }
        // Wait for round to complete, then collect result
        await new Promise((r) => setTimeout(r, 3000));

        // Try to read completed round data
        try {
          const completedRound = await this.getRound(matchId, match.currentRound);
          if (completedRound.phase === RoundPhase.COMPLETE) {
            const myC = isPlayer1 ? completedRound.choiceP1 : completedRound.choiceP2;
            const oppC = isPlayer1 ? completedRound.choiceP2 : completedRound.choiceP1;
            const winner = completedRound.winner === "0x0000000000000000000000000000000000000000"
              ? "Draw"
              : completedRound.winner.toLowerCase() === this.address.toLowerCase()
                ? "You"
                : "Opponent";
            roundResults.push({
              round: match.currentRound,
              myChoice: CHOICE_NAMES[myC],
              opponentChoice: CHOICE_NAMES[oppC],
              winner,
            });
            onProgress?.(`Round ${match.currentRound}: ${CHOICE_NAMES[myC]} vs ${CHOICE_NAMES[oppC]} -> ${winner}`);
          }
        } catch {
          // Round may not be complete yet, continue
        }
      } else {
        // Round complete, wait for next round
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

// Helper to format USDC amounts (6 decimals)
export function formatUsdc(amount: bigint): string {
  return (Number(amount) / 1e6).toFixed(2);
}

// Helper to format ETH amounts
export function formatEthBalance(amount: bigint): string {
  return Number(formatEther(amount)).toFixed(4);
}
