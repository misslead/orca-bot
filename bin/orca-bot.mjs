#!/usr/bin/env node
/**
 * OrcaBot 调度器
 * 用法见 README.md 或运行 node bin/orca-bot.mjs help
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'bot.json'), 'utf8'));
const RUNS_DIR = path.join(ROOT, 'runs');
const STATE_DIR = path.join(ROOT, 'state');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

// ---------- 基础工具 ----------

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, opts };
}

function nowIso() { return new Date().toISOString(); }

function slugify(text, max = 32) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return (s || 'run').slice(0, max);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function rel(p) { return path.relative(ROOT, p) || '.'; }

function parseJson(text, fallback = null) {
  try { return JSON.parse(String(text ?? '').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function readJson(p, fallback = null) {
  try { return parseJson(fs.readFileSync(p, 'utf8'), fallback); } catch { return fallback; }
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + `\n…[已截断 ${s.length - max} 字]`;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
}

function runShell(command, opts = {}) {
  return spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
}

// ---------- 工作区 ----------

function resolveWorkspace(opts) {
  const raw = typeof opts.workspace === 'string' ? opts.workspace : CFG.defaultWorkspace;
  const abs = path.resolve(ROOT, raw);
  ensureDir(abs);
  const real = fs.realpathSync(abs);
  const norm = (p) => p.toLowerCase();
  const allowRoots = (CFG.allowedWorkspaceRoots || [path.dirname(ROOT)]);
  const allowed = opts['allow-any'] || allowRoots.some((root) => {
    const r = norm(fs.realpathSync(path.resolve(root)));
    const target = norm(real);
    return target === r || target.startsWith(r + path.sep);
  });
  if (!allowed) {
    throw new Error(`工作区 ${real} 不在允许范围 ${allowRoots.join(', ')} 内。如确需使用，加 --allow-any。`);
  }
  return real;
}

function git(cwd, args) {
  return run('git', args, { cwd });
}

function isGitRepo(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------- 运行记录 ----------

function newRun(objective, workspace) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const id = `${stamp}-${slugify(objective, 24)}`;
  const dir = path.join(RUNS_DIR, id);
  ensureDir(path.join(dir, 'logs'));
  const runData = {
    id,
    objective,
    workspace,
    createdAt: nowIso(),
    status: 'created',
    planner: null,
    summary: '',
    planMarkdown: '',
    calls: 0,
    tasks: [],
  };
  saveRun(dir, runData);
  writeJson(path.join(STATE_DIR, 'current.json'), { id, dir });
  return { dir, data: runData };
}

function runDirOf(id) {
  const d = path.join(RUNS_DIR, id);
  if (!fs.existsSync(path.join(d, 'run.json'))) throw new Error(`找不到运行记录 ${id}`);
  return d;
}

function saveRun(dir, data) {
  data.updatedAt = nowIso();
  writeJson(path.join(dir, 'run.json'), data);
}

function loadLatestRun() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const dirs = fs.readdirSync(RUNS_DIR)
    .filter((n) => fs.existsSync(path.join(RUNS_DIR, n, 'run.json')))
    .sort();
  if (!dirs.length) return null;
  const dir = path.join(RUNS_DIR, dirs[dirs.length - 1]);
  return { dir, data: readJson(path.join(dir, 'run.json')) };
}

function saveLog(dir, name, content) {
  ensureDir(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', `${name}.log`), content ?? '', 'utf8');
}

// ---------- CodeBuddy ----------

function codebuddyArgs(agent) {
  const args = ['-p', '-y', '--agent', agent, '--model', CFG.model, '--output-format', 'json'];
  if (CFG.effort) args.push('--effort', CFG.effort);
  return args;
}

function extractResult(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const last = [...items].reverse().find((x) => x && (x.type === 'result' || typeof x.result === 'string'));
  const value = last?.result ?? last;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function callAgent({ agent, prompt, cwd, logName, run: runState, dir }) {
  const limit = CFG.limits.maxSubagentCallsPerRun;
  if (runState && runState.calls >= limit) {
    throw new Error(`已达到单次运行子代理调用上限 ${limit}，停止以避免超支。`);
  }
  const started = Date.now();
  const r = run(CFG.codebuddyBin, codebuddyArgs(agent), {
    cwd,
    input: prompt,
    timeout: CFG.limits.subagentTimeoutMs,
    shell: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (runState) runState.calls += 1;
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  const log = [
    `# agent: ${agent}`,
    `# cwd: ${cwd}`,
    `# exit: ${r.status}  signal: ${r.signal || '-'}  ${elapsed}s`,
    '',
    '## stdout',
    r.stdout || '',
    '',
    '## stderr',
    r.stderr || '',
  ].join('\n');
  if (dir && logName) saveLog(dir, logName, log);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${agent} 退出码 ${r.status}${r.signal ? ` (${r.signal})` : ''}，日志见 ${dir ? rel(path.join(dir, 'logs', logName + '.log')) : 'stdout'}`);
  }
  return extractResult(r.stdout);
}

function parseJsonBlock(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  const fenced = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try { return JSON.parse(fenced[i][1].trim()); } catch { /* 继续 */ }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* 继续 */ }
  }
  return null;
}

