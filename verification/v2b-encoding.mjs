// V2b: 钉死 Windows 管道模式编码行为（chcp 为何失效 / pwsh7 前缀 / stderr 路径 / 真实场景 git）
// 2026-11-09 修订：与 v2 同款——断言「实测与已记录发现一致」而非裸展示，
// 消除 verify 输出中的误导性 FAIL（此前 2 行 FAIL 均为预期形态：chcp 失效演示 + git quotepath 行为）。
// 判定基准（docs/verification-p0.md V2 表 + 本文件历史证据）：
//   ① cmd chcp 65001 管道无效 → utf8 直读必然乱码（FAIL 即发现本身）
//   ② PS5.1/pwsh7 + OutputEncoding 前缀 → stdout/stderr 双路 UTF-8（唯一有效通路）
//   ③ git 非 ASCII 文件名默认八进制转义（core.quotepath 行为，非编码）→ -c core.quotepath=false 可解
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const EXPECT = '中文测试-中文输出';
let pass = 0, fail = 0;
const judge = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      -> ${detail}`);
};

// ① chcp 65001（无 >nul）：报告切页成功但输出仍 GBK —— 断言"确实乱码"（发现复现）
{
  const buf = execFileSync('cmd', ['/d', '/s', '/c', `chcp 65001 & echo ${EXPECT}`], { encoding: 'buffer', timeout: 30000, windowsHide: true });
  const utf8 = buf.toString('utf8');
  judge('① cmd chcp 65001 管道无效（chcp 报成功、输出仍 GBK——发现复现）',
    !utf8.includes(EXPECT), `utf8 直读不应含原文，实得 ${JSON.stringify(utf8.trim().slice(0, 60))}`);
}

// ② pwsh7 + 前缀（pwsh7 默认管道也 GBK → 前缀必须保留）
{
  const buf = execFileSync('pwsh', ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output "${EXPECT}"`], { encoding: 'buffer', timeout: 30000, windowsHide: true });
  judge('② pwsh7 + OutputEncoding 前缀 → UTF-8', buf.toString('utf8').includes(EXPECT), JSON.stringify(buf.toString('utf8').trim().slice(0, 60)));
}

// ③ PS5.1 前缀 + 原生命令写 stderr（双路验证）
{
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; cmd /c "echo ${EXPECT} 1>&2"`],
    { timeout: 30000, windowsHide: true });
  judge('③ PS5.1 前缀 + stderr 中文（双路）', (r.stderr ?? Buffer.alloc(0)).toString('utf8').includes(EXPECT),
    JSON.stringify((r.stderr ?? Buffer.alloc(0)).toString('utf8').trim().slice(0, 60)));
}

// ④ git 非 ASCII 文件名：默认八进制转义（core.quotepath 行为）+ -c core.quotepath=false 可解
{
  const tmp = fs.mkdtempSync('mdp-v2b-git-');
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: tmp, timeout: 20000, ...opts });
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  fs.writeFileSync(tmp + '/中文文件.txt', 'x');
  const stDefault = execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; git status --short'],
    { encoding: 'buffer', cwd: tmp, timeout: 20000, windowsHide: true }).toString('utf8');
  const octal = /\\\d{3}(\\\d{3})+/.test(stDefault); // "\344\270\255..." 形态（首组同样带反斜杠）
  const stFixed = execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; git -c core.quotepath=false status --short'],
    { encoding: 'buffer', cwd: tmp, timeout: 20000, windowsHide: true }).toString('utf8');
  judge('④ git quotepath：默认八进制转义（发现复现）+ core.quotepath=false 解',
    octal && stFixed.includes('中文文件.txt'),
    `default=${JSON.stringify(stDefault.trim().slice(0, 60))} fixed=${JSON.stringify(stFixed.trim().slice(0, 60))}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n== V2b 结果: ${pass} PASS / ${fail} FAIL（与已记录发现的一致性断言） ==`);
process.exit(fail > 0 ? 1 : 0);
