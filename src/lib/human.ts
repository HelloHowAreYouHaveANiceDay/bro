export async function humanPause(minMs = 120, maxMs = 320): Promise<void> {
  const floor = Math.max(0, Math.floor(minMs));
  const ceiling = Math.max(floor, Math.floor(maxMs));
  const span = ceiling - floor;
  const delay = floor + Math.floor(Math.random() * (span + 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}
