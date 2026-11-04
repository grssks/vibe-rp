import { describe, expect, test } from "bun:test";
import { BrowserChatEngine, detectParameterRejection } from "../public/browser_engine.js";
import { promptCacheKeyFor } from "../public/model_capability.js";
import { countCrossTurnNgramEchoes, SLOP_CLUSTER_THRESHOLD } from "../public/prompt_adaptive.js";
import { mapSourceJsonToCard } from "../public/remote_import.js";

const msgs = [{ role: "user", content: "hi" }];

describe("cache affinity: one route per chat", () => {
  test("1. the key is derived from the chat id and never from content", () => {
    expect(promptCacheKeyFor({ id: "sess_1" })).toBe("vibe-rp:sess_1");
    expect(promptCacheKeyFor({ id: "sess_2" })).not.toBe(promptCacheKeyFor({ id: "sess_1" }));
  });

  test("2. no id, or a provider that rejected the field, sends no key", () => {
    expect(promptCacheKeyFor(null)).toBeNull();
    expect(promptCacheKeyFor({ id: "  " })).toBeNull();
    expect(promptCacheKeyFor({ id: "sess_1" }, { supportsPromptCacheKey: false })).toBeNull();
  });

  test("3. the main turn carries the key; a keyless call is byte-identical to before", () => {
    const keyed = BrowserChatEngine.buildRequestBody({ model: "m" }, msgs, null, { id: "sess_1" });
    expect(keyed.prompt_cache_key).toBe("vibe-rp:sess_1");
    const plain = BrowserChatEngine.buildRequestBody({ model: "m" }, msgs);
    expect("prompt_cache_key" in plain).toBe(false);
  });

  test("4. a provider's rejection of the field is recognised so it can be dropped", () => {
    const r = detectParameterRejection(new Error("400: Unrecognized request argument supplied: prompt_cache_key"));
    expect(r?.unsupportedPromptCacheKey).toBe(true);
    expect(detectParameterRejection(new Error("rate limited"))).toBeNull();
  });
});

describe("source import names the character, not the listing", () => {
  const base = { name: "Bitchy Goth girl slapped you!", description: "d", personality: "p", avatar: "a.png" };

  test("5. chat_name wins and the title is kept as provenance", () => {
    const card = mapSourceJsonToCard({ ...base, chat_name: " Saki " }, "https://janitorai.com/x");
    expect(card.data.name).toBe("Saki");
    expect(card.data.extensions.source.title).toBe("Bitchy Goth girl slapped you!");
  });

  test("6. without a chat_name the import is unchanged", () => {
    const card = mapSourceJsonToCard(base, "https://janitorai.com/x");
    expect(card.data.name).toBe("Bitchy Goth girl slapped you!");
    expect("title" in card.data.extensions.source).toBe(false);
  });
});

describe("cross-turn n-gram echo detection for agglutinative prose", () => {
  test("7. recurring 3-gram stock phrases across turns reach the slop cluster threshold", () => {
    const replies = [
      "Saki menatap tajam dengan mata menyipit sambil menggertakkan gigi di sudut ruangan.",
      "Dia mundur selangkah dengan mata menyipit lalu melipat kedua tangannya di dada.",
      "Gadis itu mendengus dengan mata menyipit ketika melihat sepatu platform-nya basah.",
      "Ia menendang lantai dengan sepatu platform-nya dan mengetuk kuku-kuku hitamnya.",
      "Saki menghela napas pada sepatu platform-nya sambil mengetuk kuku-kuku hitamnya.",
    ];
    expect(countCrossTurnNgramEchoes(replies)).toBeGreaterThanOrEqual(SLOP_CLUSTER_THRESHOLD);
  });
});
