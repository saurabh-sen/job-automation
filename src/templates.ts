/**
 * Character limits for the Wellfound and Work at a Startup application messages.
 * Conservative placeholders: verify the real limits in M5 (Wellfound) and M6 (Work at a Startup).
 */
export const TEMPLATE_LIMITS: { wellfound: number; workatastartup: number } = {
  wellfound: 1000,
  workatastartup: 1000,
};

const VARS = ['firstName', 'company', 'role'] as const;

/**
 * Fills {firstName}, {company} and {role}, normalises whitespace and keeps the message within maxChars,
 * trimming at a sentence end (or else a word boundary). Throws on an unknown {placeholder}.
 */
export function fillTemplate(tpl: string, vars: { firstName: string; company: string; role: string }, maxChars: number): string {
  const values: Record<(typeof VARS)[number], string> = {
    firstName: vars.firstName.trim(),
    company: vars.company.trim() || 'your company',
    role: vars.role.trim() || 'open',
  };
  // Check the template itself (not the filled text, which may legitimately contain braces from a company name).
  const bad = tpl.match(/\{[^{}]*\}/g)?.find((m) => !VARS.some((v) => m === `{${v}}`));
  if (bad) throw new Error(`Unknown template placeholder ${bad}`);
  const filled = tpl.replace(/\{(firstName|company|role)\}/g, (_, name: (typeof VARS)[number]) => values[name]);
  return truncate(normalizeWhitespace(filled), maxChars);
}

/** Single newlines (YAML hard wraps) become spaces; blank lines stay as paragraph breaks. */
function normalizeWhitespace(s: string): string {
  return s
    .split(/\n[ \t]*\n\s*/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  // Last sentence end within the limit that is followed by whitespace in the full text (so "Node.js" is not a sentence end).
  for (let i = head.length - 1; i > 0; i--) {
    if (/[.!?]/.test(head[i]) && (i + 1 === s.length || /\s/.test(s[i + 1]))) return head.slice(0, i + 1).trim();
  }
  // Otherwise the last word boundary.
  if (/\s/.test(s[max])) return head.trim();
  const space = head.search(/\s\S*$/);
  if (space > 0) return head.slice(0, space).trim();
  // A single word longer than the limit: nothing better is possible.
  return head;
}
