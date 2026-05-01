import type { CSSProperties, ImgHTMLAttributes } from "react";

type Props = {
  src: string;
  /** 铺满父级（如房间席位）；默认按宽高固定尺寸 */
  variant?: "fixed" | "fill";
  frameClassName?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;

/**
 * 玩家头像统一外层：圆角矩形描边。
 */
export function PlayerAvatarFrame({
  src,
  alt = "",
  variant = "fixed",
  frameClassName = "",
  className = "",
  width,
  height,
  style,
  ...imgProps
}: Props) {
  const wrapStyle: CSSProperties | undefined =
    variant === "fixed" && width != null && height != null
      ? { width, height, ...style }
      : style;

  return (
    <span
      className={
        `player-avatar-frame${variant === "fill" ? " player-avatar-frame--fill" : ""}${frameClassName ? ` ${frameClassName}` : ""}`.trim()
      }
      style={wrapStyle}
    >
      <img src={src} alt={alt} className={className} width={variant === "fixed" ? width : undefined} height={variant === "fixed" ? height : undefined} {...imgProps} />
    </span>
  );
}
