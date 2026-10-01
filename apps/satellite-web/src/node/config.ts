/** `p2p-config.json` (lo escribe el entrypoint del contenedor). Falla cerrado. */

const BOOTSTRAP = /^\/(?:ip4|ip6|dns4|dns6|dns)\/[^/]+\/tcp\/\d{1,5}\/tls\/ws(?:\/p2p\/[A-Za-z0-9]+)?$/;

export function parseBootstrap(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(/[\n,]+/) : Array.isArray(value) ? value : undefined;
  if (!raw || !raw.every((item) => typeof item === "string")) {
    throw new Error("p2p-config.json.bootstrapAddrs debe ser texto o lista de textos");
  }
  const addresses = raw.map((item) => item.trim()).filter(Boolean);
  if (addresses.length === 0) throw new Error("p2p-config.json no trae direcciones bootstrap");
  for (const address of addresses) {
    if (!BOOTSTRAP.test(address)) throw new Error(`bootstrap inválido (se espera /…/tcp/<puerto>/tls/ws): ${address}`);
  }
  return addresses.map((address) => address.replace(/\/p2p\/[^/]+$/, ""));
}

export async function loadBootstrap(fetcher: typeof fetch = fetch): Promise<string[]> {
  const response = await fetcher(`/p2p-config.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`/p2p-config.json respondió HTTP ${response.status}`);
  const config = (await response.json()) as { bootstrapAddrs?: unknown };
  return parseBootstrap(config.bootstrapAddrs);
}
