// V2: PowerShell/cmd 中文输出编码验证（01 文档 §4.2 / P1-4 修正的实证）
// 判定标准：node 以 utf8 解码子进程 stdout 后，能否原样取回中文。
// 2026-11-08 修订：负对照（cmd/PS 默认 GBK）是 V2 的**已记录发现**而非失败——
// 断言改为「实测是否与 docs/verification-p0.md V2 表一致」，全部一致才 exit 0，
// 使 npm run verify 的 && 链能继续（此前负对照导致链路中断）。
import { execFileSync } from 'node:child_process';

const EXPECT = '中文测试-中文输出';
const cases = [
  { name: 'cmd 默认 codepage', expect: 'gbk', cmd: 'cmd', args: ['/d', '/s', '/c', `echo ${EXPECT}`] },
  { name: 'cmd + chcp 65001 包装（管道模式无效——V2 核心发现）', expect: 'gbk', cmd: 'cmd', args: ['/d', '/s', '/c', `chcp 65001>nul & echo ${EXPECT}`] },
  { name: 'powershell 5.1 默认', expect: 'gbk', cmd: 'powershell', args: ['-NoProfile', '-Command', `Write-Output "${EXPECT}"`] },
  { name: 'powershell 5.1 + OutputEncoding 前缀（唯一有效通路）', expect: 'utf8', cmd: 'powershell', args: ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output "${EXPECT}"`] },
  { name: 'pwsh 7 默认（管道下也 GBK）', expect: 'gbk', cmd: 'pwsh', args: ['-NoProfile', '-Command', `Write-Output "${EXPECT}"`] },
  { name: 'node 直接输出（基准）', expect: 'utf8', cmd: 'node', args: ['-e', `console.log("${EXPECT}")`] },
];

let pass = 0, fail = 0, skipped = 0;
for (const c of cases) {
  let buf;
  try {
    buf = execFileSync(c.cmd, c.args, { encoding: 'buffer', timeout: 30000, windowsHide: true });
  } catch (e) {
    if (e?.code === 'ENOENT') {
      skipped++;
      console.log(`SKIP  ${c.name}（${c.cmd} 不在 PATH）`);
      continue;
    }
    throw e;
  }
  const utf8 = buf.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
  let gbk = '';
  try { gbk = new TextDecoder('gbk').decode(buf).trim().split(/\r?\n/).pop() ?? ''; } catch { gbk = '(gbk 解码不可用)'; }
  const ok = c.expect === 'utf8' ? utf8.includes(EXPECT) : !utf8.includes(EXPECT) && gbk.includes(EXPECT);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}（预期 ${c.expect === 'utf8' ? 'UTF-8 直读' : '需按 GBK 解码'}）`);
  console.log(`      utf8 解码: ${JSON.stringify(utf8)}`);
  console.log(`      gbk  解码: ${JSON.stringify(gbk)}`);
}
console.log(`\n== V2 结果: ${pass} PASS / ${fail} FAIL / ${skipped} SKIP（与已记录发现的一致性断言） ==`);
process.exit(fail > 0 ? 1 : 0);
