/**
 * ULID：节点 v3 的唯一标识（时间有序 + 随机后缀）。
 *
 * 为什么用它（用户选定 ✓）：26 个字符、按时间自然有序、无需中央协调、碰撞概率可忽略；
 * 而且它**与标题/文件名无关** ✓ —— 改标题、重命名文件、两个节点同名，都不会改变身份 ✓。
 *
 * 实现说明：零依赖 ⇒ 自己按规范拼：48 位毫秒时间戳 + 80 位随机数，Crockford Base32 编码。
 */
import { randomBytes } from "node:crypto";

/** Crockford Base32（去掉容易看混的 I L O U） */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** 48 位时间戳能表示到 10889 年，ULID 规范限制在这个范围内 */
const MAX_TIME = 281474976710655;

/**
 * 生成一个 ULID。
 * @param now - 毫秒时间戳（默认当前时间；测试可注入）。
 * @returns 26 字符的 ULID。
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(Number.isFinite(now) ? now : Date.now());
  if (time < 0) time = 0;
  if (time > MAX_TIME) time = MAX_TIME;

  // 时间部分：10 个字符（48 位）
  let timePart = "";
  let remaining = time;
  for (let i = 0; i < TIME_CHARS; i += 1) {
    timePart = ALPHABET[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }

  // 随机部分：16 个字符（80 位）
  const bytes = randomBytes(10);
  let randomPart = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      randomPart += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  // 10 字节 = 80 位正好 16 个字符，这里补齐以防实现细节差异
  while (randomPart.length < RANDOM_CHARS) randomPart += ALPHABET[0];

  return timePart + randomPart.slice(0, RANDOM_CHARS);
}

/**
 * 判断一个字符串像不像 ULID（26 字符、全在字母表内）。
 * 用于"id 与文件名/标题无关"的校验，以及数据自检。
 * @param value - 待判断的字符串。
 * @returns 是否形如 ULID。
 */
export function isUlid(value: string): boolean {
  if (typeof value !== "string" || value.length !== TIME_CHARS + RANDOM_CHARS) return false;
  for (const char of value) {
    if (!ALPHABET.includes(char)) return false;
  }
  return true;
}
