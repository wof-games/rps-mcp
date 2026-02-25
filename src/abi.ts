export const rpsArenaAbi = [
  {
    type: "constructor",
    inputs: [{ name: "_paymentToken", type: "address" }],
  },
  // Events
  {
    type: "event",
    name: "MatchCreated",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player1", type: "address", indexed: true },
      { name: "entryFee", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PlayerJoined",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player2", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "RoundStarted",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "round", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Committed",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Revealed",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "choice", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RoundComplete",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "round", type: "uint8", indexed: false },
      { name: "winner", type: "address", indexed: false },
      { name: "choiceP1", type: "uint8", indexed: false },
      { name: "choiceP2", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchComplete",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "winner", type: "address", indexed: true },
      { name: "prize", type: "uint256", indexed: false },
    ],
  },
  // Read functions
  {
    type: "function",
    name: "getMatch",
    stateMutability: "view",
    inputs: [{ name: "_matchId", type: "uint256" }],
    outputs: [
      { name: "player1", type: "address" },
      { name: "player2", type: "address" },
      { name: "entryFee", type: "uint256" },
      { name: "pot", type: "uint256" },
      { name: "state", type: "uint8" },
      { name: "winsP1", type: "uint8" },
      { name: "winsP2", type: "uint8" },
      { name: "currentRound", type: "uint8" },
      { name: "createdAt", type: "uint256" },
      { name: "startedAt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getRound",
    stateMutability: "view",
    inputs: [
      { name: "_matchId", type: "uint256" },
      { name: "_round", type: "uint8" },
    ],
    outputs: [
      { name: "commitP1", type: "bytes32" },
      { name: "commitP2", type: "bytes32" },
      { name: "choiceP1", type: "uint8" },
      { name: "choiceP2", type: "uint8" },
      { name: "phase", type: "uint8" },
      { name: "phaseDeadline", type: "uint256" },
      { name: "winner", type: "address" },
    ],
  },
  {
    type: "function",
    name: "matchCounter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  // Write functions
  {
    type: "function",
    name: "createMatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "_entryFee", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "joinMatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "_matchId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_matchId", type: "uint256" },
      { name: "_commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reveal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_matchId", type: "uint256" },
      { name: "_choice", type: "uint8" },
      { name: "_secret", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimTimeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "_matchId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelMatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "_matchId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimMatchExpiry",
    stateMutability: "nonpayable",
    inputs: [{ name: "_matchId", type: "uint256" }],
    outputs: [],
  },
  // ERC-8004 Integration
  {
    type: "function",
    name: "identityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "reputationRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "requireIdentity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "ReputationSubmitted",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "score", type: "int256", indexed: false },
    ],
  },
  // Player match history
  {
    type: "function",
    name: "getPlayerMatches",
    stateMutability: "view",
    inputs: [{ name: "_player", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  // ERC-8004 agent registration
  {
    type: "function",
    name: "registerAgentId",
    stateMutability: "nonpayable",
    inputs: [{ name: "_agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPlayerAgentId",
    stateMutability: "view",
    inputs: [{ name: "_player", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenURI", type: "string" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
