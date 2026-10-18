/**
 * 访问保护管理工具（服务端管理员 CLI）
 *
 * 用法：npm run auth:manage -- <命令> [选项]
 *   status            查询密码保护状态
 *   set               首次启用 / 重置密码（交互式输入，或用 TODO_AUTH_NEW_PASSWORD）
 *   change            修改密码（已启用时需提供当前密码）
 *   disable           关闭密码保护（已启用时需提供当前密码）
 *   kick              不改密码，强制所有已登录设备重新登录
 * 选项：
 *   --yes             跳过覆盖式操作的确认提示（自动化场景）
 *   --json            status 输出 JSON
 *
 * 环境变量（用于脚本/Docker 自动化，优先于交互输入）：
 *   TODO_AUTH_NEW_PASSWORD     set / change 的目标密码
 *   TODO_AUTH_CURRENT_PASSWORD change / disable 的当前密码
 *
 * 注意：为了不把密码暴露在进程列表与 shell 历史里，本工具不接受
 * 命令行参数形式的密码；交互输入全程不回显。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const auth = require('./auth.js');

const COMMANDS = new Set(['status', 'set', 'change', 'disable', 'kick']);

function usage() {
  return `访问保护管理工具
用法: npm run auth:manage -- <命令> [选项]

命令:
  status    查询密码保护状态
  set       首次启用 / 重置密码（已启用时覆盖需确认）
  change    修改密码（已启用时需先提供当前密码）
  disable   关闭密码保护（已启用时需提供当前密码）
  kick      不改密码，强制所有已登录设备重新登录

选项:
  --yes     跳过覆盖式操作的确认提示
  --json    status 输出 JSON

自动化环境变量（优先于交互输入）:
  TODO_AUTH_NEW_PASSWORD      set / change 的目标密码
  TODO_AUTH_CURRENT_PASSWORD  change / disable 的当前密码

示例:
  npm run auth:manage -- status
  npm run auth:manage -- set
  TODO_AUTH_NEW_PASSWORD=your-pass TODO_AUTH_CURRENT_PASSWORD=old-pass npm run auth:manage -- change --yes
  docker compose exec app node manageAuth.js status --json`;
}

function parseArgs(argv) {
  const flags = { yes: false, json: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else positional.push(arg);
  }
  return { command: positional[0] || null, flags };
}

// ── 终端输入 ─────────────────────────────────────────────
// raw 模式逐字节处理：不回显明文，用圆点替代；支持退格、Ctrl-C 退出。
function promptHidden(questionText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('非交互终端无法安全输入密码，请通过对应环境变量提供或使用交互终端'));
      return;
    }
    process.stdout.write(questionText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let chars = '';
    const decoder = new TextDecoder('utf-8');
    const ondata = chunk => {
      const text = decoder.decode(chunk, { stream: true });
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(chars);
          return;
        }
        if (ch === '\x03') {
          finish();
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\x08') {
          chars = [...chars].slice(0, -1).join('');
        } else if (ch.charCodeAt(0) >= 32) {
          chars += ch;
        }
        render();
      }
    };
    const render = () => {
      process.stdout.write(`\r\x1b[0K${questionText}${'•'.repeat([...chars].length)}`);
    };
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', ondata);
      process.stdout.write('\n');
    };
    process.stdin.on('data', ondata);
  });
}

function promptVisible(questionText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('非交互终端无法进行确认输入，请加 --yes 跳过或使用交互终端'));
      return;
    }
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    rl.question(questionText).then(answer => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (!normalized || normalized === 'n' || normalized === 'no' || normalized === '否') {
        resolve(false);
      } else {
        resolve(true);
      }
    }, err => {
      rl.close();
      reject(err);
    });
  });
}

async function readPassword(label, envName, confirmWith) {
  const envValue = process.env[envName];
  if (typeof envValue === 'string' && envValue.length > 0) return envValue;
  const answer = await promptHidden(label);
  if (confirmWith) {
    const again = await promptHidden(confirmWith);
    if (again !== answer) throw new Error('两次输入的密码不一致，请重试');
  }
  return answer;
}

// ── 命令实现 ─────────────────────────────────────────────
function commandStatus({ json }) {
  const enabled = auth.enabled();
  const stateEpoch = enabled ? readEpoch() : null;
  const info = {
    enabled,
    epoch: stateEpoch,
    cookieName: auth.COOKIE_NAME,
    rememberDays: 30,
    sessionMaxHours: 12,
    files: {
      authFile: auth.AUTH_FILE,
      authFileExists: fs.existsSync(auth.AUTH_FILE),
      authKeyFile: auth.AUTH_KEY_FILE,
      authKeyFileExists: fs.existsSync(auth.AUTH_KEY_FILE),
    },
  };
  if (json) {
    console.log(JSON.stringify(info, null, 2));
  } else if (enabled) {
    console.log(`密码保护已启用（epoch=${info.epoch}，配置 ${info.files.authFileExists ? '存在' : '缺失'}）。`);
  } else {
    console.log('访问保护未启用。可在配置中心「🔐 访问控制」开启，或直接执行 set 命令。');
  }
}

function readEpoch() {
  try {
    return JSON.parse(fs.readFileSync(auth.AUTH_FILE, 'utf8'))?.epoch ?? null;
  } catch (_) {
    return null;
  }
}

async function commandSet({ yes }) {
  const currentlyEnabled = auth.enabled();
  if (currentlyEnabled && !yes) {
    const proceed = await promptVisible('密码保护已启用，继续将覆盖现有密码且所有已登录设备需重新登录。继续？(y/N) ');
    if (!proceed) {
      console.log('已取消。');
      return;
    }
  }
  const newPassword = await readPassword('设置访问密码：', 'TODO_AUTH_NEW_PASSWORD', '确认访问密码：');
  const result = auth.setPassword(newPassword);
  console.log(`✅ 访问密码已${currentlyEnabled ? '重置' : '设置'}并启用（所有已登录设备将需要重新登录）。`);
  return result;
}

async function commandChange() {
  const currentPassword = await readPassword('当前密码：', 'TODO_AUTH_CURRENT_PASSWORD');
  const newPassword = await readPassword('新密码：', 'TODO_AUTH_NEW_PASSWORD', '确认新密码：');
  const result = auth.changePassword(currentPassword, newPassword);
  console.log('✅ 访问密码已更新（所有已登录设备将需要重新登录）。');
  return result;
}

async function commandDisable() {
  if (!auth.enabled()) {
    console.log('访问保护未启用，无需操作。');
    return;
  }
  const currentPassword = await readPassword('当前密码：', 'TODO_AUTH_CURRENT_PASSWORD');
  const result = auth.disable(currentPassword);
  console.log('✅ 访问保护已关闭，页面与 API 恢复匿名访问。');
  return result;
}

function commandKick() {
  const result = auth.forceLogoutAll();
  if (result.enabled) {
    console.log('✅ 已强制所有设备重新登录（密码未变更，epoch 已推进）。');
  } else {
    console.log('访问保护未启用，但会话密钥已轮换（epoch 已推进）。');
  }
  return result;
}

(async () => {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !command) {
    console.log(usage());
    return;
  }
  if (!COMMANDS.has(command)) {
    console.error(`未知命令：${command}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  switch (command) {
    case 'status': return commandStatus(flags);
    case 'set': return commandSet(flags);
    case 'change': return commandChange();
    case 'disable': return commandDisable();
    case 'kick': return commandKick();
    default:
      console.error(usage());
      process.exitCode = 1;
  }
})().catch(e => {
  if (e && e.message && e.message.includes('密码不正确')) {
    console.error('❌ ' + e.message);
    process.exitCode = 1;
    return;
  }
  console.error('❌ ' + (e?.message || e));
  process.exitCode = 1;
});
