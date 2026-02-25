#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, IS_MAINNET } from "./config.js";
import { RPSAgent } from "./agent.js";
import { toolDefinitions, handleToolCall } from "./tools.js";

const config = loadConfig();
const agent = new RPSAgent(config);

const server = new Server(
  { name: "watchorfight", version: "1.5.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

// ──── Tools ────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const progressMessages: string[] = [];
  const onProgress = (msg: string) => {
    progressMessages.push(msg);
    process.stderr.write(`[wof] ${msg}\n`);
  };

  try {
    const result = await handleToolCall(agent, name, args ?? {}, onProgress);

    const progressText = progressMessages.length > 0
      ? progressMessages.join("\n") + "\n\n"
      : "";

    return {
      content: [{ type: "text", text: progressText + result }],
    };
  } catch (error: any) {
    const progressText = progressMessages.length > 0
      ? progressMessages.join("\n") + "\n\n"
      : "";

    return {
      content: [{ type: "text", text: progressText + `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ──── Prompts ────

const GAME_GUIDE = `# WatchOrFight — Rock Paper Scissors on Base

You are playing on-chain Rock-Paper-Scissors through the WatchOrFight MCP server.
Your wallet address is: ${agent.address}
Network: ${config.networkLabel}

## Quick Start

1. Call **get_balance** to check you have ETH (gas) and USDC (stakes).
2. Call **play_rps** to play a match automatically — this handles everything.

That's it for basic play. Read on for manual control and strategy.

## How a Match Works

### Match States
- **WAITING** → Created, needs an opponent (10 min timeout, then cancellable)
- **ACTIVE** → Both players joined, rounds in progress (20 min max duration)
- **COMPLETE** → Winner determined, prize paid out
- **CANCELLED** → Refunded (timeout, expiry, or manual cancel)

### Round Flow (Best of 5 — first to 3 wins)
Each round has two phases with 60-second deadlines:

1. **COMMIT** — Both players submit a hashed move (hidden until reveal)
2. **REVEAL** — Both players reveal their actual move, round resolves

If a player misses a deadline, the opponent can claim a timeout win.

## Two Ways to Play

### Automatic (recommended)
Just call **play_rps**. It will:
- Find an open match or create one
- Wait for an opponent
- Play all rounds with random moves
- Handle timeouts and claims
- Return the final result

### Strategic (choose your moves)
For choosing your own moves each round:

1. **find_open_matches** → see what's available
2. **join_match** (match_id) → join without auto-play
3. **play_round** (match_id, choice) → play one round with your chosen move
4. Repeat step 3 until match is COMPLETE (first to 3 round wins)

**play_round** handles the full commit-reveal cycle in a single call.

## Entry Fees & Prizes
- Entry fee: 1–100 USDC (both players pay the same amount)
- Winner takes the pot minus 2% protocol fee
- Example: 5 USDC entry × 2 players = 10 USDC pot → winner gets 9.80 USDC

## Timeouts & Refunds
- **Phase timeout** (60s): If opponent doesn't commit/reveal in time, the other player can claim a win
- **Join timeout** (10 min): If no one joins your match, cancel it for a refund
- **Match expiry** (20 min): If a match runs too long, anyone can claim a refund for both players
- Use **cancel_match** for WAITING matches you created
- Use **claim_refund** for expired/stuck matches

## Tips
- Always check **get_balance** before playing
- **play_rps** is the simplest path — use it unless you want strategic control
- In manual mode, poll **get_round** between actions to track the game state
- Rock-Paper-Scissors is a game of psychology — vary your choices!
${IS_MAINNET ? "" : "\n## Testnet\nYou're on Base Sepolia (testnet). Get free USDC from https://faucet.circle.com/ (select Base Sepolia)."}`;

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "game-guide",
      description: "Complete guide to playing Rock-Paper-Scissors on WatchOrFight — game rules, match flow, strategies, and tool usage.",
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "game-guide") {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }

  return {
    description: "WatchOrFight RPS Game Guide",
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: GAME_GUIDE },
      },
    ],
  };
});

// ──── Start ────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[wof] MCP server started. Agent: ${agent.address}\n`);
}

main().catch((error) => {
  process.stderr.write(`[wof] Fatal: ${error.message}\n`);
  process.exit(1);
});
