export function safeDisplay(value: string, maximumCharacters = 240): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1) {
    throw new RangeError("maximumCharacters must be a positive integer");
  }

  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n") {
      escaped += "\\n";
    } else if (character === "\r") {
      escaped += "\\r";
    } else if (character === "\t") {
      escaped += "\\t";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    } else if (
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
    if (escaped.length > maximumCharacters) {
      return `${escaped.slice(0, maximumCharacters)}...`;
    }
  }
  return escaped;
}
