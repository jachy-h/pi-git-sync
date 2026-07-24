/**
 * 简易的 glob/minimatch 实现
 *
 * 仅支持 gitignore 风格的基本模式：
 * - * 匹配任意字符（不包括 /）
 * - ** 匹配任意字符（包括 /）
 * - ? 匹配单个字符
 * - 不支持字符类 [...]
 */
export function minimatch(str: string, pattern: string): boolean {
  // 如果 pattern 以 / 开头，只从开头匹配
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  // 如果 pattern 包含 **，使用正则匹配
  return minimatchRecursive(str, 0, pattern, 0);
}

function minimatchRecursive(
  str: string,
  si: number,
  pattern: string,
  pi: number,
): boolean {
  // 都到了末尾
  if (si === str.length && pi === pattern.length) return true;
  // pattern 结束但字符串还有内容
  if (pi === pattern.length) return false;
  // 字符串结束但 pattern 还有内容
  if (si === str.length) {
    // 剩余的 pattern 必须都是 * 或 **
    while (pi < pattern.length) {
      if (pattern[pi] === "*") {
        if (pi + 1 < pattern.length && pattern[pi + 1] === "*") {
          pi += 2;
        } else {
          pi++;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  const pc = pattern[pi]!;

  if (pi + 1 < pattern.length && pc === "*" && pattern[pi + 1] === "*") {
    // ** 匹配任意内容（包括 /）
    // 跳过 pattern 中的连续 **/ 组合
    let nextPi = pi + 2;
    // 跳过 ** 后面的 /
    if (nextPi < pattern.length && pattern[nextPi] === "/") {
      nextPi++;
    }

    // ** 可以匹配 0 个或多个字符
    for (let i = si; i <= str.length; i++) {
      if (minimatchRecursive(str, i, pattern, nextPi)) {
        return true;
      }
      // 如果到了字符串末尾或遇到了需要精确匹配的情况
    }
    return false;
  }

  if (pc === "*") {
    // * 匹配任意字符（不包括 /）
    for (let i = si; i <= str.length; i++) {
      // 不能跨 /
      if (i > si && str[i - 1] === "/") {
        break;
      }
      if (minimatchRecursive(str, i, pattern, pi + 1)) {
        return true;
      }
    }
    return false;
  }

  if (pc === "?") {
    return str[si] !== "/" && minimatchRecursive(str, si + 1, pattern, pi + 1);
  }

  // 普通字符，必须精确匹配
  if (str[si] === pc) {
    return minimatchRecursive(str, si + 1, pattern, pi + 1);
  }

  return false;
}
