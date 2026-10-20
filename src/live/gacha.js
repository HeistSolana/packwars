// Collector Crypt pack API client (docs.collectorcrypt.com/gacha/api).
// Flow: generatePack -> bot signs -> submitTransaction (pays USDC) -> openPack (card NFT arrives).

const HOSTS = {
  mainnet: 'https://gacha.collectorcrypt.com',
  devnet: 'https://dev-gacha.collectorcrypt.com',
};

export class Gacha {
  constructor({ network = 'mainnet', apiKey = process.env.CC_API_KEY } = {}) {
    this.base = HOSTS[network] ?? network;
    this.apiKey = apiKey;
  }

  async #post(path, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${path} -> HTTP ${res.status}: ${json.error ?? json.message ?? text.slice(0, 200)}`);
      err.status = res.status; err.body = json;
      // 429 rate limit and 503 machine busy are worth retrying later
      err.retryable = res.status === 429 || res.status === 503 || res.status >= 500;
      throw err;
    }
    return json;
  }

  /**
   * Builds a pack purchase. Turbo stays off so Common cards are not auto-sold.
   * altPlayerAddress: where the card goes when opened (the bot's holding wallet for duels).
   */
  generatePack({ playerAddress, packType, altPlayerAddress }) {
    const body = { playerAddress, packType, turbo: false };
    if (altPlayerAddress) body.altPlayerAddress = altPlayerAddress;
    return this.#post('/api/generatePack', body);
  }

  submitTransaction(signedTransaction) {
    return this.#post('/api/submitTransaction', { signedTransaction });
  }

  /** Opens a paid pack. Waits while payment is still confirming. Never sends a second card. */
  async openPack(memo, { timeoutMs = 120_000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await this.#post('/api/openPack', { memo });
      if (r.code !== 'WAITING_FOR_WEBHOOK' && r.nft_address) return r;
      if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error(`Pack ${memo} still waiting for payment after ${timeoutMs / 1000}s`), { retryable: true });
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  status(memo) {
    return fetch(`${this.base}/api/pack/status?memo=${encodeURIComponent(memo)}`).then((r) => r.json());
  }
}
