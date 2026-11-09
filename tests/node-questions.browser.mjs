import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startEditorBrowser } from "./support/editor-browser.mjs";

const setup = `
window.mountQuestions = () => {
  const doc = { nodeId: 'node-a', title: 'Attention', path: 'Nodes/A.md', text: 'Attention scaling\u005cn\u005cnSoftmax axes', hash: 'hash', revision: 1 };
  const target = { root: 'D:/library', sessionId: 'current' };
  window.plugin.rememberOpenEditor('root:' + target.root, 'node-a');
  const questions = [
    { id: 'chat', title: 'Historical chat', processed: false, source: { kind: 'chat', sessionId: 'history', messageKey: 'old', seq: 12, excerpt: 'key phrase', offset: 10 } },
    { id: 'legacy', title: 'Legacy term', processed: false, source: { kind: 'chat', sessionId: 'history', messageKey: 'old' } },
    { id: 'ambiguous', title: 'key phrase', processed: false, source: { kind: 'chat', sessionId: 'history', messageKey: 'old' } },
    { id: 'gone', title: 'Missing message', processed: false, source: { kind: 'chat', sessionId: 'history', messageKey: 'gone' } },
    { id: 'note', title: 'Note source', processed: false, source: { kind: 'note', nodeId: 'node-a', block: 0, excerpt: 'Attention scaling' } },
    { id: 'changed', title: 'Changed passage', processed: false, source: { kind: 'note', nodeId: 'node-a', block: 0, excerpt: 'not present' } },
  ];
  const base = { id: 'node-a', title: 'Attention', aliases: [] };
  const prerequisite = { id: 'node-b', title: 'Manual topic', aliases: [] };
  window.questionChecks = { requests: [], loads: [], openResources: [], scrolls: [], releases: 0 };
  const chat = document.createElement('div');
  chat.dataset.conversationContent = '';
  chat.dataset.conversationSession = 'current';
  chat.dataset.conversationRegion = 'chat';
  chat.innerHTML = '<p data-chat-node-key="current-message">Current chat excerpt</p>';
  document.body.prepend(chat);
  const session = document.createElement('div');
  session.dataset.conversationSession = 'history';
  session.dataset.conversationScroll = '';
  session.style.cssText = 'position: fixed; left: 850px; top: 60px; width: 300px; height: 230px; overflow: auto';
  document.body.append(session);
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (options) {
    window.questionChecks.scrolls.push(this.dataset.chatNodeKey ?? this.textContent);
    return originalScroll.call(this, options);
  };
  window.plugin.attachQuestionNavigation(() => ({
    sessions: { binding: () => ({ session: {} }), retain: () => ({
      binding: { session: { loadThrough: async (seq) => {
        window.questionChecks.loads.push(seq);
        const row = document.createElement('div');
        row.dataset.chatNodeKey = 'old';
        row.innerHTML = '<p>key phrase</p><div style="height: 650px"></div><p data-expected-passage>key <strong>phrase</strong></p><p>Legacy term</p><div style="height: 340px"></div>';
        session.append(row);
      } } }, release() { window.questionChecks.releases += 1; }
    }) },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => ({
      nodes: { get: () => ({ location: { turn: { start: { seq: 42 } } } }) },
    }) }) }) },
    sidebarRight: { openResource: (address, options) => window.questionChecks.openResources.push({ address, options }) },
  }));
  const fetcher = async (url, init) => {
    if (!init?.body) return { ok: true, json: async () => ({ ok: true, library: { root: target.root } }) };
    const request = JSON.parse(init.body);
    window.questionChecks.requests.push(request);
    let body = { ok: true };
    if (request.kind === 'read-node-document') body.document = doc;
    if (request.kind === 'list-node-questions' && !request.nodeId) {
      body.root = target.root;
      body.nodes = [base, prerequisite];
      body.ownerNodeId = prerequisite.id;
    } else if (request.kind === 'list-node-questions') body.questions = questions;
    if (request.kind === 'list-node-questions' && request.questionId && window.questionChecks.fileMoved) {
      body = { ok: false, error: { message: '来源文件已移动或无法访问' } };
    }
    if (request.kind === 'add-node-question') {
      const source = request.source?.kind === 'file'
        ? { kind: 'file', sessionId: 'current', path: 'report notes.txt', line: request.source.line }
        : request.source;
      questions.unshift({ id: request.questionId, title: request.title, processed: false, source });
      body.questions = questions;
    }
    if (request.kind === 'set-node-question-processed') {
      questions.find(item => item.id === request.questionId).processed = request.processed;
      body.questions = questions;
    }
    if (request.kind === 'delete-node-question') {
      questions.splice(questions.findIndex(item => item.id === request.questionId), 1);
      body.questions = questions;
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  window.fetch = fetcher;
  const bar = document.createElement('div');
  const workspace = { workspaceId: 'w1', path: 'D:/workspace', sessionIds: ['current', 'history'] };
  bar.innerHTML = '<div data-row-key="workspace:w1"><div data-row-key="session:current" aria-selected="true"></div></div><div></div>';
  document.body.append(bar);
  createRoot(bar.lastElementChild).render(React.createElement(window.plugin.ChatSelectionBar, {
    sessionId: 'current', copy: { addPrereq: '添加前置' }, useWorkspaces: () => ({ items: [workspace] }),
  }));
  const preview = document.createElement('div');
  preview.dataset.textpreviewUrl = 'preview';
  preview.innerHTML = '<div data-textpreview-line="9">Workspace source</div><div id="document-action"></div>';
  document.body.append(preview);
  createRoot(preview.lastElementChild).render(React.createElement(window.plugin.QuestionDocumentAction, {
    absolutePath: 'D:/workspace/report notes.txt', sessionId: 'current',
  }));
  function App() {
    const [promoted, setPromoted] = React.useState(false);
    const graph = { nodes: [base, prerequisite], edges: promoted ? [{ fromId: 'node-a', toId: 'node-b', relationType: 'prerequisite' }] : [] };
    return React.createElement('div', { className: 'kn-root kn-graph', style: { height: 630, position: 'relative' } },
      React.createElement(window.plugin.NodeDocumentEditor, {
        nodeId: 'node-a', libraryKey: 'library', questionsRoot: target.root, target, graph,
        fetcher, onClose: () => {}, onRelationsChanged: () => setPromoted(true),
        onOpenConversation: (id, dirty, source) => {
          window.questionChecks.cached = window.plugin.recallDraft(window.plugin.draftKey('library', 'node-a'));
          window.questionChecks.dirty = dirty;
          if (source) void window.plugin.locateChatQuestion(source, '未找到原消息', '无法打开来源', '无法唯一匹配原文');
        },
      }));
  }
  root.render(React.createElement(App));
};`;

