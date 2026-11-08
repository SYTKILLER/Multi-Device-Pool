/**
 * 节点身份与状态目录（01 技术方案 §2.1 的 P0 最小版）。
 *
 * P0 简化（记录在案，P1 补全）：
 * - Ed25519 密钥对本地生成并持久化（P1 起由 root 签发节点凭证 + credstore 保护）。
 * - node_id = 公钥 DER 的 sha256 前 16 hex（规格：公钥哈希 16 hex 主键）。
 */
import { generateKeyPairSync, createHash, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface NodeIdentity {
  node_id: string;
  /** manifest 签名（canonical JSON, sha256 摘要即签名输入的编码） */
  sign(canonicalJson: string): string;
  publicKeyHex: string;
  verify(canonicalJson: string, sigHex: string): boolean;
}

export const defaultHome = (): string => process.env['MDP_HOME'] ?? path.join(os.homedir(), '.mdp');

/** canonical JSON：递归键排序（01 §1.3 trust digest 同款规则） */
export const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((v as Record<string, unknown>)[k])).join(',') + '}';
};

export const loadOrCreateIdentity = (home: string): NodeIdentity => {
  fs.mkdirSync(home, { recursive: true });
  const keyPath = path.join(home, 'node-key.json');
  let keyPem: string;
  if (fs.existsSync(keyPath)) {
    keyPem = (JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { pem: string }).pem;
  } else {
    keyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    // 节点私钥 P0 落盘于 home（P1 迁移到 credstore：DPAPI/Keychain，01 §1.2/§2.1）
    fs.writeFileSync(keyPath, JSON.stringify({ pem: keyPem }), { mode: 0o600 });
  }
  const priv = createPrivateKey(keyPem);
  const pubDer = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  const node_id = createHash('sha256').update(pubDer).digest('hex').slice(0, 16);
  return {
    node_id,
    publicKeyHex: pubDer.toString('hex'),
    sign: (canonical) => sign(null, Buffer.from(canonical, 'utf8'), priv).toString('hex'),
    verify: (canonical, sigHex) => verify(null, Buffer.from(canonical, 'utf8'), createPublicKey(priv), Buffer.from(sigHex, 'hex')),
  };
};
