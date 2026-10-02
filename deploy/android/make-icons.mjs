// 生成启动图标 PNG（不依赖任何图像库：手写最小 PNG 编码器 + 逐像素绘制）。
//
// 设计：圆角方形底（深紫 → 粉的竖向渐变）+ 中间一颗心。跟应用的深色/粉色主题一致。
// 输出到 apk/res/mipmap-<density>/ic_launcher.png 与 ic_launcher_round.png。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(size*size*4) → PNG buffer */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 心形隐函数（<=0 在内部） */
function heart(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y;
}

function render(size, { round = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = round ? size / 2 : size * 0.22;
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  // 圆角方形 + 4x 超采样抗锯齿
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inside = 0, heartHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS, y = py + (sy + 0.5) / SS;
          // 圆角矩形（round 时是正圆）
          const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
          const half = size / 2;
          let inShape;
          if (round) {
            inShape = (dx * dx + dy * dy) <= (half - 0.5) * (half - 0.5);
          } else {
            const ex = Math.max(dx - (half - radius - 0.5), 0);
            const ey = Math.max(dy - (half - radius - 0.5), 0);
            inShape = (ex * ex + ey * ey) <= radius * radius && dx < half - 0.5 && dy < half - 0.5;
          }
          if (!inShape) continue;
          inside++;
          // 心形：把像素坐标映射到 [-1.25, 1.25]，y 轴翻转
          const hx = ((x - cx) / half) * 1.35;
          const hy = -((y - cy) / half) * 1.35 + 0.12;
          if (heart(hx, hy) <= 0) heartHits++;
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (inside === 0) continue;
      const cov = inside / total;
      const t = py / size;
      // 底：深紫 → 粉
      let r = Math.round(38 + t * 190), g = Math.round(20 + t * 60), b = Math.round(64 + t * 90);
      const hcov = heartHits / total;
      if (hcov > 0) {
        // 心：接近白的暖粉
        r = Math.round(r * (1 - hcov) + 255 * hcov);
        g = Math.round(g * (1 - hcov) + 236 * hcov);
        b = Math.round(b * (1 - hcov) + 244 * hcov);
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(255 * cov);
    }
  }
  return encodePng(size, rgba);
}

const root = process.argv[2];
if (!root) {
  console.error('用法: node make-icons.mjs <apk 目录>');
  process.exit(2);
}
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [name, size] of Object.entries(DENSITIES)) {
  const dir = path.join(root, 'res', `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), render(size));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), render(size, { round: true }));
  console.log(`icon ${name} ${size}x${size}`);
}