// ---------- ego → ChatGPT ----------

function runEgoPlanner(runId, prompt, dir) {
  const requestPath = path.join(STATE_DIR, 'ego-request.json');
  const resultPath = path.join(STATE_DIR, `ego-result-${runId}.json`);
  writeJson(requestPath, {
    id: runId,
    prompt,
    url: CFG.planner.chatgptUrl,
    timeoutMs: CFG.planner.timeoutMs,
  });
  if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);

  const scriptUrl = 'file:///' + path.join(ROOT, 'scripts', 'ego-chatgpt.mjs').replace(/\\/g, '/');
  const cmd = `${CFG.egoBin} nodejs -e "await import('${scriptUrl}')"`;
  const r = runShell(cmd, { timeout: CFG.planner.timeoutMs + 120000, cwd: ROOT });
  saveLog(dir, 'ego-planner', `# cmd: ${cmd}\n# exit: ${r.status}\n\n## stdout\n${r.stdout || ''}\n\n## stderr\n${r.stderr || ''}`);

  const result = readJson(resultPath, null);
  if (result?.ok && result.answer) return { ok: true, answer: result.answer };
  const reason = result?.error || r.stderr?.trim() || `ego 退出码 ${r.status}`;
  return { ok: false, error: reason };
}

function buildPlannerPrompt(objective, workspace) {
  return [
    '你是方案规划器。请为下面的目标设计一份可执行开发方案，并拆成可独立验收的任务。',
    '',
    `## 目标\n${objective}`,
    '',
    `## 工作区\n${workspace}`,
    '',
    '## 约束',
    '- 只在该工作区内改动；不要建议修改工作区之外的文件。',
    '- 优先复用现有结构，不要为了方案完整而新增无关工程。',
    '- 任务必须可独立验收，并给出验收证据（命令、输出或文件）。',
    '- 任务数量 3~10 个。',
    '',
    '## 输出格式',
    '只输出一个 json 代码块，不要输出其他内容：',
    '```json',
    '{"summary":"一句话结论","plan_markdown":"分步骤方案，含风险与取舍","tasks":[{"id":"T1","title":"短标题","role":"builder","instructions":"具体做什么","acceptance":"可验证标准","files":["相对路径"],"depends_on":[]}]}',
    '```',
    'role 取值：builder / scout / planner。',
  ].join('\n');
}

function normalizeTasks(rawTasks) {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.slice(0, CFG.limits.maxTasksPerRun).map((t, i) => ({
    id: String(t.id || `T${i + 1}`),
    title: String(t.title || `任务 ${i + 1}`),
    role: ['builder', 'scout', 'planner'].includes(t.role) ? t.role : 'builder',
    instructions: String(t.instructions || ''),
    acceptance: String(t.acceptance || ''),
    files: Array.isArray(t.files) ? t.files.map(String) : [],
    dependsOn: (Array.isArray(t.depends_on) ? t.depends_on : Array.isArray(t.dependsOn) ? t.dependsOn : []).map(String),
    status: 'pending',
    attempts: 0,
    output: '',
    issues: [],
    commit: null,
  }));
}

