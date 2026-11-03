// Oscura segreti comuni prima di salvare o mostrare testi prodotti dagli agenti.
const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[a-zA-Z0-9_-]{10,}/g, 'sk-ant-***'],
  [/\bsk-[a-zA-Z0-9]{20,}/g, 'sk-***'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, 'gh*_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[chiave privata oscurata]'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=***'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}… [troncato, ${text.length - max} caratteri]` : text;
}
