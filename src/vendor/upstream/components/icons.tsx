/**
 * 图标
 *
 * 统一一套 24×24 线性图标（currentColor 描边），代替原先散落在各处的符号字符
 * （＋ / ✕ / ⚙ / ⌂）。符号字符在不同平台的字形宽度、基线与字重都不一样，
 * 拼在按钮里会让同一排控件看起来参差不齐；描边图标随字号缩放，颜色也直接
 * 跟随文字颜色，因此浅色 / 深色主题下都不用额外调。
 */
import type { SVGProps } from "react";

/** 24×24 视野内的路径数据。名称即语义，不再按「长得像什么」命名。 */
const PATHS = {
  network:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.5 6.2l7 .6M7 8.5l2.2 7M16.5 9l-5 6.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  /**
   * 过程/步骤：一条竖线串起三个节点。
   *
   * 单独画一个而不是借用 sparkles：sparkles 已经表示「这是 AI 的回答」（助手头像），
   * 再用它当「过程」标题和每一段思考的标记，三个同样的图形堆在一列里，
   * 谁也说不清哪个是身份、哪个是步骤。
   */
  steps:
    '<path d="M6 5v14"/><circle cx="6" cy="8" r="1.6"/><circle cx="6" cy="13" r="1.6"/><circle cx="6" cy="18" r="1.6"/><path d="M11 8h8M11 13h6M11 18h9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  moon: '<path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5a8.5 8.5 0 1 0 10.6 10.6Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-15-7 1.5 1.5m11 11 1.5 1.5m-15 0 1.5-1.5m11-11 1.5-1.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v11h14V9M9 20v-7h6v7"/>',
  focus:
    '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  orbit:
    '<circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-25 12 12)"/><path d="M9 3c-4 4-2 15 5 18"/>',
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z"/><path d="M7 10h9M7 14h6"/>',
  note: '<path d="M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8M8 16h6"/>',
  settings:
    '<path d="m10 3-1 3-3 1-3 3 2 2-1 3 2 3 3-1 2 4h3l1-3 3-1 3-3-2-2 1-3-2-3-3 1-2-4h-3Z"/><circle cx="12" cy="12" r="3"/>',
  sliders:
    '<path d="M5 3v5m0 4v9M12 3v10m0 4v4M19 3v3m0 4v11"/><circle cx="5" cy="10" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="8" r="2"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  "arrow-right": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  "arrow-up": '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  /*
   * 脉络：一条主干 + 一条支脉（学习依赖的样子）。
   *
   * 边栏「脉络」页签原来借用的 `panel` 正是分屏按钮的形状（一个被竖线分开的方框），
   * 两个图标摆在同一屏里会被当成「分屏」。这个图标专门表达「主线上挂着的分支」。
   */
  context:
    '<path d="M6 4v16M6 10h5a3 3 0 0 1 3 3v3"/><circle cx="6" cy="4" r="2"/><circle cx="14" cy="16" r="2"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  sparkles:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  merge: '<path d="M6 21v-5c0-3 6-3 6-7V3m6 18v-5c0-3-6-3-6-7m-4-2 4-4 4 4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
  shield: '<path d="m12 3 8 3v6c0 6-8 10-8 10S4 18 4 12V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload: '<path d="M12 15V3m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  folder: '<path d="M3 6h6l2 3h10v11H3V6Z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  file: '<path d="M6 3h8l5 5v13H6V3Zm8 0v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.6-5.6L11 8"/><path d="M14 10a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.6 17L13 15.6"/>',
  undo: '<path d="M4 9h11a5 5 0 0 1 0 10H9M4 9l5-5M4 9l5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  paperclip:
    '<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size,
  className,
  ...rest
}: { name: IconName; size?: number; className?: string } & Omit<
  SVGProps<SVGSVGElement>,
  "name" | "children"
>) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? PATHS.note }}
      {...rest}
    />
  );
}
