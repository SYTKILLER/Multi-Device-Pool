// V2: PowerShell/cmd 中文输出编码验证（01 文档 §4.2 / P1-4 修正的实证）
// 判定标准：node 以 utf8 解码子进程 stdout 后，能否原样取回中文。
import { execFileSync } from 'node:child_process';

const EXPECT = '中文测试-中文输出';
const cases = [
  { name: 'cmd 默认 codepage（预期乱码）', cmd: 'cmd', args: ['/d', '/s', '/c', `echo ${EXPECT}`] },
  { name: 'cmd + chcp 65001 包装', cmd: 'cmd', args: ['/d', '/s', '/c', `chcp 65001>nul & echo ${EXPECT}`] },
  { name: 'powershell 5.1 默认（预期乱码）', cmd: 'powershell', args: ['-NoProfile', '-Command', `Write-Output "${EXPECT}"`] },
  { name: 'powershell 5.1 + OutputEncoding 前缀', cmd: 'powershell', args: ['-NoProfile', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output "${EXPECT}"`] },
  { name: 'pwsh 7 默认', cmd: 'pwsh', args: ['-NoProfile', '-Command', `Write-Output "${EXPECT}"`] },
  { name: 'node 直接输出（基准）', cmd: 'node', args: ['-e', `console.log("${EXPECT}")`] },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const buf = execFileSync(c.cmd, c.args, { encoding: 'buffer', timeout: 30000, windowsHide: true });
  const utf8 = buf.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
  let gbk = '';
  try { gbk = new TextDecoder('gbk').decode(buf).trim().split(/\r?\n/).pop() ?? ''; } catch { gbk = '(gbk 解码不可用)'; }
  const ok = utf8.includes(EXPECT);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      utf8 解码: ${JSON.stringify(utf8)}`);
  console.log(`      gbk  解码: ${JSON.stringify(gbk)}`);
}
console.log(`\n== V2 结果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail > 0 ? 1 : 0);
