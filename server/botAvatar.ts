/**
 * 为每个电脑玩家生成唯一、稳定的 SVG 头像（data URL），避免与人类默认头像混淆。
 */
function hash32(str: string): number {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

export function botAvatarDataUrl(botSocketId: string): string {
  const h = hash32(botSocketId);
  const hue = h % 360;
  const hue2 = (hue + 28 + ((h >>> 8) % 50)) % 360;
  const sat = 36 + (h >>> 12) % 28;
  const L = 22 + (h >>> 20) % 16;
  const L2 = Math.min(52, L + 12 + (h >>> 24) % 8);
  const c1 = `hsl(${hue},${sat}%,${L}%)`;
  const c2 = `hsl(${hue2},${Math.min(62, sat + 10)}%,${L2}%)`;
  const glow = `hsl(${(hue + 140) % 360},70%,55%)`;
  const panel = `hsl(${hue},${sat - 8}%,${Math.min(48, L + 18)}%)`;
  const rx = 14 + (h % 7);
  const eyeDx = 6 + (h >>> 4) % 5;
  const mouthW = 14 + (h >>> 6) % 10;
  const antX = 48 + ((h >>> 2) % 17) - 8;
  const antH = 10 + (h >>> 14) % 8;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${c1}"/>
      <stop offset="100%" style="stop-color:${c2}"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="1.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="96" height="96" rx="${rx}" fill="url(#bg)"/>
  <rect x="22" y="28" width="52" height="40" rx="8" fill="${panel}" opacity="0.92"/>
  <circle cx="${antX}" cy="18" r="3" fill="${glow}" filter="url(#glow)"/>
  <line x1="${antX}" y1="21" x2="48" y2="32" stroke="${glow}" stroke-width="2.5" stroke-linecap="round" opacity="0.85"/>
  <circle cx="${48 - eyeDx}" cy="${44}" r="4.5" fill="${glow}" opacity="0.9"/>
  <circle cx="${48 + eyeDx}" cy="${44}" r="4.5" fill="${glow}" opacity="0.9"/>
  <rect x="${48 - mouthW / 2}" y="54" width="${mouthW}" height="3" rx="1.5" fill="rgba(240,248,255,0.35)"/>
  <path d="M20 72 Q48 ${62 + antH} 76 72" stroke="rgba(255,255,255,0.12)" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;

  return "data:image/svg+xml," + encodeURIComponent(svg);
}