// ---------- 命令：plan ----------

function cmdPlan(objective, opts) {
  if (!objective) throw new Error('缺少目标。用法：node bin/orca-bot.mjs plan "目标" --workspace <路径>');
  const workspace = resolveWorkspace(opts);
  const { dir, data } = newRun(objective, workspace);
  data.status = 'planning';
  const prompt = buildPlannerPrompt(objective, workspace);

  let plannerOutput = null;
  let plannerName = null;

  if (CFG.planner.prefer === 'ego' && !opts['no-ego']) {
    console.log(`${C.cyan}→${C.reset} 方案源：ego → ChatGPT`);
    const ego = runEgoPlanner(data.id, prompt, dir);
    if (ego.ok) {
      plannerName = 'ego-chatgpt';
      plannerOutput = ego.answer;
    } else {
      console.log(`${C.yellow}!${C.reset} ego 不可用（${ego.error}），回退 CodeBuddy planner`);
      saveLog(dir, 'ego-planner-error', ego.error);
    }
  }

  if (!plannerOutput) {
    console.log(`${C.cyan}→${C.reset} 方案源：CodeBuddy ${CFG.roles.planner} (${CFG.model})`);
    plannerName = 'codebuddy';
    plannerOutput = callAgent({
      agent: CFG.roles.planner,
      prompt,
      cwd: workspace,
      logName: 'planner',
      run: data,
      dir,
    });
  }

  let parsed = parseJsonBlock(plannerOutput);

  if ((!parsed || !Array.isArray(parsed.tasks) || !parsed.tasks.length) && plannerName === 'ego-chatgpt') {
    saveLog(dir, 'ego-planner-raw', plannerOutput);
    console.log(`${C.yellow}!${C.reset} ego 返回内容不是可解析的任务 JSON，回退 CodeBuddy planner`);
    plannerName = 'codebuddy';
    plannerOutput = callAgent({
      agent: CFG.roles.planner,
      prompt,
      cwd: workspace,
      logName: 'planner-fallback',
      run: data,
      dir,
    });
    parsed = parseJsonBlock(plannerOutput);
  }

  if (!parsed || !Array.isArray(parsed.tasks) || !parsed.tasks.length) {
    data.status = 'blocked';
    saveRun(dir, data);
    saveLog(dir, 'planner-raw', plannerOutput);
    throw new Error(`规划结果无法解析出任务，原始输出已存 ${rel(path.join(dir, 'logs', 'planner-raw.log'))}`);
  }

  data.planner = plannerName;
  data.summary = String(parsed.summary || '');
  data.planMarkdown = String(parsed.plan_markdown || plannerOutput);
  data.tasks = normalizeTasks(parsed.tasks);
  data.status = 'planned';
  saveRun(dir, data);
  fs.writeFileSync(path.join(dir, 'plan.md'), `# ${objective}\n\n${data.summary}\n\n${data.planMarkdown}\n`, 'utf8');

  printRun(data);
  console.log(`\n${C.dim}计划已保存：${rel(path.join(dir, 'plan.md'))}${C.reset}`);
  console.log(`${C.dim}执行：node bin/orca-bot.mjs run "${objective}" --workspace "${workspace}"${C.reset}`);
  return { dir, data };
}

function printRun(data) {
  console.log(`\n${C.bold}${data.id}${C.reset}  ${C.dim}${data.status} / 方案源 ${data.planner || '-'} / 调用 ${data.calls}${C.reset}`);
  if (data.summary) console.log(`${data.summary}\n`);
  for (const t of data.tasks) {
    const mark = t.status === 'done' ? `${C.green}✓${C.reset}`
      : t.status === 'failed' ? `${C.red}✗${C.reset}`
      : t.status === 'blocked' ? `${C.yellow}■${C.reset}`
      : t.status === 'running' ? `${C.cyan}…${C.reset}` : '·';
    const deps = t.dependsOn?.length ? `  ${C.dim}依赖 ${t.dependsOn.join(',')}${C.reset}` : '';
    const commit = t.commit ? `  ${C.dim}${t.commit.slice(0, 8)}${C.reset}` : '';
    console.log(`${mark} ${t.id} [${t.role}] ${t.title}${deps}${commit}`);
  }
}

