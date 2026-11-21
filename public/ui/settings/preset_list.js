// Generic preset list: the shared mount/refresh/destroy flow behind the
// persona and directive lists. Both lists render rows keyed by id, show an
// empty state, and toast on delete — only the row builder, empty copy, and
// delete-toast noun differ.
import { el, renderKeyed } from "../dom.js";

export function mountPresetList(root, options = {}) {
  const { load, onEdit, onCreate, onDelete, onSetDefault, host, listClass, emptyTitle, emptyBody, deleteToast, buildRow } = options;
  if (!root) return { refresh: async () => {}, destroy: () => {} };

  const list = el("div", { class: listClass });
  root.replaceChildren(list);

  const handlers = {
    onEdit: (item) => onEdit?.(item),
    onSetDefault: async (item) => {
      await onSetDefault?.(item);
      await refresh();
    },
    onDelete: async (item) => {
      const removed = await onDelete?.(item);
      if (removed === false) return;
      host?.toast?.(deleteToast(item), { tone: "info" });
      await refresh();
    },
  };

  let destroyed = false;

  async function refresh() {
    const items = (await load?.()) || [];
    if (destroyed) return;
    if (items.length === 0) {
      list.replaceChildren(
        el("div", { class: "rp-empty" }, [
          el("p", { class: "rp-empty__title", text: emptyTitle }),
          el("p", { class: "rp-empty__body", text: emptyBody }),
        ])
      );
      return;
    }
    renderKeyed(list, items, (item) => item.id, (item, existing) => buildRow(item, handlers, existing));
  }

  const createBtn = options.createButton;
  const onCreateClick = () => onCreate?.();
  if (createBtn) createBtn.addEventListener("click", onCreateClick);

  return {
    refresh,
    destroy() {
      destroyed = true;
      if (createBtn) createBtn.removeEventListener("click", onCreateClick);
      root.replaceChildren();
    },
  };
}
