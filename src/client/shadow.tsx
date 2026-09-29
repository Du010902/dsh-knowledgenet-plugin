/**
 * Shadow DOM 面板容器。
 *
 * 为什么用 Shadow DOM：上游画布样式（src/styles/graph.css，约 600 行）是**全局类名 +
 * 依赖导入顺序**的写法，直接注进宿主页面会双向污染（`.is-todo` 这类通用类名尤其危险）。
 * Shadow DOM 让这份 CSS 原样可用：边界内自成一域，同时 CSS 自定义属性会继承进来，
 * 所以 `--dsw-alias-*` 主题 token 依旧生效（亮/暗切换跟随宿主）。
 *
 * 纪律：不 append 到 document.body、不读别的插件 DOM；所有节点都在本组件的 shadow 内。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 由 build.mjs 的虚拟模块注入：panel.css + 上游 graph.css 的拼接结果
import { KN_PANEL_CSS } from "kn-panel-css";

export interface ShadowPanelProps {
  children: ReactNode;
  /** 面板高度：数字 = 固定 px；null = 按内容自适应（紧凑卡片）；"fill" = 撑满父容器（常驻面板） */
  height?: number | null | "fill";
}

export function ShadowPanel({ children, height = 460 }: ShadowPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const auto = height === null;
  const fill = height === "fill";

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.textContent = "";
    const style = document.createElement("style");
    style.textContent = KN_PANEL_CSS;
    const root = document.createElement("div");
    root.className = auto ? "kn-root kn-root-auto" : fill ? "kn-root kn-root-fill" : "kn-root";
    shadow.append(style, root);
    setMount(root);
    /*
     * 几何上报：面板根/头行的位置、高度与上下边框宽度。
     * 用途：回答"那条横线到底是我画的还是宿主的"——对齐问题靠猜已经绕了两轮。
     *
     * 只报**扁平标量**：宿主入库时会丢掉嵌套对象（只收 string/number/boolean/数组），
     * 之前报 {host:{…}, root:{…}} 全被过滤成空条目。
     */
    const measure = (): void => {
      try {
        const first = root.firstElementChild as HTMLElement | null;
        const at = (el: Element | null) => {
          if (el === null) return { top: -1, h: -1, left: -1, bt: -1, bb: -1 };
          const rect = el.getBoundingClientRect();
          const computed = getComputedStyle(el);
          return {
            top: Math.round(rect.top),
            h: Math.round(rect.height),
            left: Math.round(rect.left),
            bt: Math.round(Number.parseFloat(computed.borderTopWidth) || 0),
            bb: Math.round(Number.parseFloat(computed.borderBottomWidth) || 0),
          };
        };
        const hostBox = at(host);
        const rootBox = at(root);
        const headBox = at(first);
        /*
         * 再往上量一层：宿主给我这块容器的**父节点**。它的 top 与我的 hostTop 之差
         * 就是"宿主自己的头部带有多高"，它的 border-bottom 就是宿主那条横线——
         * 我之前只报自己这层，永远看不到宿主的线在哪。
         */
        const parent = host.parentElement;
        const parentBox = at(parent);
        const parentStyle = parent === null ? null : getComputedStyle(parent);
        window.dispatchEvent(new CustomEvent("knowledgenet:geometry", {
          detail: {
            hostTop: hostBox.top, hostH: hostBox.h, hostLeft: hostBox.left,
            rootTop: rootBox.top, rootH: rootBox.h, rootLeft: rootBox.left,
            rootBt: rootBox.bt, rootBb: rootBox.bb,
            headTop: headBox.top, headH: headBox.h, headLeft: headBox.left,
            headBt: headBox.bt, headBb: headBox.bb,
            headCls: (first?.getAttribute("class") ?? "").slice(0, 40),
            parentTop: parentBox.top, parentH: parentBox.h, parentBt: parentBox.bt, parentBb: parentBox.bb,
            parentPadTop: parentStyle === null ? -1 : Math.round(Number.parseFloat(parentStyle.paddingTop) || 0),
            parentCls: (parent?.getAttribute("class") ?? "").slice(0, 60),
            bandH: parentBox.top < 0 ? -1 : hostBox.top - parentBox.top,
            /*
             * 宿主 chrome 的几何（同一坐标系！）：遍历 body 的直接子元素，报出各自的
             * top/height/底边框宽度 —— 那条"贯通整窗的线"就在其中某一个的底边框上。
             * 之前靠截图换算 device↔CSS 一直量错，就是因为坐标系不同。
             */
            /*
             * 全页水平分隔线扫描：找出所有"底边框 > 0 且够宽"的元素。
             * 用途：量出宿主其它标签页（如「文件」页）那条线的 y，与我的头行线同坐标系对比。
             * 只读几何与边框宽度，不读任何文本。
             */
            dividers: (() => {
              try {
                const found: string[] = [];
                const walk = (el: Element, depth: number): void => {
                  if (depth > 6 || found.length > 24) return;
                  const computed = getComputedStyle(el);
                  const b = Number.parseFloat(computed.borderBottomWidth) || 0;
                  if (b > 0) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 200) {
                      found.push(
                        `${el.tagName.toLowerCase()}.${String(el.className ?? "").slice(0, 14)}|t${Math.round(rect.top)}|h${Math.round(rect.height)}|w${Math.round(rect.width)}|bb${b}`,
                      );
                    }
                  }
                  for (const child of Array.from(el.children)) walk(child, depth + 1);
                };
                walk(document.body, 0);
                return found.join(" ; ");
              } catch {
                return "err";
              }
            })(),            chrome: (() => {
              try {
                return Array.from(document.body.children).slice(0, 8).map((el) => {
                  const rect = el.getBoundingClientRect();
                  const computed = getComputedStyle(el);
                  const cls = String(el.className ?? "").slice(0, 16);
                  return `${el.tagName.toLowerCase()}.${cls}|t${Math.round(rect.top)}|h${Math.round(rect.height)}|bb${computed.borderBottomWidth}`;
                }).join(" ; ");
              } catch {
                return "err";
              }
            })(),            viewport: `${window.innerWidth}x${window.innerHeight}`,
          },
        }));
      } catch {
        // 诊断失败不影响渲染
      }
    };
    measure();
    // 一次性即可：周期上报会把宿主的 8 条诊断环形缓冲刷满、挤掉别处的关键上报（实测）
    const timer = setTimeout(measure, 900);
    return () => {
      clearTimeout(timer);
      setMount(null);
      shadow.textContent = "";
    };
  }, [auto, fill]);

  // fill：右侧栏标签页的容器高度由 dockkit 给；再兜一个 minHeight，
  // 万一宿主给的是 auto 高度的盒子，图谱也不会塌成 0。
  const style = auto
    ? undefined
    : fill
      ? { height: "100%", minHeight: "320px" }
      : { height: `${height}px` };

  return (
    <div ref={hostRef} style={style}>
      {mount === null ? null : createPortal(children, mount)}
    </div>
  );
}