// ---------- 命令：dispatch / review ----------

function taskContext(data, task) {
  const done = data.tasks.filter((t) => t.status === 'done' && t.id !== task.id);
  return done.slice(-3).map((t) => `### ${t.id} ${t.title}\n${truncate(t.output, 1200)}`).join('\n\n');
}

function buildTaskPrompt(data, task) {
  return [
    `## 总目标\n${data.objective}`,
    '',
    `## 当前任务 ${task.id}：${task.title}`,
    `工作区：${data.workspace}`,
    '',
    `### 要做什么\n${task.instructions}`,
    '',
    `### 验收标准\n${task.acceptance || '按任务描述完成，并给出验证证据。'}`,
    '',
    task.files?.length ? `### 涉及文件\n${task.files.join('\n')}` : '',
    '',
    `### 前置任务结果\n${taskContext(data, task) || '无'}`,
    '',
    '### 硬性约束',
    '- 只改本任务范围内、且位于工作区内的文件。',
    '- 不要执行 git commit / push / reset，存档由主管处理。',
    '- 不要格式化或重构与任务无关的代码。',
  ].filter(Boolean).join('\n');
}

function buildReviewPrompt(data, task) {
  return [
    '请按验收标准审核下面这次任务执行结果。',
    '',
    `## 总目标\n${data.objective}`,
    '',
    `## 任务 ${task.id}：${task.title}\n工作区：${data.workspace}`,
    '',
    `### 任务要求\n${task.instructions}`,
    '',
    `### 验收标准\n${task.acceptance || '按任务描述完成。'}`,
    '',
    `### 执行者报告\n${truncate(task.output, 8000)}`,
    '',
    '请查看工作区实际改动与验证证据后输出严格 JSON：',
    '{"verdict":"pass|fail","summary":"一句话结论","issues":["问题1"]}',
  ].join('\n');
}

function reviewTask(data, task, dir) {
  const text = callAgent({
    agent: CFG.roles.reviewer,
    prompt: buildReviewPrompt(data, task),
    cwd: data.workspace,
    logName: `review-${task.id}-${task.attempts}`,
    run: data,
    dir,
  });
  const parsed = parseJsonBlock(text);
  if (!parsed || !['pass', 'fail'].includes(parsed.verdict)) {
    return { verdict: 'fail', summary: '审核输出无法解析为 JSON', issues: [truncate(text, 800)] };
  }
  return {
    verdict: parsed.verdict,
    summary: String(parsed.summary || ''),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  };
}

