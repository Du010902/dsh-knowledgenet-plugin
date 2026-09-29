/**
 * UUID v7 形状的标识生成
 *
 * **正式知识库的 ID 一律由 Rust 发号**（UUIDv7，时间有序）。
 * 前端只在两个不该碰持久层的场景里需要自己造 ID：
 * 1. 浏览器演示后端（localStorage，不是便携知识库）；
 * 2. 导入图交换格式时给重号/缺失的 ID 重新编号（导入的旧文件里可能是 n1 这类顺序 ID）。
 *
 * 因此这里刻意不做任何 ID 分配策略，只生成不与已有值冲突的字符串。
 */

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 生成 UUIDv7 形状的字符串：前 48 位是毫秒时间戳，后面是随机位。
 * 形状与 Rust 侧一致，便于导入导出后人工辨认（`isUuid` 只检查形状，不解释内容）。
 */
export function newUuid(now = Date.now()): string {
  const time = Math.max(0, Math.trunc(now)) % 2 ** 48;
  const timeHex = time.toString(16).padStart(12, "0");
  const randHex = hex(randomBytes(10));
  const p1 = timeHex.slice(0, 8);
  const p2 = timeHex.slice(8, 12);
  const p3 = `7${randHex.slice(0, 3)}`;
  const variant = ((Number.parseInt(randHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  const p4 = `${variant}${randHex.slice(4, 7)}`;
  const p5 = randHex.slice(7, 19);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/** 生成一个不与 `used` 冲突的 ID（导入重编号时用） */
export function newUniqueUuid(used: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = newUuid();
    if (!used.has(candidate)) return candidate;
  }
  // 极端情况下（随机源被替换成常量）退化为带序号的后缀，仍然保证唯一
  let suffix = 0;
  let candidate = newUuid();
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${candidate}-${suffix}`;
  }
  return candidate;
}
