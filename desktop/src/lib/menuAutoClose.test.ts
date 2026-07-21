import { describe, expect, it } from "vitest";
import { closeMenusOnOutsidePointerdown, installMenuAutoClose } from "./menuAutoClose";

class FakeDetails {
  open = true;
  private children: FakeDetails[] = [];

  add(child: FakeDetails) {
    this.children.push(child);
    return child;
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  querySelectorAll(selectors: string) {
    if (selectors.includes("data-menu")) return [];
    return this.children.filter((child) => child.open);
  }
}

function rootWith(...menus: FakeDetails[]) {
  return { querySelectorAll: () => menus.filter((menu) => menu.open) };
}

describe("closeMenusOnOutsidePointerdown", () => {
  it("closes an open menu when the pointer lands outside", () => {
    const menu = new FakeDetails();
    closeMenusOnOutsidePointerdown(rootWith(menu), {});
    expect(menu.open).toBe(false);
  });

  it("keeps the menu open when the pointer lands inside", () => {
    const menu = new FakeDetails();
    const button = menu.add(new FakeDetails());
    closeMenusOnOutsidePointerdown(rootWith(menu), button);
    expect(menu.open).toBe(true);
  });

  it("closes nested submenus together with their parent", () => {
    const menu = new FakeDetails();
    const submenu = menu.add(new FakeDetails());
    closeMenusOnOutsidePointerdown(rootWith(menu), {});
    expect(menu.open).toBe(false);
    expect(submenu.open).toBe(false);
  });

  it("ignores interactions while no menu is open", () => {
    const menu = new FakeDetails();
    menu.open = false;
    closeMenusOnOutsidePointerdown(rootWith(), {});
    expect(menu.open).toBe(false);
  });
});

describe("installMenuAutoClose", () => {
  it("wires a capture-phase pointerdown listener and returns an uninstaller", () => {
    const menu = new FakeDetails();
    const listeners = new Map<string, (event: { target: unknown }) => void>();
    const doc = {
      querySelectorAll: () => [menu],
      addEventListener: (type: string, fn: (event: { target: unknown }) => void, capture: boolean) => {
        expect(capture).toBe(true);
        listeners.set(type, fn);
      },
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const uninstall = installMenuAutoClose(doc as unknown as Document);
    listeners.get("pointerdown")?.({ target: {} });
    expect(menu.open).toBe(false);
    uninstall();
    expect(listeners.has("pointerdown")).toBe(false);
  });
});
