// 生成 BuildInfo.java（载荷内容哈希当版本戳）。
//
// 为什么不写在 PowerShell 里：Windows PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
// 而 javac 碰到源码里的 U+FEFF 会直接报 illegal character。这里统一由 Node 写 UTF-8 无 BOM。
//
// 用法: node lib/gen-buildinfo.mjs <payload.zip> <输出目录> <appVersion>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [payloadZip, outDir, appVersion] = process.argv.slice(2);
if (!payloadZip || !outDir || !appVersion) {
  console.error('用法: node lib/gen-buildinfo.mjs <payload.zip> <输出目录> <appVersion>');
  process.exit(2);
}
const digest = crypto.createHash('sha256').update(fs.readFileSync(payloadZip)).digest('hex').slice(0, 16);
const code = appVersion.split('.').slice(0, 3).reduce((acc, part) => acc * 100 + Number(part), 0);

const target = path.join(outDir, 'dev', 'companion', 'agent');
fs.mkdirSync(target, { recursive: true });
const source = `package dev.companion.agent;

/** 由 deploy/android/lib/gen-buildinfo.mjs 生成 —— 载荷内容哈希。不要手改。 */
final class BuildInfo {
    static final String PAYLOAD_VERSION = "${digest}";
    static final String APP_VERSION = "${appVersion}";
    static final int APP_VERSION_CODE = ${code};
}
`;
fs.writeFileSync(path.join(target, 'BuildInfo.java'), source, 'utf8');
console.log(`   payload=${digest} app=${appVersion} code=${code}`);
