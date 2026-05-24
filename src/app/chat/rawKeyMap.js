function keyToRaw(ch, key) {
  if (ch && ch.length === 1) return ch;
  if (!key) return null;

  switch (key.name) {
    case "return":
    case "enter":
      return "\r";
    case "backspace":
      return "\x7f";
    case "tab":
      return "\t";
    case "escape":
      return "\x1b";
    case "up":
      return "\x1b[A";
    case "down":
      return "\x1b[B";
    case "right":
      return "\x1b[C";
    case "left":
      return "\x1b[D";
    case "home":
      return "\x1b[H";
    case "end":
      return "\x1b[F";
    case "pageup":
      return "\x1b[5~";
    case "pagedown":
      return "\x1b[6~";
    case "delete":
      return "\x1b[3~";
    case "insert":
      return "\x1b[2~";
    default:
      return ch || null;
  }
}

module.exports = {
  keyToRaw,
};
