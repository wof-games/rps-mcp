import type { Address, Chain, Hex } from "viem";
import { baseSepolia, base } from "viem/chains";

export interface NetworkConfig {
  chain: Chain;
  rpcUrl: string;
  arenaAddress: Address;
  usdcAddress: Address;
  identityRegistry: Address;
  networkLabel: string;
}

const TESTNET: NetworkConfig = {
  chain: baseSepolia,
  rpcUrl: "https://sepolia.base.org",
  arenaAddress: "0x88DCc778b995Cd266696Ee4E961482ab7588C09e",
  usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  networkLabel: "Base Sepolia",
};

const MAINNET: NetworkConfig = {
  chain: base,
  rpcUrl: "https://mainnet.base.org",
  arenaAddress: "0xd7bee67cc28F983Ac14645D6537489C289cc7e52",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  networkLabel: "Base",
};

function getNetworkConfig(): NetworkConfig {
  const env = (process.env.NETWORK || "mainnet").toLowerCase();
  if (env === "mainnet") return MAINNET;
  return TESTNET;
}

export interface Config {
  privateKey: Hex;
  rpcUrl: string;
  arenaAddress: Address;
  usdcAddress: Address;
  identityRegistry: Address;
  chain: Chain;
  networkLabel: string;
}

export function loadConfig(): Config {
  const privateKey = process.env.AGENT_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("AGENT_KEY (or PRIVATE_KEY) environment variable is required");
  }

  const network = getNetworkConfig();

  return {
    privateKey: privateKey as Hex,
    rpcUrl: process.env.RPC_URL || network.rpcUrl,
    arenaAddress: (process.env.ARENA_ADDRESS || network.arenaAddress) as Address,
    usdcAddress: (process.env.USDC_ADDRESS || network.usdcAddress) as Address,
    identityRegistry: network.identityRegistry,
    chain: network.chain,
    networkLabel: network.networkLabel,
  };
}

export const IS_MAINNET = (process.env.NETWORK || "mainnet").toLowerCase() === "mainnet";
export const IS_TESTNET = !IS_MAINNET;