test("question panel, source navigation, and prerequisite promotion in the built client", async () => {
  const browser = await startEditorBrowser({
    extraExports: ["QuestionDocumentAction", "ChatSelectionBar", "attachQuestionNavigation", "locateChatQuestion", "recallDraft", "draftKey", "rememberOpenEditor"],
    setup,
  });
  const { page } = browser;
  try {
    await page.addStyleTag({ content: (await readFile(new URL("../src/client/panel.css", import.meta.url), "utf8"))
      + '\n.milkdown > .milkdown-toolbar[data-show="true"] { display: flex !important; }' });
    await page.evaluate(() => window.mountQuestions());
    const editor = page.locator(".kn-editor");
    const toggle = editor.getByRole("button", { name: "学习疑问", exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    const pane = editor.getByRole("region", { name: "学习疑问" });
    const layout = () => editor.locator(".kn-editor-content").evaluate((element) => getComputedStyle(element).flexDirection);
    assert.equal(await layout(), "row");
    await page.locator("#app").evaluate((element) => { element.style.width = "520px"; });
    assert.equal(await layout(), "column");
    await pane.getByRole("button", { name: "记一条" }).click();
    await pane.getByRole("textbox", { name: "知识点名称" }).fill("Manual topic");
    await pane.getByRole("button", { name: "添加", exact: true }).click();
    const checkbox = pane.getByRole("checkbox", { name: "已处理 · Manual topic" });
    await checkbox.check();
    await page.waitForFunction(() => document.querySelector('input[aria-label="已处理 · Manual topic"]')?.checked === true);
    const actions = (title) => pane.getByRole("button", { name: "知识点操作 · " + title, exact: true });
    const locate = async (title) => {
      await actions(title).click();
      await pane.getByRole("button", { name: /^定位来源/ }).click();
    };
    await actions("Manual topic").click();
    assert.equal(await pane.getByRole("button", { name: /^定位来源/ }).isDisabled(), true);
    await pane.getByRole("button", { name: "创建为前置节点" }).click();
    await editor.getByRole("button", { name: "Manual topic", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await actions("Manual topic").click();
    assert.equal(await pane.getByRole("button", { name: "创建为前置节点" }).isDisabled(), true);
    await pane.getByRole("button", { name: "删除", exact: true }).click();
    await checkbox.waitFor({ state: "detached" });
    assert.equal(await editor.getByRole("button", { name: "前置 1", exact: true }).count(), 1);

    const prose = editor.locator(".ProseMirror");
    await prose.waitFor();
    await prose.locator("p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await editor.locator('.milkdown-toolbar[data-show="true"] button[data-toolbar-item="record-question"]').click();
    await pane.getByRole("textbox", { name: "知识点名称" }).fill("From node note");
    await pane.getByRole("button", { name: "添加", exact: true }).click();
    await actions("From node note").waitFor();
    const noteCapture = await page.evaluate(() => window.questionChecks.requests.find((request) => request.title === "From node note"));
    assert.deepEqual(noteCapture.source, { kind: "note", nodeId: "node-a", excerpt: "Attention scaling", block: 0 });
    await locate("Note source");
    await page.waitForFunction(() => window.questionChecks.scrolls.includes("Attention scaling"));
    await locate("Changed passage");
    await page.getByRole("status").filter({ hasText: "原段落" }).waitFor();
    await prose.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" keep my draft");
    await locate("Historical chat");
    await page.waitForFunction(() => {
      const range = [...(CSS.highlights.get("knowledgenet-question-source") ?? [])][0];
      if (!range) return false;
      const rect = range.getBoundingClientRect();
      const scroller = document.querySelector('[data-conversation-session="history"]');
      const center = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
      return range.toString() === "key phrase"
        && range.startContainer.parentElement.closest("[data-expected-passage]") !== null
        && Math.abs(rect.top + rect.height / 2 - center) < 2;
    });
    assert.equal(await page.locator('[data-chat-node-key="old"]').evaluate((row) => row.getAnimations().length), 0);
    const captured = await page.evaluate(() => window.questionChecks);
    assert.deepEqual(captured.loads, [12]);
    assert.equal(captured.releases, 1);
    assert.equal(captured.dirty, true);
    assert.ok(captured.cached.draft.includes("keep my draft"));
    await locate("Legacy term");
    await page.waitForFunction(() => [...(CSS.highlights.get("knowledgenet-question-source") ?? [])][0]?.toString() === "Legacy term");
    await locate("key phrase");
    await page.getByRole("status").filter({ hasText: "无法唯一匹配原文" }).waitFor();
    assert.equal(await page.evaluate(() => CSS.highlights.has("knowledgenet-question-source")), false);
    await locate("Missing message");
    await page.getByRole("status").filter({ hasText: "未找到原消息" }).waitFor();

    await page.locator('[data-chat-node-key="current-message"]').evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      const rect = range.getBoundingClientRect();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + 2 }));
    });
    await page.locator(".kn-sel-bar").getByRole("button", { name: "记为疑问" }).click();
    const chatCapture = page.getByRole("dialog", { name: "记为疑问" });
    await chatCapture.getByRole("button", { name: "添加", exact: true }).click();
    await chatCapture.waitFor({ state: "detached" });
    await actions("Current chat excerpt").waitFor();
    const chatRequest = await page.evaluate(() => window.questionChecks.requests.find((request) => request.title === "Current chat excerpt"));
    assert.deepEqual(chatRequest.source, { kind: "chat", sessionId: "current", messageKey: "current-message", seq: 42, excerpt: "Current chat excerpt", offset: 0 });

    await page.locator("[data-textpreview-line]").evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await page.locator("[data-question-document-action]").click();
    const dialog = page.getByRole("dialog", { name: "记为疑问" });
    assert.equal(await dialog.getByRole("combobox", { name: "归属节点" }).inputValue(), "node-a");
    await dialog.getByRole("button", { name: "添加", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await locate("Workspace source");
    const file = await page.evaluate(() => window.questionChecks.openResources.at(-1));
    assert.deepEqual(file, { address: "dsh-resource://file/session/current/report%20notes.txt", options: { params: { line: 9 } } });
    await page.evaluate(() => { window.questionChecks.fileMoved = true; });
    await locate("Workspace source");
    await pane.getByRole("alert").filter({ hasText: "来源文件已移动" }).waitFor();
    assert.deepEqual(browser.errors, []);
  } finally { await browser.close(); }
});
