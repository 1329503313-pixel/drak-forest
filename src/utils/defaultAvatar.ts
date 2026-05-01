function svgDataUrl(svg: string): string {
  return "data:image/svg+xml," + encodeURIComponent(svg.replace(/\s+/g, " ").trim());
}

/**
 * 与历史一致：未上传头像时使用原「第 1 枚预设」— 深林猎手（128×128 兜帽猎手插画）。
 */
const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs>
  <linearGradient id="s0bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#122228"/><stop offset="45%" stop-color="#081218"/><stop offset="100%" stop-color="#030608"/>
  </linearGradient>
  <radialGradient id="s0vin" cx="50%" cy="40%" r="65%">
    <stop offset="0%" stop-color="#183038" stop-opacity="0"/><stop offset="100%" stop-color="#020408" stop-opacity="0.85"/>
  </radialGradient>
  <radialGradient id="s0moon" cx="82%" cy="10%" r="22%">
    <stop offset="0%" stop-color="#f4fffc" stop-opacity="0.55"/><stop offset="40%" stop-color="#b8d8e8" stop-opacity="0.2"/><stop offset="100%" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="s0hood" x1="0.3" y1="0" x2="0.7" y2="1">
    <stop offset="0%" stop-color="#3d5668"/><stop offset="35%" stop-color="#283848"/><stop offset="75%" stop-color="#1a2832"/><stop offset="100%" stop-color="#121c24"/>
  </linearGradient>
  <linearGradient id="s0fur" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#8a9ca8"/><stop offset="100%" stop-color="#5a6874"/>
  </linearGradient>
  <radialGradient id="s0skin" cx="42%" cy="38%" r="55%">
    <stop offset="0%" stop-color="#ffe8d4"/><stop offset="55%" stop-color="#e8c4a8"/><stop offset="100%" stop-color="#c89878"/>
  </radialGradient>
  <linearGradient id="s0eyeL" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#3a5068"/><stop offset="60%" stop-color="#1a2838"/><stop offset="100%" stop-color="#0c1018"/>
  </linearGradient>
  <filter id="s0g" x="-15%" y="-15%" width="130%" height="130%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="128" height="128" rx="28" fill="url(#s0bg)"/>
<ellipse cx="64" cy="52" rx="58" ry="52" fill="url(#s0vin)"/>
<circle cx="104" cy="18" r="16" fill="url(#s0moon)"/>
<path d="M22 22 L26 18 L24 26 Z M98 26 L102 22 L100 28 Z M108 38 L112 36 L110 42 Z" fill="#e8f4ff" opacity="0.35"/>
<path d="M64 14 C34 14 18 42 22 62 L26 84 C30 96 44 106 64 106 C84 106 98 96 102 84 L106 62 C110 42 94 14 64 14Z" fill="url(#s0hood)" stroke="#0c141c" stroke-width="1"/>
<path d="M64 18 C40 18 26 40 28 56 Q64 48 100 56 C102 40 88 18 64 18Z" fill="#000" opacity="0.18"/>
<path d="M38 44 Q64 28 90 44" fill="none" stroke="#6a8294" stroke-width="1.2" opacity="0.45" stroke-linecap="round"/>
<ellipse cx="64" cy="58" rx="26" ry="30" fill="url(#s0skin)" stroke="#8a6858" stroke-width="0.9"/>
<path d="M42 52 Q40 68 48 76 Q64 82 80 76 Q88 68 86 52" fill="#000" opacity="0.12"/>
<ellipse cx="52" cy="56" rx="8" ry="10" fill="url(#s0eyeL)"/><ellipse cx="76" cy="56" rx="8" ry="10" fill="url(#s0eyeL)"/>
<ellipse cx="52" cy="56" rx="4.5" ry="5.5" fill="#0c1018"/><ellipse cx="76" cy="56" rx="4.5" ry="5.5" fill="#0c1018"/>
<ellipse cx="54" cy="54" rx="2.2" ry="2.8" fill="#5080a8"/><ellipse cx="78" cy="54" rx="2.2" ry="2.8" fill="#5080a8"/>
<ellipse cx="53.5" cy="53" rx="1.2" ry="1.5" fill="#fff"/><ellipse cx="77.5" cy="53" rx="1.2" ry="1.5" fill="#fff"/>
<ellipse cx="54.8" cy="52.2" rx="0.45" ry="0.55" fill="#fff"/>
<path d="M54 68 Q64 74 74 68" stroke="#a87868" stroke-width="1.6" fill="none" stroke-linecap="round"/>
<ellipse cx="46" cy="64" rx="5" ry="3.5" fill="#e87868" opacity="0.22"/><ellipse cx="82" cy="64" rx="5" ry="3.5" fill="#e87868" opacity="0.22"/>
<ellipse cx="64" cy="48" rx="3" ry="2" fill="#000" opacity="0.08"/>
<path d="M26 72 Q22 88 28 98 Q36 104 44 100 L44 92 Q34 88 32 76Z" fill="url(#s0fur)" stroke="#3a4854" stroke-width="0.6"/>
<path d="M102 72 Q106 88 100 98 Q92 104 84 100 L84 92 Q94 88 96 76Z" fill="url(#s0fur)" stroke="#3a4854" stroke-width="0.6"/>
<circle cx="64" cy="92" r="9" fill="#4a6048" stroke="#2a4030" stroke-width="0.8"/>
<path d="M58 88 Q64 84 70 88 Q64 94 58 88" fill="#6a9870" stroke="#4a7848" stroke-width="0.4"/>
<path d="M48 78 L52 72 L56 78 M72 78 L76 72 L80 78" stroke="#c8a868" stroke-width="0.8" stroke-linecap="round" opacity="0.85"/>
</svg>`;

export const DEFAULT_AVATAR = svgDataUrl(DEFAULT_AVATAR_SVG);

/** 头像展示与导出统一为正方形边长（CSS px） */
export const AVATAR_DISPLAY_PX = 44;

function isLikelyAvatarUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  if (t.startsWith("data:image/")) return true;
  if (/^https?:\/\//i.test(t)) return true;
  return false;
}

/** 接受用户上传的 data URL 或远端图片 URL，否则使用默认占位图 */
export function normalizeAvatarUrl(url: string | null | undefined): string {
  if (url && isLikelyAvatarUrl(url)) return url.trim();
  return DEFAULT_AVATAR;
}
