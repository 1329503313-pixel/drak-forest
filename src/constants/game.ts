/** 与 server/game/constants 对齐（客户端 UI / 校验） */
export const ATTACK_RANGE_CHEBYSHEV = 2;
export const ATTACK_DAMAGE = 3;
/** 窄屏默认边长；宽屏由 `useMapViewportBasePx` 在 MIN–MAX 之间动态计算 */
export const MAP_VIEWPORT_PX = 360;
export const MAP_VIEWPORT_PX_MIN = 304;
export const MAP_VIEWPORT_PX_MAX = 560;
export const MAP_ZOOM_MIN = 0.6;
export const MAP_ZOOM_MAX = 4.2;
/** 单格边长（CSS px）低于此值时隐藏格内坐标。20×20、100% 缩放时为 360/20=18，故取 18 */
export const MAP_COORD_MIN_CELL_PX = 18;
