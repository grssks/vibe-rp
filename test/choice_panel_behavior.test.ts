// Choice Mode: the steer control's behaviour, driven for real.
//
// The rest of the presentation layer is guarded by reading its source text,
// which cannot tell whether a control works. This file runs the actual panel
// against a minimal DOM shim, because the defect it covers was behavioural and
// invisible to a source guard: the steer field was read on submit and never
// cleared, so the panel — built once per page and reused for every later menu —
// handed the same consumed intent back on the next open, and the reader had to
// delete it by hand every time.
import { describe, test, expect, beforeEach } from "bun:test";
import { installDom, click, type ShimNode } from "./dom_shim.js";

let document: ReturnType<typeof installDom>;

beforeEach(() => {
  document = installDom();
});

// Imported after the shim exists: the panel reads `document` when it is created,
// and `dom.js` reaches for it at call time.
const { createChoicePanel } = await import("../public/ui/chat/choice_panel.js");

function mountPanel() {
  const mount = document.createElement("section");
  const calls: Array<string> = [];
  const panel = createChoicePanel({
    mount,
    onSelect: (id: string) => calls.push(`select:${id}`),
    onRegenerate: (intent: string) => calls.push(`regenerate:${intent}`),
    onRetry: () => calls.push("retry"),
  });
  return { mount, panel, calls };
}

const find = (root: ShimNode, selector: string) => {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`no element matched ${selector}`);
  return node;
};

const READY = {
  mode: "choice" as const,
  status: "ready" as const,
  choices: [
    { id: "c1", text: "I step forward." },
    { id: "c2", text: "I wait." },
    { id: "c3", text: "I speak." },
  ],
  error: null,
  selectedId: null,
};

