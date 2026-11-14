export function summarize(bytes) {
  try { const value = JSON.parse(bytes); return { format: 'source-catalog', source: value.source || null, byteLength: bytes.length }; } catch { return { format: 'raw', byteLength: bytes.length }; }
}