function checkpoint(workspace, message) {
  const top = isGitRepo(workspace);
  if (!top) return { ok: false, reason: 'not_a_git_repo' };
  const add = git(top, ['add', '-A']);
  if (add.status !== 0) return { ok: false, reason: add.stderr.trim() };
  const status = git(top, ['status', '--porcelain']);
  if (!status.stdout.trim()) return { ok: true, commit: null, reason: 'no_changes' };
  const identity = CFG.gitIdentity || {};
  const commit = identity.name && identity.email
    ? run('git', ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-m', message], { cwd: top })
    : git(top, ['commit', '-m', message]);
  if (commit.status !== 0) return { ok: false, reason: (commit.stderr || commit.stdout).trim() };
  const hash = git(top, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  return { ok: true, commit: hash, reason: 'committed' };
}

function executeTask(dir, data, task) {
  if (task.status === 'done') return true;
  const missing = task.dependsOn.filter((id) => {
    const dep = data.tasks.find((t) => t.id === id);
    return !dep || dep.status !== 'done';
  });
  if (missing.length) {
    task.status = 'blocked';
    task.issues = [`依赖未完成：${missing.join(', ')}`];
    saveRun(dir, data);
    return false;
  }

  const role = CFG.roles[task.role] || CFG.roles.builder;
  task.status = 'running';
  saveRun(dir, data);

  while (true) {
    task.attempts += 1;
    console.log(`${C.cyan}→${C.reset} ${task.id} 执行中（${role}，第 ${task.attempts} 次）`);
    try {
      task.output = callAgent({
        agent: role,
        prompt: buildTaskPrompt(data, task),
        cwd: data.workspace,
        logName: `task-${task.id}-${task.attempts}`,
        run: data,
        dir,
      });
    } catch (err) {
      task.status = 'failed';
      task.issues = [String(err.message || err)];
      saveRun(dir, data);
      console.log(`${C.red}✗${C.reset} ${task.id} 执行失败：${task.issues[0]}`);
      return false;
    }

    console.log(`${C.cyan}→${C.reset} ${task.id} 审核中（${CFG.roles.reviewer}）`);
    const review = reviewTask(data, task, dir);

    if (review.verdict === 'pass') {
      task.issues = [];
      const cp = checkpoint(data.workspace, `bot(${data.id}): ${task.id} ${task.title}`);
      if (cp.ok) {
        task.commit = cp.commit;
        task.status = 'done';
        saveRun(dir, data);
        console.log(`${C.green}✓${C.reset} ${task.id} 通过${cp.commit ? `，commit ${cp.commit}` : '（无文件变更）'}`);
        return true;
      }
      task.status = 'failed';
      task.issues = [`审核通过但存档失败：${cp.reason}`];
      saveRun(dir, data);
      console.log(`${C.yellow}!${C.reset} ${task.id} 存档失败：${cp.reason}`);
      return false;
    }

    task.issues = review.issues;
    if (task.attempts > CFG.limits.maxFixAttempts) {
      task.status = 'failed';
      saveRun(dir, data);
      console.log(`${C.red}✗${C.reset} ${task.id} 审核未通过：${review.summary}`);
      return false;
    }

    console.log(`${C.yellow}↺${C.reset} ${task.id} 审核未通过，退回修复：${review.summary}`);
    saveRun(dir, data);
    task.instructions = `${task.instructions}\n\n## 上一轮审核问题（必须修复）\n${review.issues.map((x) => `- ${x}`).join('\n') || `- ${review.summary}`}`;
  }
}

// ---------- 命令：run / tick ----------

function cmdRun(objective, opts) {
  const { dir, data } = cmdPlan(objective, opts);
  return executeRun(dir, data);
}

function executeRun(dir, data) {
  data.status = 'running';
  saveRun(dir, data);
  console.log(`\n${C.bold}开始执行${C.reset} ${data.id}（工作区 ${data.workspace}）`);
  for (const task of data.tasks) {
    if (data.calls >= CFG.limits.maxSubagentCallsPerRun) {
      task.status = task.status === 'pending' ? 'blocked' : task.status;
      task.issues = task.issues?.length ? task.issues : ['达到子代理调用上限，未执行'];
      data.status = 'blocked';
      saveRun(dir, data);
      console.log(`${C.yellow}!${C.reset} 达到调用上限，停止排队任务`);
      break;
    }
    executeTask(dir, data, task);
  }
  const allDone = data.tasks.every((t) => t.status === 'done');
  data.status = allDone ? 'done' : (data.tasks.some((t) => t.status === 'running') ? 'blocked' : 'failed');
  saveRun(dir, data);
  printRun(data);
  console.log(`\n运行记录：${rel(path.join(dir, 'run.json'))}`);
  return { dir, data, ok: allDone };
}

function cmdTick(opts) {
  const latest = loadLatestRun();
  if (!latest) { console.log('没有可继续的运行记录。'); return { ok: true }; }
  const pending = latest.data.tasks.filter((t) => t.status !== 'done');
  if (!pending.length) { console.log('最新运行已完成，无待处理任务。'); return { ok: true }; }
  console.log(`${C.cyan}→${C.reset} 继续运行 ${latest.data.id}，剩余 ${pending.length} 个任务`);
  return executeRun(latest.dir, latest.data);
}

// ---------- 命令：status / skills ----------

function cmdStatus() {
  console.log(`${C.bold}${CFG.name}${C.reset}`);
  console.log(`模型        ${CFG.model}（effort ${CFG.effort || '-'}）`);
  console.log(`方案源      ${CFG.planner.prefer === 'ego' ? 'ego → ChatGPT，失败回退 CodeBuddy' : 'CodeBuddy'}`);
  const top = isGitRepo(ROOT);
  if (top) {
    const branch = git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const dirty = git(ROOT, ['status', '--porcelain']).stdout.trim();
    console.log(`Bot 仓库    ${top} @ ${branch}${dirty ? `（${dirty.split('\n').length} 项未提交）` : '（干净）'}`);
  } else {
    console.log(`Bot 仓库    未初始化`);
  }
  const latest = loadLatestRun();
  if (latest) {
    const d = latest.data;
    const done = d.tasks.filter((t) => t.status === 'done').length;
    console.log(`最新运行    ${d.id}  ${d.status}  任务 ${done}/${d.tasks.length}  调用 ${d.calls}`);
  } else {
    console.log(`最新运行    无`);
  }
  const r = run('orca', ['status', '--json'], { timeout: 30000 });
  const s = r.status === 0 ? parseJson(r.stdout, null) : null;
  if (s) {
    console.log(`Orca        运行中=${s.result?.app?.running === true ? '是' : '否'}  运行时就绪=${s.result?.runtime?.reachable === true ? '是' : '否'}`);
  } else {
    console.log(`Orca        未检测到（orca 命令不可用或未启动）`);
  }
  const egoVersion = runShell(`${CFG.egoBin} --version`, { timeout: 20000 });
  const egoLine = `${egoVersion.stdout || ''}${egoVersion.stderr || ''}`.trim().split('\n')[0];
  console.log(`\n${C.dim}ego 可用性：${egoLine || '未安装'}${C.reset}`);
}

function parseFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const value = kv[2].trim();
      meta[key] = value === '>' || value === '|-' || value === '|' ? '' : value.replace(/^["']|["']$/g, '');
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key] || ''} ${line.trim()}`.trim();
    }
  }
  return meta;
}

function collectSkillFiles() {
  const home = os.homedir();
  const roots = [
    { kind: 'skill', dir: path.join(home, '.codebuddy', 'skills'), depth: 2 },
    { kind: 'skill', dir: path.join(home, '.trae-cn', 'skills'), depth: 2 },
    { kind: 'agent', dir: path.join(ROOT, '.codebuddy', 'agents'), depth: 1 },
  ];
  const files = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    const base = fs.realpathSync(root.dir);
    if (seen.has(base)) continue;
    seen.add(base);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      if (root.depth === 2) {
        const f = path.join(dir, 'SKILL.md');
        if (fs.existsSync(f)) files.push({ kind: 'skill', file: f, dir });
      } else {
        for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
          files.push({ kind: 'agent', file: path.join(dir, f), dir });
        }
      }
    }
  }
  return files;
}

function cmdSkills(query) {
  if (!query) throw new Error('用法：node bin/orca-bot.mjs skills "<关键词>"');
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const item of collectSkillFiles()) {
    const meta = parseFrontmatter(item.file);
    if (!meta) continue;
    const name = meta.name || path.basename(item.file, '.md');
    const desc = meta.description || '';
    const hay = `${name} ${desc}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name.toLowerCase().includes(kw)) score += 3;
      if (hay.includes(kw)) score += 1;
    }
    if (score === 0) continue;
    results.push({ kind: item.kind, name, desc, score, file: item.file });
  }
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = results.slice(0, 10);
  if (!top.length) {
    console.log(`未找到与「${query}」匹配的本地技能。可让 bot-scout 调用 find-skills 查远程市场。`);
    return;
  }
  console.log(`${C.bold}本地命中 ${top.length} 项${C.reset}（远程请用 find-skills）`);
  for (const r of top) {
    console.log(`\n${C.cyan}${r.kind === 'agent' ? '[agent]' : '[skill]'}${C.reset} ${C.bold}${r.name}${C.reset}`);
    console.log(`  ${truncate(r.desc, 160)}`);
    console.log(`  ${C.dim}${r.file}${C.reset}`);
  }
}

