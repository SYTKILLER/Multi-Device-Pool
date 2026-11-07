// V2b: 钉死 Windows 管道模式编码行为（chcp 为何失效 / pwsh7 前缀 / stderr 路径 / 真实场景 git）
import { execFileSync } from 'node:child_process';

const EXPECT = '中文测试-中文输出';
const check = (name, cmd, args) => {
  const buf = execFileSync(cmd, args, { encoding: 'buffer', timeout: 30000, windowsHide: true });
  const utf8 = buf.toString('utf8');
  console.log(`${utf8.includes(EXPECT) ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      -> ${JSON.stringify(utf8.trim().split(/\r?\n/).slice(0, 2))}`);
};

// 1) chcp 不带 >nul：看它是否真的切了页（有无 "Active code page"），输出仍否正确
check('cmd chcp 65001（无 >nul）', 'cmd', ['/d', '/s', '/c', 'chcp 65001 & echo ' + EXPECT]);

// 2) pwsh 7 + 前缀：预期 PASS（pwsh7 默认也 GBK → 前缀必须保留）
check('pwsh7 + OutputEncoding 前缀', 'pwsh', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output "' + EXPECT + '"']);

// 3) stderr 路径：PS5.1 前缀 + 原生命令写 stderr（spawnSync 才能分别拿两路）
import { spawnSync } from 'node:child_process';
const r3 = spawnSync('powershell', ['-NoProfile', '-Command',
  `[Console]::OutputEncoding=[Text.Encoding]::UTF8; cmd /c "echo ${EXPECT} 1>&2"`],
  { timeout: 30000, windowsHide: true });
console.log(`${r3.stderr && r3.stderr.toString('utf8').includes(EXPECT) ? 'PASS' : 'FAIL'}  PS5.1 前缀 + stderr 中文`);
console.log(`      -> stderr: ${JSON.stringify((r3.stderr ?? Buffer.alloc(0)).toString('utf8').trim().split(/\r?\n/).slice(0,2))}`);

// 4) 真实场景：git 输出中文（status 含未跟踪中文件名）
const fs = await import('node:fs');
const tmp = fs.mkdtempSync('mdp-v2b-git-');
const git = (args, opts = {}) => execFileSync('git', args, { cwd: tmp, timeout: 20000, ...opts });
git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
fs.writeFileSync(tmp + '/中文文件.txt', 'x');
const st = execFileSync('powershell', ['-NoProfile', '-Command',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; git status --short'],
  { encoding: 'buffer', cwd: tmp, timeout: 20000, windowsHide: true });
console.log(`${st.toString('utf8').includes('中文文件') ? 'PASS' : 'FAIL'}  git status 中文文件名（PS5.1 前缀）`);
console.log(`      -> ${JSON.stringify(st.toString('utf8').trim())}`);
fs.rmSync(tmp, { recursive: true, force: true });
