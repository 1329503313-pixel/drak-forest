const MAX_EDGE = 256;

/**
 * 将用户选取的图片缩放后转为 JPEG data URL，便于存入 localStorage。
 */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理图片");
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    const url = canvas.toDataURL("image/jpeg", 0.85);
    return url;
  } finally {
    bitmap.close();
  }
}
