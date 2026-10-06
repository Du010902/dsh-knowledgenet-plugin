/**
 * **代码块复制 / 粘贴语义**的测试
 * （`design/code-block-copy-paste-analysis.md` ✓）。
 *
 * 复查确认的两个事实（都来自安装依赖的源码 ✓）：
 * ① Crepe 代码块的"复制"按钮只 `navigator.clipboard.writeText(text)` ✗
 *    ⇒ 剪贴板里没有"这是一个 C++ 代码块"✓ ⇒ 粘回正文被当 **Markdown** 解析 ✓
 *    ⇒ 四空格变缩进代码块、空行分段、`<iostream>` 触发原始 HTML 警告 ✓（用户截图 ✓）；
 * ② milkdown 的剪贴板插件有纯文本就 `parser(text)` 再转切片 ✗（它并不为这段文本"猜是不是代码"✓）。
 *
 * 这里钉住我们的对策：**多格式剪贴板 + 本插件载荷** ✓，
 * 以及"载荷要校验、要限长、HTML 要转义、语言要过滤"这些安全边界 ✓。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  KN_CODE_BLOCK_MAX_CHARS,
  KN_CODE_BLOCK_MIME,
  KN_CODE_BLOCK_VERSION,
  codeBlockFromClipboardHtml,
  codeBlockHtml,
  encodeCodeBlockPayload,
  escapeHtml,
  formulaFromPlainText,
  insideCodeBlock,
  parseCodeBlockPayload,
  safeLanguage,
  unescapeHtml,
} from "../src/client/code-block-clipboard.ts";
import { EDITOR_LITERAL } from "../src/client/node-document-state.ts";
import { TABLE_LITERAL } from "../src/client/table-menu.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "src", "client");
const richSource = readFileSync(path.join(CLIENT, "MarkdownRichEditor.tsx"), "utf8");
const editorSource = readFileSync(path.join(CLIENT, "NodeDocumentEditor.tsx"), "utf8");
const dictSource = readFileSync(path.join(CLIENT, "index.ts"), "utf8");

/** 复查截图里那段 C++ ✓（含缩进、尖括号、末尾大括号 ✓） */
const CPP = [
  "#include<iostream>",
  "using namespace std;",
  "",
  "int main() {",
  "    cout << \"hello\" << endl;",
  "    return 0;",
  "}",
].join("\n");

