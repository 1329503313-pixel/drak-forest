import type { GameReplayEntryView } from "@/types/game";

type ExportReplayImageOptions = {
  title?: string;
  subtitle?: string;
  entries: GameReplayEntryView[];
  filename?: string;
};

const WIDTH = 900;
const PADDING = 40;
const CARD_GAP = 18;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of text) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      out.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

function replayLine(e: GameReplayEntryView): string {
  return `#${e.seq + 1}  第 ${e.roundNumber} 轮 · ${e.actorNickname}`;
}

function vitalsLine(e: GameReplayEntryView): string {
  return Object.values(e.vitals ?? {})
    .map((v) => `${v.nickname} 生命${v.hp} 体力${v.stamina}`)
    .join("   ");
}

export async function exportReplayImage({
  title = "复盘记录",
  subtitle,
  entries,
  filename = "replay-record.png",
}: ExportReplayImageOptions): Promise<void> {
  if (entries.length === 0) throw new Error("暂无复盘记录可保存");

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("当前浏览器不支持导出图片");

  const contentWidth = WIDTH - PADDING * 2;
  measure.font = "26px Microsoft YaHei, sans-serif";
  const blocks = entries.map((entry) => {
    measure.font = "26px Microsoft YaHei, sans-serif";
    const summary = wrapText(measure, entry.summary, contentWidth - 28);
    measure.font = "22px Microsoft YaHei, sans-serif";
    const damage = entry.damage ? wrapText(measure, entry.damage, contentWidth - 28) : [];
    const vitals = wrapText(measure, vitalsLine(entry), contentWidth - 28);
    const height = 28 + summary.length * 34 + damage.length * 30 + vitals.length * 28 + 36;
    return { entry, summary, damage, vitals, height };
  });

  const headerHeight = subtitle ? 124 : 92;
  const height = headerHeight + blocks.reduce((sum, b) => sum + b.height + CARD_GAP, 0) + PADDING;
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = WIDTH * scale;
  canvas.height = height * scale;
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持导出图片");
  ctx.scale(scale, scale);

  ctx.fillStyle = "#0a1018";
  ctx.fillRect(0, 0, WIDTH, height);
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#12253a");
  bg.addColorStop(0.45, "#0b1521");
  bg.addColorStop(1, "#070b12");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WIDTH, height);

  let y = PADDING;
  ctx.fillStyle = "#f6fbff";
  ctx.font = "700 38px Microsoft YaHei, sans-serif";
  ctx.fillText(title, PADDING, y + 38);
  y += 58;
  if (subtitle) {
    ctx.fillStyle = "rgba(205, 222, 238, 0.84)";
    ctx.font = "22px Microsoft YaHei, sans-serif";
    ctx.fillText(subtitle, PADDING, y + 24);
    y += 42;
  }

  for (const block of blocks) {
    const cardY = y;
    ctx.fillStyle = "rgba(12, 22, 34, 0.86)";
    ctx.strokeStyle = "rgba(92, 142, 190, 0.38)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(PADDING, cardY, contentWidth, block.height, 14);
    ctx.fill();
    ctx.stroke();

    y += 28;
    ctx.fillStyle = "#7fd4ff";
    ctx.font = "700 22px Microsoft YaHei, sans-serif";
    ctx.fillText(replayLine(block.entry), PADDING + 18, y);
    y += 30;

    ctx.fillStyle = "#f1f7ff";
    ctx.font = "26px Microsoft YaHei, sans-serif";
    for (const line of block.summary) {
      ctx.fillText(line, PADDING + 18, y);
      y += 34;
    }

    if (block.damage.length > 0) {
      ctx.fillStyle = "#ff8d8d";
      ctx.font = "22px Microsoft YaHei, sans-serif";
      for (const line of block.damage) {
        ctx.fillText(line, PADDING + 18, y);
        y += 30;
      }
    }

    ctx.fillStyle = "rgba(208, 224, 239, 0.82)";
    ctx.font = "20px Microsoft YaHei, sans-serif";
    for (const line of block.vitals) {
      ctx.fillText(line, PADDING + 18, y);
      y += 28;
    }
    y = cardY + block.height + CARD_GAP;
  }

  await new Promise<void>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("生成图片失败"));
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      resolve();
    }, "image/png");
  });
}
