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