describe("the steer field does not keep a consumed intent", () => {
  test("submitting an intent empties the field", () => {
    const { mount, panel, calls } = mountPanel();
    panel.render(READY);

    const toggle = find(mount, ".rp-choices__steer-toggle");
    const input = find(mount, ".rp-choices__steer-input") as ShimNode & { value: string };
    const submit = find(mount, ".rp-choices__steer-submit");

    click(toggle);
    input.value = "climb the observatory ladder";
    click(submit);

    expect(calls).toEqual(["regenerate:climb the observatory ladder"]);
    expect(input.value).toBe("");
  });

  test("the next menu opens with an empty field, not the last intent", () => {
    // The defect as reported: send a steered message, read the reply, and the
    // fresh menu's steer box still held the previous text.
    const { mount, panel } = mountPanel();
    panel.render(READY);

    const toggle = find(mount, ".rp-choices__steer-toggle");
    const input = find(mount, ".rp-choices__steer-input") as ShimNode & { value: string };
    click(toggle);
    input.value = "draw the dagger";
    click(find(mount, ".rp-choices__steer-submit"));

    // The menu that follows a steered turn arrives as a fresh ready set.
    panel.render({ ...READY, status: "generating", choices: [] });
    panel.render({
      ...READY,
      choices: [{ id: "d1", text: "I reach for it." }],
    });

    click(toggle);
    expect(input.value).toBe("");
  });

  test("a failed menu hands the intent back instead of losing it", () => {
    const { mount, panel } = mountPanel();
    panel.render(READY);

    const input = find(mount, ".rp-choices__steer-input") as ShimNode & { value: string };
    click(find(mount, ".rp-choices__steer-toggle"));
    input.value = "run for the door";
    click(find(mount, ".rp-choices__steer-submit"));
    expect(input.value).toBe("");

    panel.render({ ...READY, status: "error", choices: [], error: "Rate limited." });
    expect(input.value).toBe("run for the door");
  });

  test("the steer control stays reachable on a failed menu", () => {
    // It used to be gated on `ready` alone, so the one state where the reader
    // most needs to try a different direction hid the control.
    const { mount, panel } = mountPanel();
    panel.render({ ...READY, status: "error", choices: [], error: "Rate limited." });
    const toggle = find(mount, ".rp-choices__steer-toggle");
    expect(toggle.hidden).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  test("a draft that was never submitted survives, and Cancel keeps it", () => {
    // Cancel means "never mind", not "throw away what I typed".
    const { mount, panel } = mountPanel();
    panel.render(READY);

    const input = find(mount, ".rp-choices__steer-input") as ShimNode & { value: string };
    click(find(mount, ".rp-choices__steer-toggle"));
    input.value = "half a thought";
    click(find(mount, ".rp-choices__steer-cancel"));

    panel.render(READY);
    expect(input.value).toBe("half a thought");
  });

  test("an empty submission is a no-op, and does not consume anything", () => {
    const { mount, panel, calls } = mountPanel();
    panel.render(READY);

    const input = find(mount, ".rp-choices__steer-input") as ShimNode & { value: string };
    click(find(mount, ".rp-choices__steer-toggle"));
    input.value = "   ";
    click(find(mount, ".rp-choices__steer-submit"));

    expect(calls).toEqual([]);
    expect(input.value).toBe("   ");
  });

  test("the control is hidden while a request is in flight", () => {
    const { mount, panel } = mountPanel();
    panel.render({ ...READY, status: "generating", choices: [] });
    expect(find(mount, ".rp-choices__steer-toggle").hidden).toBe(true);
  });
});

describe("choice rendering handles dialogue quotes and accessibility safely", () => {
  test("direct quoted dialogue lands as safe text without escaping issues", () => {
    const { mount, panel, calls } = mountPanel();
    panel.render({
      mode: "choice",
      status: "ready",
      choices: [
        { id: "c1", label: "Speak up", text: 'Call out loudly: "Who\'s there? Show yourself!"' },
        { id: "c2", label: "Whisper", text: '“Don’t move,” she warned, “or you’ll trigger it.”' },
        { id: "c3", label: "", text: 'Step back into <shadows> & hold your breath.' },
      ],
      error: null,
      selectedId: null,
    });

    const buttons = mount.querySelectorAll(".rp-choices__option");
    expect(buttons.length).toBe(3);

    // Button 1 displays label if present, provides full quoted action via title
    const text1 = buttons[0].querySelector(".rp-choices__text");
    expect(text1?.textContent).toBe("Speak up");
    expect(buttons[0].title).toBe('Call out loudly: "Who\'s there? Show yourself!"');
    expect(buttons[0].classList.contains("rp-choice-card")).toBe(true);
    expect(text1?.classList.contains("rp-choice-card__text")).toBe(true);

    // Button 2 preserves quoted dialogue in title
    expect(buttons[1].title).toBe('“Don’t move,” she warned, “or you’ll trigger it.”');

    // Button 3 has no label, displays text safely without treating <shadows> as HTML
    const text3 = buttons[2].querySelector(".rp-choices__text");
    expect(text3?.textContent).toBe("Step back into <shadows> & hold your breath.");
    expect(buttons[2].innerHTML).not.toContain("<shadows>");

    // Clicking choice 1 triggers onSelect with its id
    click(buttons[0]);
    expect(calls).toEqual(["select:c1"]);
  });
  test("numeric shortcut selects choice containing direct dialogue", () => {
    const { mount, panel, calls } = mountPanel();
    panel.render({
      mode: "choice",
      status: "ready",
      choices: [
        { id: "c1", text: 'Voice level: "Tell me the truth."' },
        { id: "c2", text: 'Stay silent.' },
      ],
      error: null,
      selectedId: null,
    });

    document.dispatch("keydown", { key: "1" });

    expect(calls).toEqual(["select:c1"]);
  });
  test("steer toggle and bar maintain aria-expanded and restore focus on cancel", () => {
    const { mount, panel } = mountPanel();
    panel.render(READY);

    const toggle = find(mount, ".rp-choices__steer-toggle");
    const bar = find(mount, ".rp-choices__steer-bar");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("choice-steer-bar");
    expect(bar.id).toBe("choice-steer-bar");

    // Open steer bar
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(bar.hidden).toBe(false);

    // Cancel restores aria-expanded and focuses toggle
    const cancelBtn = find(mount, ".rp-choices__steer-cancel");
    click(cancelBtn);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(bar.hidden).toBe(true);
    expect(toggle.focused).toBe(true);
  });
});
