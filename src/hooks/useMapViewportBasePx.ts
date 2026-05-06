import { useLayoutEffect, useState } from "react";
import {
  MAP_VIEWPORT_PX,
  MAP_VIEWPORT_PX_MAX,
  MAP_VIEWPORT_PX_MIN,
} from "@/constants/game";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readVisualSize(): { vw: number; vh: number } {
  if (typeof window === "undefined") return { vw: 390, vh: 700 };
  const vv = window.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) {
    return { vw: vv.width, vh: vv.height };
  }
  return { vw: window.innerWidth, vh: window.innerHeight };
}

/** 根据窗口尺寸计算地图方形视口边长（为大屏 / iPad 放大可玩区域） */
export function computeMapViewportBasePx(): number {
  if (typeof window === "undefined") return MAP_VIEWPORT_PX;
  const { vw, vh } = readVisualSize();
  const reserveY = clamp(Math.round(vh * 0.38), 260, 400);
  const maxSquare = Math.min(vw - 20, vh - reserveY);
  let side = clamp(Math.floor(maxSquare), MAP_VIEWPORT_PX_MIN, MAP_VIEWPORT_PX_MAX);
  if (side % 2) side -= 1;
  return side;
}

/** 对局中地图滚动区域边长（随窗口变化，含 resize） */
export function useMapViewportBasePx(): number {
  const [px, setPx] = useState(() =>
    typeof window !== "undefined" ? computeMapViewportBasePx() : MAP_VIEWPORT_PX
  );

  useLayoutEffect(() => {
    const update = () => setPx(computeMapViewportBasePx());
    update();
    window.addEventListener("resize", update);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, []);

  return px;
}
