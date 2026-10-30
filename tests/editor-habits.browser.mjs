import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEditorBrowser } from './support/editor-browser.mjs';

test('Markdown writing habits: real keyboard, paste ownership, read-only and undo', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  const caretEnd = async locator => { await locator.click(); await page.keyboard.press('End'); };
  try {
    await h.mount('- first');
    await caretEnd(page.locator('.ProseMirror li p').first());
    await page.keyboard.press('Enter'); await page.keyboard.type('second');
    assert.equal(await page.locator('.ProseMirror li').count(), 2, 'Enter continues a list');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.type('outside');
    assert.equal(await page.locator('.ProseMirror li').count(), 2, 'Enter on empty list item exits the list');
    assert.match(await h.flush(), /\n\noutside/);

    await h.mount('- first\n- second');
    await caretEnd(page.locator('.ProseMirror li p').last());
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.ProseMirror li ul').count(), 1, 'Tab indents a list item');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.ProseMirror li ul').count(), 0, 'Shift+Tab outdents a list item');

    await h.mount('# heading'); await caretEnd(page.locator('.ProseMirror h1'));
    await page.keyboard.press('Enter'); await page.keyboard.type('body');
    assert.equal(await page.locator('.ProseMirror h1').innerText(), 'heading');
    assert.equal(await page.locator('.ProseMirror > p').first().innerText(), 'body', 'Enter at a heading end starts normal text');

    await h.mount('paragraph');
    await caretEnd(page.locator('.ProseMirror p').first());
    await page.keyboard.press('Shift+Enter'); await page.keyboard.type('next');
    assert.equal(await page.locator('.ProseMirror > p').count(), 1, 'Shift+Enter stays in the paragraph');
    assert.equal(await page.locator('.ProseMirror br').count(), 1);

    await h.mount('start'); await caretEnd(page.locator('.ProseMirror p').first());
    await h.paste('const a = 1;\nconst b = 2;\nreturn a + b;', { plainShortcut: true });
    assert.equal(await page.locator('.milkdown-code-block').count(), 0, 'Ctrl+Shift+V bypasses code detection');
    assert.match(await h.flush(), /const a = 1/);
    await page.keyboard.press('Control+z');
    assert.equal((await h.flush()).trim(), 'start', 'One undo removes the pasted text');
    await page.keyboard.press('Control+Shift+z');
    assert.match(await h.flush(), /const a = 1/);

    await h.mount('start'); await caretEnd(page.locator('.ProseMirror p').first());
    await h.paste('**literal**', { html: '<strong>literal</strong>', plainShortcut: true });
    assert.equal(await page.locator('.ProseMirror strong').count(), 0, 'Plain paste ignores HTML and Markdown formatting');
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('**literal**'));

    await h.mount('**bold**'); await caretEnd(page.locator('.ProseMirror strong'));
    await page.keyboard.press('ArrowLeft');
    await h.paste('literal\n', { plainShortcut: true });
    assert.ok((await page.locator('.ProseMirror strong').allTextContents()).join('').includes('literal'), 'Plain text adopts the current inline formatting');

    await h.mount('start'); await caretEnd(page.locator('.ProseMirror p').first());
    await page.locator('.ProseMirror').evaluate(el => {
      const input = document.createElement('input'); input.id = 'aux-input';
      el.parentElement.append(input); input.focus();
    });
    const intercepted = await h.paste('const a=1;\nconst b=2;\nreturn a+b;', { target: '#aux-input' });
    assert.equal(intercepted, false, 'Auxiliary input owns its clipboard');
    assert.equal((await h.flush()).trim(), 'start');

    await h.mount('locked', true);
    const locked = await h.flush();
    assert.equal(await h.paste('const a=1;\nconst b=2;\nreturn a+b;'), false);
    assert.equal(await h.flush(), locked, 'Read-only document ignores structured paste');

    await h.mount('```js\nconst a = 1;\n```');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter'); await page.keyboard.type('const b = 2;');
    assert.match(await h.flush(), /const a = 1;\nconst b = 2;/, 'Enter inside code preserves a literal newline');
    assert.equal(await page.locator('.milkdown-code-block').count(), 1);

    await h.mount('| A | B |\n| --- | --- |\n| one | two |');
    await caretEnd(page.locator('.ProseMirror td p').last());
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.ProseMirror .table-wrapper tbody tr').count(), 3, 'Tab in the last table cell adds a row');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('replaced');
    assert.match(await h.flush(), /replaced/, 'Shift+Tab returns to the previous cell');
    assert.ok(!(await h.flush()).includes('two'), 'Cell navigation selects its content for replacement');
    await page.keyboard.press('Tab');
    await page.keyboard.type('three');
    assert.match(await h.flush(), /three/);

    await page.evaluate(() => window.mountDocument());
    await page.locator('.ProseMirror').filter({ hasText: 'original' }).waitFor();
    const shortcut = options => page.locator('.ProseMirror').evaluate((el, options) => {
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true, composed: true, ...options });
      el.dispatchEvent(event); return event.defaultPrevented;
    }, options);
    assert.equal(await shortcut({}), true, 'Ctrl+S on a clean note suppresses browser Save As');
    assert.equal(await shortcut({ shiftKey: true }), false, 'Other shortcuts are not claimed');
    await caretEnd(page.locator('.ProseMirror p').first()); await page.keyboard.type(' changed');
    assert.equal(await shortcut({ isComposing: true }), true);
    assert.equal(await page.evaluate(() => window.saveRequests.length), 0, 'IME composition cannot trigger saving');
    assert.equal(await shortcut({}), true);
    await page.waitForFunction(() => window.saveRequests.length === 1);
    assert.match(await page.evaluate(() => window.saveRequests[0].text), /original changed/);
    const pre = page.getByRole('button', { name: /^前置/ });
    await pre.click(); await page.getByRole('button', { name: '＋ 添加前置', exact: true }).click();
    const input = page.getByRole('textbox', { name: '前置节点名称' });
    await input.waitFor(); assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Add relation focuses its input');
    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    assert.equal(await input.isVisible(), true, 'IME Escape does not dismiss the panel');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.kn-note-relations-popover').count(), 0);
    assert.equal(await pre.evaluate(el => el === document.activeElement), true, 'Escape restores focus to the trigger');

    await page.evaluate(() => window.mountDialog()); await page.getByRole('dialog').waitFor();
    const cancel = page.getByRole('button', { name: '继续编辑', exact: true });
    const confirm = page.getByRole('button', { name: '保存并关闭', exact: true });
    await cancel.focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.dialogActions), ['cancel'], 'Enter on Cancel must not confirm');
    await page.getByRole('button', { name: '放弃修改', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.dialogActions), ['cancel', 'discard']);
    await confirm.focus(); await page.keyboard.press('Tab');
    assert.equal(await cancel.evaluate(el => el === document.activeElement), true, 'Tab stays inside the modal');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await confirm.evaluate(el => el === document.activeElement), true);
    await confirm.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => window.dialogActions.length), 2, 'IME Enter cannot confirm');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.dialogActions), ['cancel', 'discard', 'cancel']);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Enter/newline: empty heading exits, heading soft break stays valid Markdown, table cells commit like Tab', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  const ready = async () => {
    await page.locator('.ProseMirror').waitFor();
    await page.waitForTimeout(250);
  };
  try {
    /* 空标题里按 Enter：转成普通段落，不留一个空的 "#" 标题 ✓ */
    await h.mount('#');
    await ready();
    const heading = page.locator('.ProseMirror h1');
    await heading.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x');
    assert.equal(await h.flush(), 'x\n', '空标题按 Enter 后留下的应是普通段落 ✓');
    assert.equal(await page.locator('.ProseMirror h1').count(), 0, '不残留空标题 ✓');

    /* 标题里 Shift+Enter：不能插非法软换行（旧行为会序列化成 title\\\nmore\n==== ✗） */
    await h.mount('# title');
    await ready();
    await page.locator('.ProseMirror h1').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('more');
    const headingShift = await h.flush();
    assert.equal(headingShift, '# title\n\nmore\n', '标题 Shift+Enter 拆成标题 + 正文段落 ✓');
    assert.ok(!headingShift.includes('\\'), 'Markdown 里不出现硬换行反斜杠 ✓');
    assert.ok(!headingShift.includes('===='), '不出现不稳定的 setext 标题写法 ✓');

    /* 表格单元格里 Enter：与 Tab 一致提交本格、进入下一格（旧行为会把光标挤出表格 ✗） */
    const table = '| a | b |\n| --- | --- |\n| c | d |';
    await h.mount(table);
    await ready();
    await page.locator('.ProseMirror table.children tbody th').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('X');
    assert.equal(await h.flush(), '| a | X |\n| - | - |\n| c | d |\n', 'Enter 只移动单元格，不往表格外写内容 ✓');
    assert.equal(await page.locator('.ProseMirror table.children tbody tr').count(), 2, 'Enter 不额外造表格行 ✓');

    /* 最后一格 Enter：新增一行并进入新行第一格（与 Tab 一致 ✓） */
    await h.mount(table);
    await ready();
    await page.locator('.ProseMirror table.children tbody td, .ProseMirror table.children tbody th').last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.ProseMirror table.children tbody tr').count(), 3, '最后一格 Enter 新增正文行 ✓');
    await page.keyboard.type('z');
    assert.equal(await h.flush(), '| a | b |\n| - | - |\n| c | d |\n| z |   |\n', '新行第一格可直接写 ✓');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('nested list + formula: Enter stays in the formula; Ctrl+Enter exits without a stray <br /> paragraph', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await h.mount("- 第一层\n  - 第二层\n    - 第三层\n\n$$\nx = 1\n$$");
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(700);
    const formula = page.locator(".ProseMirror .milkdown-code-block .cm-content").first();
    await formula.waitFor();
    await formula.click();
    await page.keyboard.press("Control+End");

    /* 公式编辑器里的普通 Enter 只换行，不退出块 ✓ */
    await page.keyboard.press("Enter");
    await page.keyboard.type("y = 2");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "cm-content", "公式里普通 Enter 后焦点仍在源码编辑区 ✓");
    assert.ok((await h.flush()).includes("$$\nx = 1\ny = 2\n$$"), "普通 Enter 只在公式内换行 ✓");

    /* Ctrl+Enter 退出公式：焦点到正文段落，且不再多出一个空的 `<br />` 段落 ✓ */
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.activeElement?.className), "ProseMirror editor ProseMirror-focused", "Ctrl+Enter 后焦点回到正文 ✓");
    assert.equal(
      await h.flush(),
      "* 第一层\n  * 第二层\n    * 第三层\n\n$$\nx = 1\ny = 2\n$$\n",
      "退出公式后不残留空段落（旧行为会多一个 <br /> ✗）✓",
    );
    await page.keyboard.type("after");
    assert.equal(
      await h.flush(),
      "* 第一层\n  * 第二层\n    * 第三层\n\n$$\nx = 1\ny = 2\n$$\n\nafter\n",
      "退出后可直接在正文继续写 ✓",
    );
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('formula preview boundary: Backspace/Delete enters formula source instead of deleting the formula', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await h.mount("- 第一层\n  - 第二层\n\n$$\nx = 1\n$$\n\nafter");
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(900);
    const before = await h.flush();
    assert.equal(await page.locator(".milkdown-code-block .codemirror-host.hidden").count(), 1, "公式默认是「只看结果」✓");

    /* 公式下方段落开头按 Backspace：不合并/删除公式，直接进入公式编辑栏 ✓ */
    await page.locator(".ProseMirror p").filter({ hasText: "after" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    assert.equal(await h.flush(), before, "Backspace 不能吃掉公式或后面的段落 ✓");
    assert.equal(await page.locator(".milkdown-code-block .codemirror-host.hidden").count(), 0, "公式编辑栏已展开（不再只是看结果）✓");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "cm-content", "光标进入公式源码编辑区 ✓");

    /* 公式上方段落末尾按 Delete：同理进入公式编辑栏 ✓ */
    await h.mount("before\n\n$$\nx = 1\n$$");
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(900);
    const beforeFormula = await h.flush();
    await page.locator(".ProseMirror p").filter({ hasText: "before" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    assert.equal(await h.flush(), beforeFormula, "Delete 不能把公式正文并进段落 ✓");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "cm-content", "Delete 也进入公式源码编辑区 ✓");

    /* 用户原场景：嵌套列表下方只有公式（下面就是空白区域），点空白按 Backspace ✓ */
    await h.mount("- 第一层\n  - 第二层\n\n$$\nx = 1\n$$");
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(900);
    const blankBefore = await h.flush();
    const formulaBox = await page.locator(".milkdown-code-block").boundingBox();
    await page.mouse.click(formulaBox.x + 80, formulaBox.y + formulaBox.height + 25);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    assert.equal(await h.flush(), blankBefore, "空白区域 Backspace 不能删除公式 ✓");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "cm-content", "空白区域 Backspace 进入公式编辑栏 ✓");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Shift+Enter soft line break then * / 1. still becomes a list', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  const ready = async () => {
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(300);
  };
  const focusBody = async () => {
    await page.locator(".ProseMirror").click();
    await page.waitForFunction(() => document.activeElement?.classList?.contains("ProseMirror"));
  };
  try {
    await h.mount("hello");
    await ready();
    await page.locator(".ProseMirror p").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(80);
    await page.keyboard.type("* ");
    /* 转换会挂载一个新的列表项 node view；等它挂完再敲正文，模拟真实人手速 ✓ */
    await page.waitForTimeout(120);
    await page.keyboard.type("item");
    assert.equal(await h.flush(), "hello\n\n* item\n", "软换行后的 * 仍转成无序列表 ✓");
    assert.equal(await page.locator(".ProseMirror ul").count(), 1);

    await h.mount("hello");
    await ready();
    await page.locator(".ProseMirror p").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(80);
    await page.keyboard.type("1. ");
    await page.waitForTimeout(120);
    await page.keyboard.type("first");
    assert.equal(await h.flush(), "hello\n\n1. first\n", "软换行后的 1. 仍转成有序列表 ✓");
    assert.equal(await page.locator(".ProseMirror ol").count(), 1);

    /* 普通段落开头的原生 Markdown 输入规则不受影响 ✓ */
    await h.mount("");
    await ready();
    await focusBody();
    await page.keyboard.type("- normal");
    assert.equal(await h.flush(), "* normal\n", "普通输入规则照旧 ✓");
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Enter at a list item end keeps its sublist on that item (no reparenting/reappearing)', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await h.mount("- one\n  - nested");
    await page.locator(".ProseMirror").waitFor();
    await page.waitForTimeout(300);
    await page.getByText("one", { exact: true }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("X");
    assert.equal(await h.flush(), "* one\n  * nested\n* X\n", "新项在子列表之后，不把子列表挂到新项下面 ✓");
    const treeAfterEnter = await page.evaluate(() => [...document.querySelectorAll(".ProseMirror li.list-item")].map((li) => ({
      text: li.querySelector(":scope > .children > .content-dom > p")?.textContent ?? "",
      kids: li.querySelectorAll(":scope > .children ul .list-item").length,
    })));
    assert.deepEqual(
      treeAfterEnter,
      [{ text: "one", kids: 1 }, { text: "nested", kids: 0 }, { text: "X", kids: 0 }],
      "子列表仍挂在 one 下面 ✓",
    );

    /* 再把新项删空：子列表不能被"搬回"或重新出现到别处 ✓ */
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    const treeAfterDelete = await page.evaluate(() => [...document.querySelectorAll(".ProseMirror li.list-item")].map((li) => ({
      text: li.querySelector(":scope > .children > .content-dom > p")?.textContent ?? "",
      kids: li.querySelectorAll(":scope > .children ul .list-item").length,
    })));
    assert.deepEqual(
      treeAfterDelete,
      [{ text: "one", kids: 1 }, { text: "nested", kids: 0 }],
      "删除新项后子列表仍在 one 下，不会重新搬家 ✓",
    );
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

/** 读 ShadowRoot / 文档里真正的焦点元素（面板实际是 shadow DOM ✓） */const activeElement = page => page.evaluate(() => {
  const root = document.querySelector('.kn-editor');
  const tree = root?.getRootNode();
  const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
  return {
    tag: active?.tagName ?? null,
    className: typeof active?.className === 'string' ? active.className : null,
    inProseMirror: active !== null && active.closest?.('.ProseMirror') !== null,
    isSourceTextarea: active !== null && active.classList?.contains('kn-editor-text') === true,
    isButton: active !== null && active.tagName === 'BUTTON',
  };
});

test('opening a note focuses the editor: typing and Ctrl+S need no extra click', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await page.evaluate(() => window.mountDocument());
    await page.locator('.ProseMirror').filter({ hasText: 'original' }).waitFor();
    await page.waitForFunction(() => {
      const root = document.querySelector('.kn-editor');
      const tree = root?.getRootNode();
      const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
      return active !== null && active.closest?.('.ProseMirror') !== null;
    }, { timeout: 8000 });
    assert.equal((await activeElement(page)).inProseMirror, true, '打开笔记后焦点要直接落在正文 ✓');

    await page.keyboard.type(' typed');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => window.saveRequests.length === 1);
    assert.match(
      await page.evaluate(() => window.saveRequests[0].text),
      /original typed/,
      '不用先点正文也能保存刚输入的字 ✓',
    );
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('unsupported syntax falls back to source with focus; removing it returns focus to rich text', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await page.evaluate(() => window.mountDocument({ text: '<div>raw html</div>' }));
    const textarea = page.locator('.kn-editor-text');
    await textarea.waitFor({ timeout: 8000 });
    await page.waitForFunction(() => {
      const root = document.querySelector('.kn-editor');
      const tree = root?.getRootNode();
      const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
      return active !== null && active.classList?.contains('kn-editor-text') === true;
    }, { timeout: 8000 });
    assert.equal((await activeElement(page)).isSourceTextarea, true, '自动落到纯文本时焦点要在 textarea ✓');

    await textarea.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' edited');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => window.saveRequests.length === 1);
    assert.equal((await activeElement(page)).isSourceTextarea, true, '纯文本模式保存后焦点要回到 textarea ✓');
    assert.match(await page.evaluate(() => window.saveRequests[0].text), /raw html[\s\S]* edited/);

    await textarea.fill('plain text');
    await page.waitForFunction(() => {
      const root = document.querySelector('.kn-editor');
      const tree = root?.getRootNode();
      const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
      return active !== null && active.closest?.('.ProseMirror') !== null;
    }, { timeout: 8000 });
    assert.equal((await activeElement(page)).inProseMirror, true, '语法删干净后回正文，焦点要跟着回正文 ✓');
    await page.keyboard.type('!');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => window.saveRequests.length === 2);
    assert.match(await page.evaluate(() => window.saveRequests[1].text), /plain text!/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('in-editor "adopt latest" confirmation is keyboard operable and restores focus', async () => {
  const h = await startEditorBrowser();
  const { page } = h;
  try {
    await page.evaluate(() => window.mountDocument({ conflict: true }));
    await page.locator('.ProseMirror').filter({ hasText: 'original' }).waitFor();
    await page.waitForFunction(() => {
      const root = document.querySelector('.kn-editor');
      const tree = root?.getRootNode();
      const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
      return active !== null && active.closest?.('.ProseMirror') !== null;
    }, { timeout: 8000 });
    await page.keyboard.type(' changed');
    await page.keyboard.press('Control+s');
    const conflict = page.locator('.kn-editor-conflict');
    await conflict.waitFor({ timeout: 8000 });
    const trigger = conflict.getByRole('button', { name: '使用文件最新版本', exact: true });
    await trigger.click();
    const dialog = page.locator('.kn-editor-confirm');
    await dialog.waitFor();
    const stay = dialog.getByRole('button', { name: '继续编辑', exact: true });
    const adopt = dialog.getByRole('button', { name: '使用文件最新版本', exact: true });
    assert.equal(await stay.evaluate(el => el === document.activeElement), true, '确认框打开先聚焦保守选项 ✓');
    await page.keyboard.press('Tab');
    assert.equal(await adopt.evaluate(el => el === document.activeElement), true, 'Tab 在确认框按钮间循环 ✓');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await stay.evaluate(el => el === document.activeElement), true, 'Shift+Tab 反向循环 ✓');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0, 'Esc 关闭确认框 ✓');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true, '取消后焦点回到触发按钮 ✓');

    await trigger.click();
    await dialog.waitFor();
    await adopt.focus();
    await page.keyboard.press('Tab');
    assert.equal(await stay.evaluate(el => el === document.activeElement), true, '焦点不会跑出确认框 ✓');
    await stay.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await dialog.count(), 1, '输入法组合时不确认 ✓');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0, 'Esc 关闭确认框 ✓');

    /* 真正采用最新版本：确认后冲突消失，焦点回正文 ✓ */
    await trigger.click();
    await dialog.waitFor();
    await adopt.click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => {
      const root = document.querySelector('.kn-editor');
      const tree = root?.getRootNode();
      const active = tree !== undefined && 'activeElement' in tree ? tree.activeElement : document.activeElement;
      return active !== null && active.closest?.('.ProseMirror') !== null;
    }, { timeout: 8000 });
    assert.equal(await page.locator('.kn-editor-conflict').count(), 0, '采用最新版本后冲突条消失 ✓');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

