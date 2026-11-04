import { describe, expect, test } from "bun:test";
import { BrowserChatEngine, detectParameterRejection, ensembleCast } from "../public/browser_engine.js";
import { promptCacheKeyFor } from "../public/model_capability.js";
import { countCrossTurnNgramEchoes, SLOP_CLUSTER_THRESHOLD } from "../public/prompt_adaptive.js";
import { mapSourceJsonToCard } from "../public/remote_import.js";
import { resolveCardIdentity, substitutePlaceholders } from "../public/text.js";
import { cardDescription } from "../public/ui/character_card.js";

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

  test("7. single-character tagline card resolves declared Full name in sheet on import and at runtime", () => {
    const withSheet = {
      ...base,
      personality: "# Full name:\n\nSaki Himekawa\n\n# Appearance:\nGoth outfit",
    };
    const imported = mapSourceJsonToCard(withSheet, "https://janitorai.com/x");
    expect(imported.data.name).toBe("Saki Himekawa");
    expect(imported.data.extensions.source.title).toBe("Bitchy Goth girl slapped you!");

    // Existing card in IndexedDB whose data.name is still the tagline:
    const legacyCard = { data: { name: "Bitchy Goth girl slapped you!", personality: "# Full name:\n\nSaki Himekawa" } };
    const plan = BrowserChatEngine.planRequest({
      card: legacyCard,
      session: { messages: [{ role: "user", content: "Halo" }] },
      persona: { name: "Iqbal" },
      settings: {},
    });
    expect(plan.systemPrompt).toContain("### CHARACTER IN SCENE: Saki Himekawa");
    expect(plan.postHistory).toContain("write Saki Himekawa in Iqbal's language");
    expect(plan.postHistory).not.toContain("Bitchy Goth girl slapped you!");
  });

  test("8. RPG and multi-character scenario presets resolve 'the cast' for guidance and populate ensemble roster", () => {
    const multiCard = {
      data: {
        name: "Your Bully and Her Friends Move Into Your House",
        personality: "# Name: Aoi\n Cold leader.\n# Name: Hina\n Teasing friend.\n# Name: Kuro\n Quiet observer.",
      },
    };
    const id = resolveCardIdentity(multiCard);
    expect(id.actorName).toBe("the cast");
    expect(id.isMultiCharOrRpg).toBe(true);
    expect(id.declaredCharacters).toEqual(["Aoi", "Hina", "Kuro"]);
    expect(ensembleCast(multiCard).map((m: { name: string }) => m.name)).toEqual(["Aoi", "Hina", "Kuro"]);

    const plan = BrowserChatEngine.planRequest({
      card: multiCard,
      session: { messages: [{ role: "user", content: "I open the door." }] },
      persona: { name: "Iqbal" },
      settings: {},
    });
    expect(plan.systemPrompt).toContain("### CAST IN SCENE (ensemble)");
    expect(plan.systemPrompt).toContain("- Aoi");
    expect(plan.systemPrompt).toContain("- Hina");
    expect(plan.postHistory).toContain("write the cast in Iqbal's language");
    expect(plan.postHistory).not.toContain("write Your Bully and Her Friends");

    const rpgCard = {
      data: {
        name: "Dark Fantasy Isekai RPG Simulator",
        description: "A vast sandbox world where {{char}} narrates guilds, monsters, and kingdoms for {{user}}.",
      },
    };
    const rpgPlan = BrowserChatEngine.planRequest({
      card: rpgCard,
      session: { messages: [{ role: "user", content: "I check the guild board." }] },
      persona: { name: "Iqbal" },
      settings: {},
    });
    expect(rpgPlan.systemPrompt).toContain("the cast narrates guilds");
    expect(rpgPlan.postHistory).toContain("write the cast in Iqbal's language");
  });
});

describe("cross-turn n-gram echo detection for agglutinative prose", () => {
  test("9. recurring 3-gram stock phrases across turns reach the slop cluster threshold", () => {
    const replies = [
      "Saki menatap tajam dengan mata menyipit sambil menggertakkan gigi di sudut ruangan.",
      "Dia mundur selangkah dengan mata menyipit lalu melipat kedua tangannya di dada.",
      "Gadis itu mendengus dengan mata menyipit ketika melihat sepatu platform-nya basah.",
      "Ia menendang lantai dengan sepatu platform-nya dan mengetuk kuku-kuku hitamnya.",
      "Saki menghela napas pada sepatu platform-nya sambil mengetuk kuku-kuku hitamnya.",
    ];
    expect(countCrossTurnNgramEchoes(replies)).toBeGreaterThanOrEqual(SLOP_CLUSTER_THRESHOLD);
  });

  test("10. opening scene and card description resolve {{user}}, {{obj}}, {{poss}}, {{sub}} without leaking raw tokens", () => {
    const firstMes =
      "*Then she spotted {{user}} near the side gate.*\n" +
      "*In three long strides she closed the distance, grabbed {{obj}} by the front of the shirt, and slammed {{obj}} back.*\n" +
      "*Her other hand fisted in {{poss}} collar. The way {{sub}} was looking at her—*";
    const persona = { name: "Iqbal", gender: "male", description: "He is a tall student." };
    const resolved = substitutePlaceholders(firstMes, {
      user: persona.name,
      char: "Saki Himekawa",
      persona,
    });
    expect(resolved).toContain("spotted Iqbal near");
    expect(resolved).toContain("grabbed him by");
    expect(resolved).toContain("fisted in his collar");
    expect(resolved).toContain("The way he was looking");
    expect(resolved).not.toMatch(/\{\{(?:user|char|sub|obj|poss|possp|ref)\}\}/i);

    const card = {
      data: {
        name: "Bitchy Goth girl slapped you!",
        description: "# Full name: Saki Himekawa\n{{char}} corners {{user}} and grabs {{poss}} collar.",
      },
    };
    const blurb = cardDescription(card, persona);
    expect(blurb).toContain("Saki Himekawa corners Iqbal and grabs his collar.");
  });
});
