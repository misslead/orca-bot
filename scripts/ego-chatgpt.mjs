/**
 * ego-browser → 网页版 ChatGPT 桥接脚本
 * 由 bin/orca-bot.mjs 通过 ego-browser 的 Node.js 运行时执行。
 * 输入：state/ego-request.json { id, prompt, url, timeoutMs }
 * 输出：state/ego-result-<id>.json { ok, answer, error? }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST_PATH = path.join(ROOT, 'state', 'ego-request.json');

const request = JSON.parse(await fs.readFile(REQUEST_PATH, 'utf8'));
const resultPath = path.join(ROOT, 'state', `ego-result-${request.id}.json`);
const timeoutMs = Number(request.timeoutMs || 240000);

async function writeResult(payload) {
  await fs.writeFile(resultPath, JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2), 'utf8');
}

let task = null;
try {
  const existing = request.spaceId
    ? (await listTaskSpaces()).find((s) => s.id === request.spaceId)
    : undefined;
  task = existing ? await taskSpace(request.spaceId) : await taskSpace(`orcabot-${request.id}`);
  const page = (await task.pages())[0] ?? (await task.newPage());

  await page.goto(request.url || 'https://chatgpt.com/', { timeout: 90000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

  const composer = '#prompt-textarea, div[contenteditable="true"]';
  let ready = false;
  try {
    await page.waitForSelector(composer, { state: 'visible', timeout: 45000 });
    ready = true;
  } catch {
    ready = false;
  }
  if (!ready) {
    const url = await page.url();
    throw new Error(`未找到输入框（可能未登录或页面改版），当前地址：${url}`);
  }
  if ((await page.url()).includes('/auth/')) {
    throw new Error('ChatGPT 未登录，请先在 ego 浏览器中登录后重试。');
  }

  const baseline = await page.evaluate(() =>
    document.querySelectorAll('[data-response-body]').length
  );

  await page.click(composer);
  await page.keyboard.paste(request.prompt);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);

  if ((await page.url()).includes('/auth/')) {
    throw new Error('提交后被重定向到登录页，请先在 ego 浏览器中登录 ChatGPT。');
  }

  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableCount = 0;
  let answer = '';

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const state = await page.evaluate((base) => {
      const bodies = [...document.querySelectorAll('[data-response-body]')];
      const node = bodies[bodies.length - 1];
      const busy = !!document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]'
      );
      return {
        count: bodies.length,
        text: node ? node.innerText : '',
        busy,
      };
    }, baseline);

    if (state.count > baseline && state.text) {
      if (state.text === lastText && !state.busy) {
        stableCount += 1;
        if (stableCount >= 2) { answer = state.text; break; }
      } else {
        stableCount = 0;
        lastText = state.text;
      }
    }
  }

  if (!answer) answer = lastText;
  if (!answer || !answer.trim()) {
    throw new Error(`等待 ${Math.round(timeoutMs / 1000)}s 仍未获取到回答。`);
  }

  await writeResult({ ok: true, answer: answer.trim() });
  console.log(JSON.stringify({ ok: true, length: answer.trim().length }));
  await task.finish({ keep: [] });
} catch (err) {
  await writeResult({ ok: false, error: String(err && err.message ? err.message : err) });
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  if (task) {
    try { await task.finish({ keep: [] }); } catch { /* 忽略收尾失败 */ }
  }
}
