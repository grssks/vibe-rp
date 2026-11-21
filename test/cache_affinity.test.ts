import { describe, expect, test } from "bun:test";
import { BrowserChatEngine, detectParameterRejection, ensembleCast } from "../public/browser_engine.js";
import { normalizeEndpointBase, extractMessageText, postWithParamRetry, learnRejectedParam } from "../public/llm_transport.js";
import { promptCacheKeyFor, clearModelCapabilities, noteCacheObservation, getModelCapability } from "../public/model_capability.js";
import { analyzeTurnState, countCrossTurnNgramEchoes, SLOP_CLUSTER_THRESHOLD } from "../public/prompt_adaptive.js";
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

  test("11. multilingual contrast tic ('Alih-alih X, Y' / 'bukan X, melainkan Y') and verbatim 4-gram echoes fire on Indonesian replies", () => {
    const messages = [
      { role: "user", content: "Aku menyodorkan botol air dingin ke arah Saki." },
      {
        role: "assistant",
        content:
          "Alih-alih menolak dan mati kehausan demi gengsi, ia menengadahkan kepala dan menenggak air dingin itu dengan rakus. Jakunnya naik-turun cepat saat cairan es membasahi kerongkongannya.",
      },
      { role: "user", content: "Aku memperhatikannya minum." },
      {
        role: "assistant",
        content:
          "Alih-alih meneguknya pelan, mulut botol itu ia jejalkan ke bibirnya dan menenggak air dingin itu dengan rakus. Jakunnya naik-turun cepat.",
      },
    ];
    const state = analyzeTurnState({
      messages,
      charName: "Saki Himekawa",
      playerName: "Iqbal",
    });
    expect(state.tics.some((t) => t.id === "contrast")).toBe(true);
    expect(state.slopHits).toBeGreaterThanOrEqual(SLOP_CLUSTER_THRESHOLD);
  });
});

