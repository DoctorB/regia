// Avvisi del browser che arrivano come errori ma non indicano un problema di Regia: non vengono segnalati.
const IGNORED = [
  /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i,
];

export const isIgnoredUiError = (message: string) => IGNORED.some((re) => re.test(message.trim()));
