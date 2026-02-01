/**
 * 문자열의 "표시 너비"를 대략 계산한다.
 *
 * - CJK/전각/이모지 계열은 2칸으로, variation selector는 0칸으로 본다.
 * - 그 외 문자는 1칸으로 계산한다.
 * - CLI 박스/정렬용 간이 계산이므로 완전한 유니코드 폭 구현은 아니다.
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    // Variation selectors are zero-width
    if (code >= 0xfe00 && code <= 0xfe0f) {
      continue;
    }
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth forms (currency, arrows)
      (code >= 0x3300 && code <= 0x33ff) || // CJK Compatibility
      (code >= 0x1f300 && code <= 0x1f9ff) || // Emoji ranges (commonly width 2)
      (code >= 0x20000 && code <= 0x2fa1f)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}