// ---------- 命令：checkpoint / rollback / review ----------

function cmdCheckpoint(message, opts) {
  const workspace = resolveWorkspace(opts);
  const msg = message || `bot: checkpoint ${new Date().toISOString()}`;
  const r = checkpoint(workspace, msg);
  if (!r.ok) throw new Error(`存档失败：${r.reason}`);
  if (r.commit) console.log(`${C.green}✓${C.reset} 已提交 ${r.commit}  (${msg})`);
  else console.log('无文件变更，未创建提交。');
}

function cmdRollback(ref, opts) {
  if (!ref) throw new Error('用法：node bin/orca-bot.mjs rollback <commit> --workspace <路径> --yes');
  const workspace = resolveWorkspace(opts);
  const top = isGitRepo(workspace);
  if (!top) throw new Error('工作区不是 git 仓库，无法回滚。');
  if (!opts.yes) throw new Error('回滚会丢弃未提交改动。确认后加 --yes。');
  const check = git(top, ['rev-parse', '--verify', ref]);
  if (check.status !== 0) throw new Error(`找不到 ref：${ref}`);
  const r = git(top, ['reset', '--hard', ref]);
  if (r.status !== 0) throw new Error(`回滚失败：${r.stderr.trim()}`);
  console.log(`${C.green}✓${C.reset} 已回滚到 ${git(top, ['rev-parse', '--short', 'HEAD']).stdout.trim()}`);
}

