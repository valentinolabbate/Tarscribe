const MENU_SELECTOR = "details[data-menu][open]";
const OPEN_DETAILS_SELECTOR = "details[open]";

interface DetailsElementLike {
  open: boolean;
  contains(target: unknown): boolean;
  querySelectorAll(selectors: string): ArrayLike<DetailsElementLike>;
}

interface MenuRootLike {
  querySelectorAll(selectors: string): ArrayLike<DetailsElementLike>;
}

function closeMenu(menu: DetailsElementLike) {
  menu.open = false;
  for (const child of Array.from(menu.querySelectorAll(OPEN_DETAILS_SELECTOR))) {
    child.open = false;
  }
}

export function closeMenusOnOutsidePointerdown(root: MenuRootLike, target: unknown) {
  if (target == null) return;
  for (const menu of Array.from(root.querySelectorAll(MENU_SELECTOR))) {
    if (!menu.contains(target)) closeMenu(menu);
  }
}

export function installMenuAutoClose(doc: Document = document) {
  const handler = (event: Event) =>
    closeMenusOnOutsidePointerdown(doc as unknown as MenuRootLike, event.target);
  doc.addEventListener("pointerdown", handler, true);
  return () => doc.removeEventListener("pointerdown", handler, true);
}
