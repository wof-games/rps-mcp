import { describe, it, expect } from "vitest";
import { toolDefinitions } from "../tools.js";

describe("toolDefinitions", () => {
  it("has exactly 15 tools", () => {
    expect(toolDefinitions).toHaveLength(15);
  });

  it("has unique tool names", () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const expectedTools = [
    "play_rps",
    "create_match",
    "cancel_match",
    "find_open_matches",
    "get_match",
    "get_leaderboard",
    "get_balance",
    "get_my_matches",
    "mint_identity",
    "register_agent",
    "join_match",
    "play_round",
    "get_round",
    "claim_refund",
    "claim_timeout",
  ];

  it.each(expectedTools)("includes tool '%s'", (name) => {
    const tool = toolDefinitions.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(tool!.description).toBeTruthy();
    expect(tool!.inputSchema.type).toBe("object");
  });

  describe("required parameters", () => {
    it("cancel_match requires match_id", () => {
      const tool = toolDefinitions.find((t) => t.name === "cancel_match")!;
      expect(tool.inputSchema.required).toContain("match_id");
    });

    it("play_round requires match_id and choice", () => {
      const tool = toolDefinitions.find((t) => t.name === "play_round")!;
      expect(tool.inputSchema.required).toContain("match_id");
      expect(tool.inputSchema.required).toContain("choice");
    });

    it("get_match requires match_id", () => {
      const tool = toolDefinitions.find((t) => t.name === "get_match")!;
      expect(tool.inputSchema.required).toContain("match_id");
    });

    it("join_match requires match_id", () => {
      const tool = toolDefinitions.find((t) => t.name === "join_match")!;
      expect(tool.inputSchema.required).toContain("match_id");
    });

    it("play_rps has no required params", () => {
      const tool = toolDefinitions.find((t) => t.name === "play_rps")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("get_balance has no required params", () => {
      const tool = toolDefinitions.find((t) => t.name === "get_balance")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("get_my_matches has no required params", () => {
      const tool = toolDefinitions.find((t) => t.name === "get_my_matches")!;
      expect(tool.inputSchema.required).toBeUndefined();
    });

    it("mint_identity requires name", () => {
      const tool = toolDefinitions.find((t) => t.name === "mint_identity")!;
      expect(tool.inputSchema.required).toContain("name");
    });

    it("register_agent requires agent_id", () => {
      const tool = toolDefinitions.find((t) => t.name === "register_agent")!;
      expect(tool.inputSchema.required).toContain("agent_id");
    });

    it("claim_refund requires match_id", () => {
      const tool = toolDefinitions.find((t) => t.name === "claim_refund")!;
      expect(tool.inputSchema.required).toContain("match_id");
    });
  });

  describe("play_round choice enum", () => {
    it("has rock, paper, scissors options", () => {
      const tool = toolDefinitions.find((t) => t.name === "play_round")!;
      const choiceProp = tool.inputSchema.properties.choice;
      expect(choiceProp.enum).toEqual(["rock", "paper", "scissors"]);
    });
  });
});
