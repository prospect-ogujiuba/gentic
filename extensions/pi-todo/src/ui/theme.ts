export type TodoTheme = {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
};

const RESET = "\x1b[0m";

// Exact legacy Gentic Duo Moss palette from .docs/gentic-legacy/themes/gentic-duo-moss.json.
const LEGACY_COLORS: Record<string, string> = {
  accent: "#8FBF9A",
  border: "#29372E",
  borderMuted: "#1E2923",
  success: "#93C88D",
  error: "#C98578",
  warning: "#C7B46A",
  muted: "#7F8D84",
  dim: "#5A685F",
  text: "#D6DDD8",
  selectedBg: "#202D25",
  syntaxComment: "#6F7D73",
  syntaxString: "#BDB47C",
};

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function fgCode(color: string): string | undefined {
  const hex = LEGACY_COLORS[color];
  if (!hex) return undefined;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgCode(color: string): string | undefined {
  const hex = LEGACY_COLORS[color];
  if (!hex) return undefined;
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function colorize(code: string | undefined, text: string): string {
  return code ? `${code}${text}${RESET}` : text;
}

export const ansiTodoTheme: TodoTheme = {
  fg: (color, text) => colorize(fgCode(color), text),
  bg: (color, text) => colorize(bgCode(color), text),
  bold: (text) => `\x1b[1m${text}${RESET}`,
};

export const plainTodoTheme: TodoTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};
