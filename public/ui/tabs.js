// Tabs: the WAI-ARIA APG tabs pattern, one implementation.
//
// Contract
//   - Markup: a `[role="tablist"]` holding `[role="tab"]` buttons, plus one
//     `[role="tabpanel"]` per tab. Each tab points at its panel with
//     `aria-controls`; each panel points back with `aria-labelledby`.
//   - `initTabs(tablist, { activation })` wires roles, ids, roving tabindex
//     and the keyboard model. `activation` is `"auto"` (default: arrow keys
//     select as they move) or `"manual"` (arrow keys move focus only; Enter
//     or Space selects).
//   - Keys: ArrowLeft/ArrowRight move between tabs, Home and End jump to the
//     ends, Enter and Space select in manual mode. Disabled tabs are skipped.
//   - Returns `{ select, destroy, activeTab }`. `select(idOrIndex)` is for
//     programmatic changes such as a URL parameter.
//
// Exports
//   initTabs(tablist, options) -> controller

let tabCounter = 0;

// Tabs are discovered by role OR by the shared class, because the caller may
// hand us markup before `role="tab"` has been applied.
function tabsOf(tablist) {
  const found = tablist.querySelectorAll('[role="tab"], .rp-tab');
  return Array.from(found).filter(
    (tab) => !tab.hasAttribute("disabled") && tab.getAttribute("aria-disabled") !== "true"
  );
}

function panelFor(tab, tablist) {
  const id = tab.getAttribute("aria-controls");
  if (id) {
    const found = document.getElementById(id);
    if (found) return found;
  }
  return null;
}

/**
 * Initialises one tablist. The panels may live outside the tablist; they are
 * resolved through `aria-controls`.
 */
export function initTabs(tablist, { activation = "auto" } = {}) {
  if (!tablist) {
    return { select: () => {}, destroy: () => {}, activeTab: () => null };
  }

  const group = `rp-tabs-${++tabCounter}`;
  tablist.setAttribute("role", "tablist");
  if (!tablist.hasAttribute("aria-orientation")) {
    tablist.setAttribute("aria-orientation", "horizontal");
  }

  const tabs = tabsOf(tablist);
  const panels = [];

  tabs.forEach((tab, index) => {
    if (!tab.id) tab.id = `${group}-tab-${index}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "-1");
    const panel = panelFor(tab, tablist);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      if (!panel.id) panel.id = `${group}-panel-${index}`;
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("tabindex", "0");
      panels.push(panel);
    }
  });

  const enabled = tabsOf(tablist);
  if (enabled.length === 0) {
    return { select: () => {}, destroy: () => {}, activeTab: () => null };
  }

  let currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true")
  );
  if (tabs[currentIndex] && !enabled.includes(tabs[currentIndex])) currentIndex = 0;
  let focusedIndex = currentIndex;

  function render(focusTab) {
    focusedIndex = currentIndex;
    tabs.forEach((tab, index) => {
      const selected = index === currentIndex;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.classList.toggle("is-active", selected);
      // Roving tabindex: only the selected tab is in the page tab order.
      tab.setAttribute("tabindex", selected ? "0" : "-1");
      const panel = panelFor(tab, tablist);
      if (panel) {
        panel.hidden = !selected;
        panel.classList.toggle("is-active", selected);
      }
      if (selected && focusTab) tab.focus();
    });
  }

  function focusOnly(targetTab) {
    focusedIndex = tabs.indexOf(targetTab);
    for (const tab of tabs) tab.setAttribute("tabindex", tab === targetTab ? "0" : "-1");
    targetTab.focus();
  }

  function move(delta) {
    const active = tabsOf(tablist);
    const order = tabs.filter((tab) => active.includes(tab));
    if (!order.length) return;
    const baseIndex = activation === "auto" ? currentIndex : focusedIndex;
    let at = order.indexOf(tabs[baseIndex]);
    if (at === -1) at = 0;
    const next = order[(at + delta + order.length) % order.length];
    if (activation === "auto") {
      currentIndex = tabs.indexOf(next);
      render(true);
    } else {
      focusOnly(next);
    }
  }

  function onKeydown(event) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home": {
        event.preventDefault();
        const active = tabsOf(tablist);
        if (!active.length) break;
        if (activation === "auto") {
          currentIndex = tabs.indexOf(active[0]);
          render(true);
        } else {
          focusOnly(active[0]);
        }
        break;
      }
      case "End": {
        event.preventDefault();
        const active = tabsOf(tablist);
        if (!active.length) break;
        const last = active[active.length - 1];
        if (activation === "auto") {
          currentIndex = tabs.indexOf(last);
          render(true);
        } else {
          focusOnly(last);
        }
        break;
      }
      case "Enter":
      case " ":
        if (activation === "manual") {
          const tab = event.target.closest?.('[role="tab"]');
          const active = tabsOf(tablist);
          if (!tab || !tabs.includes(tab) || !active.includes(tab)) break;
          event.preventDefault();
          currentIndex = tabs.indexOf(tab);
          render(true);
        }
        break;
      default:
        break;
    }
  }

  function onFocusIn(event) {
    if (activation !== "auto") return;
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !tabs.includes(tab)) return;
    if (tabs.indexOf(tab) !== currentIndex) {
      currentIndex = tabs.indexOf(tab);
      render(false);
    }
  }

  function onClick(event) {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !tabs.includes(tab)) return;
    currentIndex = tabs.indexOf(tab);
    render(false);
  }

  tablist.addEventListener("keydown", onKeydown);
  tablist.addEventListener("focusin", onFocusIn);
  tablist.addEventListener("click", onClick);
  render(false);

  return {
    /**
     * Selects a tab by index, element id, `data-tab` value, or the id of the
     * panel it controls. Panel-id matching is what the URL handoff uses.
     */
    select(target) {
      let index = -1;
      if (typeof target === "number") index = target;
      else if (typeof target === "string")
        index = tabs.findIndex(
          (tab) => tab.id === target || tab.dataset.tab === target || tab.getAttribute("aria-controls") === target
        );
      else if (target instanceof Element) index = tabs.indexOf(target);
      const active = tabsOf(tablist);
      if (index < 0 || index >= tabs.length || !active.includes(tabs[index])) return false;
      currentIndex = index;
      render(false);
      return true;
    },
    /** The currently selected tab element, or null. */
    activeTab() {
      return tabs[currentIndex] || null;
    },
    destroy() {
      tablist.removeEventListener("keydown", onKeydown);
      tablist.removeEventListener("focusin", onFocusIn);
      tablist.removeEventListener("click", onClick);
    },
  };
}