describe("endpoint & transport hardening", () => {
  test("12. normalizeEndpointBase strips trailing slashes, /chat/completions, and /models", () => {
    expect(normalizeEndpointBase(" https://api.example.com/v1/// ")).toBe("https://api.example.com/v1");
    expect(normalizeEndpointBase("https://api.example.com/v1/chat/completions/")).toBe("https://api.example.com/v1");
    expect(normalizeEndpointBase("https://api.example.com/v1/models")).toBe("https://api.example.com/v1");
  });

  test("13. fetchAvailableModels handles { models: [{ name }] }, bare string arrays, and deduplicates", async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ models: [{ name: "m-a" }, { id: "m-b" }, { name: "m-a" }] }), { status: 200 })) as unknown as typeof fetch;
      expect(await BrowserChatEngine.fetchAvailableModels("https://api.example.com/v1/models", "k")).toEqual(["m-a", "m-b"]);

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(["raw-1", "raw-2", "raw-1"]), { status: 200 })) as unknown as typeof fetch;
      expect(await BrowserChatEngine.fetchAvailableModels("https://api.example.com/v1", "")).toEqual(["raw-1", "raw-2"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("14. detectParameterRejection + learnRejectedParam drops min_p and matches reversed reasoning_effort errors", () => {
    clearModelCapabilities();
    try {
      const ep = "https://strict-gateway.test/v1";
      const model = "strict-m";
      const minPErr = new Error("HTTP 400: Extra inputs are not permitted: min_p");
      expect(detectParameterRejection(minPErr)?.unsupportedMinP).toBe(true);
      expect(learnRejectedParam(ep, model, minPErr)).toBe(true);
      const body = BrowserChatEngine.buildRequestBody({ apiEndpoint: ep, model, minP: 0.08 }, msgs);
      expect("min_p" in body).toBe(false);

      const reErr = new Error("HTTP 400: Extra inputs are not permitted: reasoning_effort");
      expect(detectParameterRejection(reErr)?.unsupportedReasoningEffort).toBe(true);
    } finally {
      clearModelCapabilities();
    }
  });

  test("15. extractMessageText joins array-of-parts content and generateChoices parses it", async () => {
    expect(extractMessageText([{ type: "text", text: "Hello " }, { type: "text", text: "world" }])).toBe("Hello world");
    clearModelCapabilities();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: [{ type: "text", text: '{"choices":[{"label":"Look","text":"I look around."}]}' }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const res = await BrowserChatEngine.generateChoices({
        card: { data: { name: "Elena" } },
        session: { messages: [{ role: "assistant", content: "Silence." }], ledger: "", consumed: 1 },
        settings: { apiEndpoint: "https://parts.test/v1", model: "parts-m", maxContextTokens: 8192 },
        count: 3,
      });
      expect(res.choices.length).toBe(1);
      expect(res.choices[0].label).toBe("Look");
    } finally {
      globalThis.fetch = origFetch;
      clearModelCapabilities();
    }
  });

  test("16. postWithParamRetry retries transient 429/503 responses and succeeds", async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("Rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { res, error } = await postWithParamRetry({
        base: "https://retry.test/v1",
        headers: { "Content-Type": "application/json" },
        endpoint: "https://retry.test/v1",
        model: "m",
        buildBody: () => ({ model: "m", messages: msgs }),
        transientDelayMs: 1,
      });
      expect(calls).toBe(2);
      expect(res.ok).toBe(true);
      expect(error).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("17. Indonesian PROSE_TICS (emotionMix, triads, explainedTheBeat) and Indonesian SLOP_LEXICON fire on clustered replies", () => {
    const messages = [
      { role: "user", content: "Aku menatapnya." },
      {
        role: "assistant",
        content:
          "Ia menelan ludah dan napasnya tercekat. Di dadanya ada campuran takut dan lega, seolah sedang menahan sesuatu. Ia meletakkan lampu, kunci, dan peta di meja.",
      },
      { role: "user", content: "Aku menunggu jawabannya." },
      {
        role: "assistant",
        content:
          "Dengan suara serak ia menyeringai tipis, tulang punggungnya menegang. Ada perpaduan marah dan cemas di suaranya, ada sesuatu di matanya saat meraih pedang, perisai, dan jubah.",
      },
      { role: "user", content: "Katanya?" },
      {
        role: "assistant",
        content:
          "Rahangnya mengeras dan tatapannya tak lepas dariku, seolah ingin memastikan semuanya.",
      },
    ];
    const state = analyzeTurnState({
      messages,
      charName: "Saki Himekawa",
      playerName: "Iqbal",
    });
    const ids = state.tics.map((t) => t.id);
    expect(ids).toContain("emotionMix");
    expect(ids).toContain("triads");
    expect(ids).toContain("explainedTheBeat");
    expect(state.slopHits).toBeGreaterThanOrEqual(SLOP_CLUSTER_THRESHOLD);
  });

  test("18. noteCacheObservation switches planChoiceRequest to compact prompt after 3 uncached large turns and includes authorsNote", () => {
    clearModelCapabilities();
    try {
      const ep = "https://nocache-gateway.test/v1";
      const model = "story-m";
      const card = {
        data: {
          name: "Elena",
          description: "A borderlands cartographer.",
          personality: "Guarded, precise, observant.",
          scenario: "In the salt-flat watchtower at dusk.",
        },
      };
      const session = {
        id: "sess_nc",
        authorsNote: "Keep tension dry and understated.",
        messages: [
          { role: "user", content: "I set the lantern down." },
          { role: "assistant", content: "She watches the ridge without speaking." },
        ],
        ledger: "",
        consumed: 1,
      };
      const settings = { apiEndpoint: ep, model, maxContextTokens: 8192, maxTokens: 1000 };

      // Before 3 uncached turns, same-model uses sharedPrefix: true.
      const before = BrowserChatEngine.planChoiceRequest({ card, session, settings, persona: { name: "Rowan" }, count: 3 });
      expect(before.sharedPrefix).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        noteCacheObservation(ep, model, { prompt_tokens: 1500, prompt_tokens_details: { cached_tokens: 0 } });
      }
      expect(getModelCapability(ep, model).uncachedStreak).toBe(3);

      const after = BrowserChatEngine.planChoiceRequest({ card, session, settings, persona: { name: "Rowan" }, count: 3 });
      expect(after.sharedPrefix).toBe(false);
      expect(after.payload[0].content).toContain("Note: Keep tension dry and understated.");
    } finally {
      clearModelCapabilities();
    }
  });

  test("19. sycophancy and openingEcho detectors fire on English and Indonesian transcripts", () => {
    const enState = analyzeTurnState({
      messages: [
        { role: "user", content: "I step closer and ask why you lied." },
        { role: "assistant", content: "As you step closer, she sighs. \"Of course, you're right.\"" },
        { role: "user", content: "That's not an answer." },
        { role: "assistant", content: "When you press her, she nods. \"Certainly, I completely understand.\"" },
      ],
      charName: "Elena",
      playerName: "Rowan",
    });
    const enIds = enState.tics.map((t) => t.id);
    expect(enIds).toContain("sycophancy");
    expect(enIds).toContain("openingEcho");

    const idState = analyzeTurnState({
      messages: [
        { role: "user", content: "Aku mendekat dan bertanya." },
        { role: "assistant", content: "Saat kamu mendekat, dia mengangguk. \"Tentu saja, kamu benar.\"" },
        { role: "user", content: "Jelaskan sekarang." },
        { role: "assistant", content: "Mendengar kamu mendesak, dia tersenyum. \"Baiklah kalau begitu, aku mengerti sepenuhnya.\"" },
      ],
      charName: "Saki",
      playerName: "Iqbal",
    });
    const idIds = idState.tics.map((t) => t.id);
    expect(idIds).toContain("sycophancy");
    expect(idIds).toContain("openingEcho");
  });
});