describe("代码块载荷：编码 / 解析 / 边界 ✓", () => {
  it("往返一致 ✓（缩进、空行、尖括号、末尾大括号都一字不改 ✓）", () => {
    const raw = encodeCodeBlockPayload({ language: "cpp", code: CPP });
    const back = parseCodeBlockPayload(raw);
    assert.notEqual(back, null);
    assert.equal(back.language, "cpp", "语言要活着回来 ✓（否则新块会显示 Text ✗）");
    assert.equal(back.code, CPP, "代码必须逐字一致 ✓");
    assert.ok(raw.includes(`"v":${KN_CODE_BLOCK_VERSION}`), "载荷里要带版本号 ✓");
  });

  it("**不是本插件载荷就返回 null** ✓（放行给原有 Markdown 粘贴 ✓）", () => {
    assert.equal(parseCodeBlockPayload(""), null);
    assert.equal(parseCodeBlockPayload("# 标题\n正文"), null, "普通 Markdown 不许被当成代码 ✓");
    assert.equal(parseCodeBlockPayload("{ 不是 json"), null);
    assert.equal(parseCodeBlockPayload(JSON.stringify({ v: 1, kind: "别的", code: "x" })), null, "kind 不对 ⇒ 不认 ✓");
    assert.equal(parseCodeBlockPayload(JSON.stringify({ v: 99, kind: "kn-code-block", code: "x" })), null, "版本不认识 ⇒ 不认 ✓");
    assert.equal(parseCodeBlockPayload(JSON.stringify({ v: 1, kind: "kn-code-block" })), null, "没有代码 ⇒ 不认 ✓");
    assert.equal(parseCodeBlockPayload(null), null);
    assert.equal(parseCodeBlockPayload(undefined), null);
  });

  it("**限长** ✓：超大载荷不许进文档（裁剪 ✗、拒绝 ✓）", () => {
    const huge = "x".repeat(KN_CODE_BLOCK_MAX_CHARS + 1);
    assert.equal(parseCodeBlockPayload(JSON.stringify({ v: 1, kind: "kn-code-block", code: huge })), null);
    assert.equal(parseCodeBlockPayload("y".repeat(KN_CODE_BLOCK_MAX_CHARS + 1)), null);
  });

  it("**语言必须过滤** ✓（载荷会进 HTML 的 class ✗，不校验就是注入点 ✓）", () => {
    assert.equal(safeLanguage("cpp"), "cpp");
    assert.equal(safeLanguage("C++"), "C++");
    assert.equal(safeLanguage("  python  "), "python");
    assert.equal(safeLanguage('"><script>alert(1)</script>'), "", "带引号/尖括号 ⇒ 丢掉语言 ✓");
    assert.equal(safeLanguage("c\nd"), "", "带换行 ⇒ 丢掉 ✓");
    assert.equal(safeLanguage("x".repeat(64)), "", "过长 ⇒ 丢掉 ✓");
    assert.equal(safeLanguage(undefined), "");
    assert.equal(safeLanguage(123), "");
    /* 载荷里的坏语言也要被洗掉 ✓ */
    assert.equal(parseCodeBlockPayload(JSON.stringify({ v: 1, kind: "kn-code-block", language: "<b>", code: "x" }))?.language, "");
  });

  it("`text/html` 那份必须**转义** ✓（尖括号不许变成标签 ✗）", () => {
    const html = codeBlockHtml({ language: "cpp", code: CPP });
    assert.ok(html.startsWith("<pre><code"), "结构是 pre/code ✓");
    assert.ok(html.includes('class="language-cpp"'), "带上语言 ✓");
    assert.ok(html.includes("&lt;iostream&gt;"), "`<iostream>` 必须转义 ✓");
    assert.ok(!html.includes("<iostream>"), "绝不能出现未转义的尖括号 ✗");
    assert.ok(html.endsWith("</code></pre>"), "要闭合 ✓");
    /* 语言里的危险字符同样要挡住 ✓ */
    const bad = codeBlockHtml({ language: '"><img src=x>', code: "x" });
    assert.ok(!bad.includes("<img"), "语言里的标签也必须被挡 ✗");
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  });

  it("`insideCodeBlock`：只有 code_block 才拦住粘贴 ✓（不嵌套新块 ✓）", () => {
    assert.equal(insideCodeBlock("code_block"), true);
    assert.equal(insideCodeBlock("paragraph"), false);
    assert.equal(insideCodeBlock("table_cell"), false);
    assert.equal(insideCodeBlock(undefined), false);
  });

  it("**HTML 降级** ✓：整段就是一个 `<pre><code>` 时也能还原出语言与原文", () => {
    const html = codeBlockHtml({ language: "cpp", code: CPP });
    const back = codeBlockFromClipboardHtml(html);
    assert.notEqual(back, null);
    assert.equal(back.language, "cpp", "语言要从 class 里认出来 ✓");
    assert.equal(back.code, CPP, "实体要反转义回原文 ✓（`&lt;iostream&gt;` → `<iostream>` ✓）");
    /* Chrome 那种外层包装也要认 ✓ */
    const wrapped = `<meta charset='utf-8'>${html}`;
    assert.equal(codeBlockFromClipboardHtml(wrapped)?.code, CPP, "允许外层 meta 包装 ✓");
    /* 别的富 HTML 一律不认 ✗（继续走 milkdown 原有粘贴 ✓） */
    assert.equal(codeBlockFromClipboardHtml("<p>普通段落</p>"), null);
    assert.equal(codeBlockFromClipboardHtml(`${html}<p>后面还有内容</p>`), null, "前后还有别的内容 ⇒ 不认 ✗");
    assert.equal(codeBlockFromClipboardHtml("<pre><code><span>高亮</span></code></pre>"), null, "里面还有标签 ⇒ 不认 ✗");
    assert.equal(codeBlockFromClipboardHtml(""), null);
    assert.equal(codeBlockFromClipboardHtml(undefined), null);
    assert.equal(unescapeHtml("&amp;&lt;&gt;&quot;&#39;"), "&<>\"'");
  });

  it("**纯文本 `$$…$$` 就是公式块** ✓（用户实测：复制公式块再粘贴变成 Text ✗）", () => {
    /*
     * 复制公式块时我们写了三种格式 ✓，但自定义格式/记忆判断都可能失效 ✓
     * （剪贴板常把 `\n` 换成 `\r\n` ⇒ 严格相等匹配不上 ✓）
     * ⇒ 这条兜底只看文本本身：**整段就是一块 `$$…$$`** ⇒ 就是公式块 ✓，语言写 `LaTeX` ✓。
     */
    const parsed = formulaFromPlainText("$$\n\\frac{h_t}{x_t} = z^x\n$$");
    assert.deepEqual(parsed, { language: "LaTeX", code: "\\frac{h_t}{x_t} = z^x" }, "标准写法 ✓");
    /* CRLF / 前后空白 / 单行写法都要认 ✓ */
    assert.equal(
      formulaFromPlainText("  $$\r\n\\frac{a}{b}\r\n$$\r\n")?.code,
      "\\frac{a}{b}",
      "CRLF 与前后空白要归一化 ✓（这正是之前失效的那种 ✓）",
    );
    assert.equal(formulaFromPlainText("$$x^2$$")?.language, "LaTeX", "单行 `$$x^2$$` 也认 ✓");
    /* 不是"整块公式"就放行 ✓（交给原有粘贴 ✓） */
    assert.equal(formulaFromPlainText("普通文本"), null);
    assert.equal(formulaFromPlainText("$$只有开头"), null);
    assert.equal(formulaFromPlainText("$$\n\n$$"), null, "空的公式不算 ✓");
    assert.equal(formulaFromPlainText("前 $$x$$ 后"), null, "夹在文本里不算整块 ✓");
    assert.equal(formulaFromPlainText(""), null);
    assert.equal(formulaFromPlainText(undefined), null);
  });

  it("**复制成功要给对勾反馈** ✓（用户要求：点完变对勾、再变回来）", () => {
    assert.ok(richSource.includes("function flashCopied(button: HTMLElement): void"), "要有这个反馈 ✓");
    const at = richSource.indexOf("function flashCopied");
    const block = richSource.slice(at, at + 700);
    assert.ok(block.includes("const original = button.innerHTML;"), "要记住原来的内容 ✓（图标 + 「复制」✓）");
    assert.ok(block.includes("button.innerHTML = COPIED_CHECK;"), "换成对勾 ✓");
    /*
     * **对勾必须是纯线条** ✓（用户实测：上一版被 CSS 的 `fill` 盖成实心一坨 ✗）。
     * ⇒ 关键样式写成**内联** ✓（属性会被 CSS 盖掉 ✗），线宽收细 ✓。
     */
    assert.ok(
      /style="fill:none;stroke:currentColor;stroke-width:1\.6/.test(richSource),
      "对勾的填充/线宽要用内联样式写 ✓（写成属性会被 Crepe 的图标 CSS 盖成实心 ✗）",
    );
    assert.ok(
      !/stroke-width="2\.4"/.test(richSource),
      "不许再用偏粗的线宽 ✗",
    );
    assert.ok(/window\.setTimeout\(\(\) => \{[\s\S]{0,200}?button\.innerHTML = original;/.test(block), "**要变回来** ✓");
    assert.ok(block.includes('button.dataset.knCopied === "true"'), "连点不叠加计时器 ✓");
    assert.ok(
      /\.then\(\(\) => \{[\s\S]{0,300}?flashCopied\(button\);/.test(richSource),
      "只在**写成功之后**给对勾 ✓（失败不许假装已复制 ✗）",
    );
  });
  it("**回落字典必须齐全** ✗：截图里提示条显示成字面键名 `unsupportedNoticeRich` ✓", () => {
    /*
     * 两个组件用的是**两份**回落字典 ✓（别再混着扫 ✗）：
     * - `NodeDocumentEditor` ⇒ `makeTranslator(props.t, EDITOR_LITERAL)` ✓；
     * - `MarkdownRichEditor` ⇒ `makeTranslator(props.t, TABLE_LITERAL)` ✓。
     * 宿主 locale 缺席（或键没注册上）时就落回字典 ✓，找不到**直接回键名** ✗。
     */
    const keysOf = (source) => {
      const used = new Set();
      for (const call of source.matchAll(/\bt\(([^)]*)\)/g)) {
        for (const literal of (call[1] ?? "").matchAll(/"([A-Za-z0-9_]+)"/g)) used.add(literal[1]);
      }
      return used;
    };
    /* `t(tab === "source" ? …)` 里的 `source` / `rich` 是**模式名** ✗，不是词典键 ✓ */
    const modeNames = new Set(["source", "rich"]);
    const editorUsed = keysOf(editorSource);
    assert.ok(editorUsed.size > 10, `编辑器要能扫到一批键（实际 ${editorUsed.size} 个 ✓）`);
    const editorMissing = [...editorUsed].filter((key) => !modeNames.has(key) && !(key in EDITOR_LITERAL));
    assert.deepEqual(editorMissing, [], `NodeDocumentEditor 缺回落文案 ✗：${editorMissing.join(", ")}`);
    const richUsed = keysOf(richSource);
    const richMissing = [...richUsed].filter((key) => !modeNames.has(key) && !(key in TABLE_LITERAL));
    assert.deepEqual(richMissing, [], `MarkdownRichEditor 缺回落文案 ✗：${richMissing.join(", ")}`);
    assert.ok("unsupportedNoticeRich" in EDITOR_LITERAL, "正文模式那句必须在这份字典里 ✓");
    assert.ok(
      "tableMenuLabel" in EDITOR_LITERAL && "tableEntryDisabled" in EDITOR_LITERAL,
      "表格入口那两条也走这个 t ✓ ⇒ 同样要有回落 ✓",
    );
    assert.ok(
      "editorEditSource" in TABLE_LITERAL && "editorResultOnly" in TABLE_LITERAL,
      "公式 / 代码块的预览开关也走这个 t ✓ ⇒ 同样要有回落 ✓",
    );
  });
});

describe("代码块复制 / 粘贴的接线 ✓", () => {
  it("复制按钮：**捕获阶段**接住、写多格式、读的是**节点原文** ✓", () => {
    assert.ok(richSource.includes('target.closest<HTMLElement>(".copy-button")'), "要认 Crepe 的复制按钮 ✓");
    assert.ok(richSource.includes('button.closest<HTMLElement>(".milkdown-code-block")'), "要定位到代码块 ✓");
    assert.ok(richSource.includes("codeBlockAt(view, host)"), "原文以 **ProseMirror 节点**为准 ✓");
    assert.ok(richSource.includes("event.stopPropagation();"), "要拦下 Crepe 自己的纯文本写入 ✓");
    assert.ok(richSource.includes('root.addEventListener("click", onCopyClick, true)'), "必须用**捕获**阶段 ✓");
    assert.ok(richSource.includes("codeBlockHtml(payload)"), "HTML 那份要转义生成 ✓");
    assert.ok(richSource.includes("encodeCodeBlockPayload(payload)"), "要有本插件载荷 ✓");
    assert.ok(richSource.includes("writeText?.(plain)"), "最后要能退回**纯文本** ✓（终端体验不变 ✓）");
    assert.ok(!richSource.includes('"vscode-editor-data"'), "不许伪造别人的剪贴板格式 ✗（注释里提名字不算 ✓）");
  });

  it("自定义格式必须带 `web ` 前缀 ✓（否则 Chrome 直接拒绝 ✓）", () => {
    assert.ok(KN_CODE_BLOCK_MIME.startsWith("web "), `实际值：${KN_CODE_BLOCK_MIME}`);
    assert.ok(richSource.includes("[KN_CODE_BLOCK_MIME]"), "写入时要用这个 MIME ✓");
  });

  it("粘贴：认得本插件载荷就插**完整代码块** ✓，其它一律放行 ✗", () => {
    assert.ok(richSource.includes("parseCodeBlockPayload(clip.getData(KN_CODE_BLOCK_MIME))"), "只认本插件载荷 ✓");
    assert.ok(richSource.includes("if (insideCodeBlock(currentBlockName(view))) return;"), "在代码块里 ⇒ 只插字符 ✓（不嵌套 ✓）");
    assert.ok(richSource.includes("insertCodeBlockNode(view, payload)"), "要用事务插入完整 code_block ✓");
    assert.ok(
      richSource.includes("const node = type.create(payload.language === \"\" ? null : { language: payload.language }, text);"),
      "语言要一起写进节点 ✓（否则新块显示 Text ✗）",
    );
    assert.ok(richSource.includes("replaceSelectionWith(node)"), "要可撤销 ✓（走事务 ✓）");
    assert.ok(richSource.includes('root.addEventListener("paste", onPastePayload, true)'), "粘贴监听要挂上 ✓");
    assert.ok(richSource.includes('root.removeEventListener("click", onCopyClick, true)'), "卸载要摘掉 ✓");
    assert.ok(richSource.includes('root.removeEventListener("paste", onPastePayload, true)'), "卸载要摘掉 ✓");
  });

  it("**粘贴被拆散后的一键补救** ✓：提示条上能把「刚才粘进来的内容」作为代码块插入", () => {
    /* 复查「更小的第一步」：不猜任意文本是不是代码 ✓，只对"确实粘过的那段"给一次补救 ✓ */
    assert.ok(editorSource.includes("const [lastPaste, setLastPaste] = useState(\"\");"), "要记住最近一次粘贴的纯文本 ✓");
    assert.ok(editorSource.includes("onPasteText={(text) => { setLastPaste(text); }}"), "粘贴时要把它交给父组件 ✓");
    assert.ok(editorSource.includes("richRef.current?.insertCodeBlock(lastPaste)"), "一键插入走**事务** ✓（可撤销 ✓）");
    assert.ok(editorSource.includes('t("pasteAsCodeBlock")'), "按钮文案要走词典 ✓");
    assert.ok(richSource.includes("onPasteText?.(plain)"), "捕获粘贴时把纯文本报上去 ✓（**不拦**这次粘贴 ✓）");
    assert.ok(richSource.includes("insertCodeBlock: (code: string, language = \"\")"), "句柄要暴露插入方法 ✓");
    assert.ok(richSource.includes("insertCodeBlockNode(view, { language, code })"), "复用同一条插入路径 ✓");
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    assert.ok(zh.includes("pasteAsCodeBlock:") && en.includes("pasteAsCodeBlock:"), "中英词典都要有 ✓");
  });

  it("**HTML 降级**也要接进粘贴路径 ✓（自定义格式被浏览器拒时靠它）", () => {
    assert.ok(
      richSource.includes('?? codeBlockFromClipboardHtml(clip.getData("text/html"))'),
      "载荷不在时要看 text/html ✓",
    );
    assert.ok(richSource.includes("viaHtml:"), "上报里要能区分是走 HTML 还原的 ✓");
  });

  it("**提示与实际模式一致** ✓：还在正文时不许宣称已改用纯文本 ✗", () => {
    assert.ok(
      richSource.includes("insideCodeBlock") && dictSource.includes("unsupportedNoticeRich"),
      "两种模式各一句文案 ✓",
    );
    const zh = dictSource.slice(dictSource.indexOf("const DICT_ZH"), dictSource.indexOf("const DICT_EN"));
    const en = dictSource.slice(dictSource.indexOf("const DICT_EN"));
    for (const key of ["unsupportedNotice", "unsupportedNoticeRich"]) {
      assert.ok(zh.includes(`${key}:`), `中文词典要有 ${key} ✓`);
      assert.ok(en.includes(`${key}:`), `英文词典要有 ${key} ✓`);
    }
    assert.ok(!zh.includes("unsupportedNoticeRich") || !/unsupportedNoticeRich: "[^"]*已自动改用纯文本/.test(zh), "正文模式那句不许说已切换 ✗");
  });
});
