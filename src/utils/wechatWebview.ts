/** 微信内置浏览器（含公众号 / 扫码 H5） */
export function isWeChatWebView(): boolean {
  if (typeof navigator === "undefined") return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}

/**
 * 为微信 WebView 做「绘制预热」与根级标记，配合 CSS 独立合成层，减轻滑动时 backdrop / 渐变文字等偶发丢样式。
 * 非真正 SSR 预渲染，而是促使内核尽早完成首屏各层合成（类似预合成）。
 */
export function initWeChatWebviewPaintPriming(): void {
  if (typeof document === "undefined") return;
  if (!isWeChatWebView()) return;

  const html = document.documentElement;
  html.classList.add("wechat-webview");

  const prime = () => {
    void html.offsetHeight;
    const body = document.body;
    if (body) void body.offsetHeight;
    const root = document.getElementById("root");
    if (root) void root.offsetHeight;
    html.classList.add("wechat-paint-primed");
  };

  if (document.readyState === "complete") {
    requestAnimationFrame(() => requestAnimationFrame(prime));
  } else {
    window.addEventListener("load", () => requestAnimationFrame(() => requestAnimationFrame(prime)), { once: true });
  }
}