function cmdReview(taskId, opts) {
  const latest = opts.run ? { dir: runDirOf(opts.run), data: readJson(path.join(runDirOf(opts.run), 'run.json')) } : loadLatestRun();
  if (!latest) throw new Error('没有运行记录。');
  const task = latest.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`找不到任务 ${taskId}`);
  if (!task.output) throw new Error(`任务 ${taskId} 还没有执行输出。`);
  const review = reviewTask(latest.data, task, latest.dir);
  saveRun(latest.dir, latest.data);
  console.log(`${review.verdict === 'pass' ? C.green + '✓ pass' : C.red + '✗ fail'}${C.reset} ${review.summary}`);
  for (const issue of review.issues) console.log(`  - ${issue}`);
  return review;
}

// ---------- 帮助 ----------

function printHelp() {
  console.log(`${C.bold}${CFG.name}${C.reset} — Orca 项目主管 Bot

用法：node bin/orca-bot.mjs <command> [options]

命令：
  status                         查看配置、仓库、最新运行、Orca 状态
  skills "<关键词>"              本地技能/子代理索引（远程用 find-skills）
  plan "<目标>" [--workspace p]  出方案并拆任务（ego→ChatGPT，失败回退 CodeBuddy）
  run  "<目标>" [--workspace p]  出方案并立即顺序执行 + 审核 + 存档
  tick                           继续最新运行中未完成的任务
  review <task-id> [--run id]    重新审核某个任务
  checkpoint "<说明>" [--workspace p]
  rollback <ref> [--workspace p] --yes
  help

通用选项：
  --workspace <路径>   目标工作区（默认 ./workspace）
  --no-ego             跳过 ego，直接用 CodeBuddy 规划
  --allow-any          允许使用配置白名单之外的工作区
`);
}

// ---------- 入口 ----------

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { positional, opts } = parseArgs(argv.slice(1));
  const text = positional.join(' ').trim();

  switch (cmd) {
    case 'status': return cmdStatus();
    case 'skills': return cmdSkills(text || opts.query);
    case 'plan': return cmdPlan(text, opts);
    case 'run': {
      const result = cmdRun(text, opts);
      if (!result.ok) process.exitCode = 1;
      return result;
    }
    case 'tick': {
      const result = cmdTick(opts);
      if (result.ok === false) process.exitCode = 1;
      return result;
    }
    case 'review': return cmdReview(positional[0], opts);
    case 'checkpoint': return cmdCheckpoint(text, opts);
    case 'rollback': return cmdRollback(positional[0], opts);
    case 'help':
    case undefined:
    case '--help':
    case '-h': return printHelp();
    default: throw new Error(`未知命令：${cmd}。运行 help 查看用法。`);
  }
}

try {
  main();
} catch (err) {
  console.error(`${C.red}错误：${C.reset}${err.message || err}`);
  process.exitCode = 1;
}
