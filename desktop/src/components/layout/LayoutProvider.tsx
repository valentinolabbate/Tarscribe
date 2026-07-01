import { useCallback, useEffect, useState, type MouseEvent } from "react";

const clampSidebarWidth = (width: number) =>
  Math.max(224, Math.min(320, window.innerWidth - 720, Number.isFinite(width) ? width : 264));

export function useSidebarWidth() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const value = localStorage.getItem("ts-sidebar-w");
      return clampSidebarWidth(value ? Number(value) : 264);
    } catch {
      return 264;
    }
  });

  const handleResizerDown = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const onMove = (moveEvent: globalThis.MouseEvent) =>
        setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
      const onUp = (upEvent: globalThis.MouseEvent) => {
        const width = clampSidebarWidth(startWidth + upEvent.clientX - startX);
        setSidebarWidth(width);
        try {
          localStorage.setItem("ts-sidebar-w", String(width));
        } catch {
          /* ignore */
        }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  useEffect(() => {
    const onResize = () => setSidebarWidth((width) => clampSidebarWidth(width));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { sidebarWidth, handleResizerDown };
}
