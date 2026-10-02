// 下载全部构建依赖（构建第 1 步）。每个条目可以有多个候选 URL，依次尝试。
//
// ── 依赖从哪来（2026-10 实测；❌ 的域名在本机是超时的） ──────────────────────
//   ✅ nodejs.org                    官方 Node 24 linux-arm64 tarball
//   ✅ mirrors.tuna.tsinghua.edu.cn  清华镜像：ubuntu-base arm64（官方源 cdimage.ubuntu.com 的镜像）
//   ✅ dl.google.com                 Google：Android build-tools（aapt2/d8/apksigner/zipalign）、platform-28
//   ✅ cdn.azul.com                  Azul Zulu JDK 17（Windows x64，绿色版）
//   ✅ registry.npmjs.org            npm 依赖（第 2 步用）
//   ✅ api.github.com                参考实现 dsh-android 的源码/资产（github.com 直连超时）
//   ❌ github.com / raw.githubusercontent.com / objects.githubusercontent.com（间歇）
//        → 这就是为什么 JDK 必须走 Azul 的 CDN 直链：Adoptium 的 binary 端点会 302 到 github.com。
//          脚本里仍保留 Adoptium 作为最后一个候选，网络通的地方会自动用上。
import fs from 'node:fs';
import path from 'node:path';

const DL = process.env.DL_DIR || 'E:/android-build/dl';
fs.mkdirSync(DL, { recursive: true });

const ITEMS = [
  {
    name: 'jdk17.zip',
    // Adoptium 17.0.20.1_1 = 190817615，Zulu 17.46.19 = 195205127，MS 17.0.13 = 186360891
    sizes: [190817615, 195205127, 186360891],
    urls: [
      'https://cdn.azul.com/zulu/bin/zulu17.46.19-ca-jdk17.0.9-win_x64.zip',
      'https://aka.ms/download-jdk/microsoft-jdk-17.0.13-windows-x64.zip',
      'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse',
    ],
  },
  {
    name: 'build-tools_r34-windows.zip',
    sizes: [58090722, 58253258],
    urls: ['https://dl.google.com/android/repository/build-tools_r34-windows.zip'],
  },
  {
    name: 'platform-28_r06.zip',
    sizes: [72222658, 75565084],
    urls: ['https://dl.google.com/android/repository/platform-28_r06.zip'],
  },
  {
    name: 'node-v24.13.0-linux-arm64.tar.xz',
    sizes: [],
    urls: ['https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-arm64.tar.xz'],
  },
  {
    name: 'ubuntu-base-24.04.5-base-arm64.tar.gz',
    sizes: [],
    urls: [
      'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz',
    ],
  },
];

/**
 * 内容自检：按扩展名验证归档完整性。
 *
 * 为什么不能只比 content-length：dl.google.com 会用 gzip 传输（Content-Encoding: gzip），
 * 此时 content-length 是**压缩后**的长度，而 fetch 会自动解压 —— 收到的字节数比它大，
 * 一刀切比长度会把好文件判成坏的（这里踩过一次）。
 */
function check(name, file) {
  const blob = fs.readFileSync(file);
  if (blob.length < 1024) throw new Error('文件太小: ' + blob.length);
  if (name.endsWith('.zip')) {
    let eocd = -1;
    for (let i = blob.length - 22; i >= 0; i--) {
      if (blob.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
    if (blob.readUInt32LE(0) === 0x04034b50 || true) {
      const cdOffset = blob.readUInt32LE(eocd + 16);
      if (blob.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('中央目录签名不对，zip 不完整');
    }
  } else if (name.endsWith('.tar.gz')) {
    // gzip 魔数 1F 8B；完整性与 CRC 交给 WSL 侧的 `gzip -t`（Node 没有内置 gzip 容器校验）
    if (blob[0] !== 0x1F || blob[1] !== 0x8B) throw new Error('不是 gzip 流');
  } else if (name.endsWith('.tar.xz')) {
    // xz 魔数 FD 37 7A 58 5A 00 —— 注意不能用 toString('ascii') 比，ascii 解码会把 0xFD 掩成 0x7D
    const XZ = Buffer.from([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]);
    if (!blob.subarray(0, 6).equals(XZ)) {
      throw new Error('不是 xz 流，头 6 字节 = ' + blob.subarray(0, 6).toString('hex'));
    }
    // 流尾是 4 字节对齐填充 + 'YZ'（0x59 0x5A）
    if (blob[blob.length - 2] !== 0x59 || blob[blob.length - 1] !== 0x5A) {
      throw new Error('xz 尾部填充不对，可能被截断');
    }
  }
  return blob.length;
}

async function pull(url, dst) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 900000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const declared = Number(r.headers.get('content-length') || 0);
    const encoded = r.headers.get('content-encoding');
    const out = fs.createWriteStream(dst);
    let got = 0, lastLog = Date.now();
    for await (const chunk of r.body) {
      out.write(chunk);
      got += chunk.length;
      if (Date.now() - lastLog > 15000) {
        console.log(`   … ${(got / 1048576).toFixed(1)} MB`);
        lastLog = Date.now();
      }
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    if (declared && !encoded && got !== declared) {
      throw new Error(`下载不完整 ${got}/${declared}`);
    }
    return { got, declared, encoded };
  } finally {
    clearTimeout(timer);
  }
}

let failed = 0;
for (const item of ITEMS) {
  const dst = path.join(DL, item.name);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
    try {
      const size = check(item.name, dst);
      console.log('SKIP(已存在且完整)', item.name, size);
      continue;
    } catch (e) {
      console.log('已存在但不可用，重下：', item.name, e.message);
      fs.rmSync(dst, { force: true });
    }
  }
  let done = false;
  for (const url of item.urls) {
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      const tmp = dst + '.part';
      try {
        fs.rmSync(tmp, { force: true });
        console.log(`GET ${item.name} <- ${url} (try ${attempt})`);
        const { got, declared, encoded } = await pull(url, tmp);
        const size = check(item.name, tmp);
        fs.renameSync(tmp, dst);
        console.log(`OK  ${item.name} ${size} 字节` +
          (encoded ? `（传输编码 ${encoded}，声明长度 ${declared}）` : ''));
        done = true;
      } catch (e) {
        console.log(`FAIL ${item.name}: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}`);
        fs.rmSync(tmp, { force: true });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (done) break;
  }
  if (!done) { failed++; console.log('GIVEUP', item.name); }
}
console.log(failed === 0 ? 'ALL DONE' : `DONE WITH ${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
