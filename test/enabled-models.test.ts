import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "../src/enabled-models.js";

/** Mock models matching typical registry shape. */
const MODELS = [
  { id: "gemma-4-31b-it", name: "Gemma 4 31B", provider: "google" },
  { id: "speed", name: "Speed", provider: "vllm" },
  { id: "Qwen3.6-35B-A3B-UD-IQ4_NL-mmproj:precise", name: "Qwen3.6 35B", provider: "llama-swap" },
  { id: "Qwen3.6-27B-Q4_K_M-mmproj-ik:precise", name: "Qwen3.6 27B", provider: "llama-swap" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistryRef {
  return {
    find(provider: string, modelId: string) {
      return models.find(m => m.provider === provider && m.id === modelId);
    },
    getAll() { return models; },
    getAvailable: available ? () => available : undefined,
  };
}

describe("readEnabledModels", () => {
  let agentDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-em-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("returns undefined when settings file missing", () => {
    expect(readEnabledModels()).toBeUndefined();
  });

  it("returns undefined when field absent", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
    expect(readEnabledModels()).toBeUndefined();
  });

  it("returns enabledModels array", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      enabledModels: ["anthropic/*", "google/gemma-4-31b-it"],
    }));
    expect(readEnabledModels()).toEqual(["anthropic/*", "google/gemma-4-31b-it"]);
  });

  it("returns undefined for corrupt JSON", () => {
    writeFileSync(join(agentDir, "settings.json"), "not json {{{");
    expect(readEnabledModels()).toBeUndefined();
  });

  it("returns undefined when enabledModels is not an array", () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: "anthropic/*" }));
    expect(readEnabledModels()).toBeUndefined();
  });
});

describe("resolveEnabledModels", () => {
  it("returns undefined for empty patterns", () => {
    expect(resolveEnabledModels([], makeRegistry())).toBeUndefined();
    expect(resolveEnabledModels(undefined, makeRegistry())).toBeUndefined();
  });

  it("returns undefined when no matches", () => {
    expect(resolveEnabledModels(["nonexistent/foo"], makeRegistry())).toBeUndefined();
  });

  it("skips empty string patterns", () => {
    const result = resolveEnabledModels(["", "anthropic/*"], makeRegistry());
    // Empty string should not match all models — only anthropic/* should match
    expect(result!.size).toBe(2);
  });

  it("skips whitespace-only patterns", () => {
    const result = resolveEnabledModels(["  ", "google/gemma-4-31b-it"], makeRegistry());
    expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
  });

  it("returns undefined when getAvailable returns empty array", () => {
    const result = resolveEnabledModels(
      ["anthropic/*"],
      makeRegistry(MODELS, []),
    );
    expect(result).toBeUndefined();
  });

  it("deduplicates duplicate patterns", () => {
    const result = resolveEnabledModels(
      ["anthropic/*", "anthropic/*"],
      makeRegistry(),
    );
    expect(result!.size).toBe(2); // same as single entry
  });

  describe("exact provider/modelId", () => {
    it("resolves exact match (key stored lowercase)", () => {
      const result = resolveEnabledModels(["google/gemma-4-31b-it"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });

    it("resolves model id with colon (part of id, not split)", () => {
      const result = resolveEnabledModels(
        ["llama-swap/Qwen3.6-35B-A3B-UD-IQ4_NL-mmproj:precise"],
        makeRegistry(),
      );
      expect(result).toEqual(new Set(["llama-swap/qwen3.6-35b-a3b-ud-iq4_nl-mmproj:precise"]));
    });

    it("is case-insensitive", () => {
      const result = resolveEnabledModels(["GOOGLE/GEMMA-4-31B-IT"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });
  });

  describe("bare modelId", () => {
    it("resolves bare id to lowercase key", () => {
      const result = resolveEnabledModels(["speed"], makeRegistry());
      expect(result).toEqual(new Set(["vllm/speed"]));
    });
  });

  describe("no fuzzy matching", () => {
    it("returns undefined for bare substring patterns (pi never writes these)", () => {
      const result = resolveEnabledModels(["Qwen"], makeRegistry());
      expect(result).toBeUndefined();
    });
  });

  describe("glob match", () => {
    it("matches provider/* glob", () => {
      const result = resolveEnabledModels(["anthropic/*"], makeRegistry());
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(true);
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(false);
    });

    it("matches wildcard in id", () => {
      const result = resolveEnabledModels(["*Qwen*"], makeRegistry());
      expect(result!.size).toBe(2);
    });

    it("matches against model id only (no provider prefix)", () => {
      // "*sonnet*" should match claude-sonnet-4-6 via id-only match
      const result = resolveEnabledModels(["*sonnet*"], makeRegistry());
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(false);
    });
  });

  describe("mixed patterns", () => {
    it("combines exact and glob in one call", () => {
      const result = resolveEnabledModels(
        ["google/gemma-4-31b-it", "anthropic/*", "speed"],
        makeRegistry(),
      );
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(true);
      expect(result!.has("vllm/speed".toLowerCase())).toBe(true);
      expect(result!.has("llama-swap/qwen3.6-35b-a3b-ud-iq4_nl-mmproj:precise".toLowerCase())).toBe(false);
    });
  });

  describe("getAvailable filtering", () => {
    it("resolves only against available models when getAvailable present", () => {
      const available = [MODELS[0], MODELS[4]]; // google + haiku only
      const result = resolveEnabledModels(
        ["anthropic/*", "google/*"],
        makeRegistry(MODELS, available),
      );
      // anthropic/* matches nothing (haiku is only available anthropic model, glob matches haiku)
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(false); // not available
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
    });
  });
});
