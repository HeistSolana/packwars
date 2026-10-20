// Minimal Solana JSON-RPC client. No dependencies, uses Node 18+ fetch.

export class Rpc {
  constructor(url) {
    this.url = url;
    this.id = 0;
  }

  async call(method, params = [], retries = 3) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        });
        if (res.status === 429) throw new Error('rate limited (429)');
        const body = await res.json();
        if (body.error) throw new Error(`${method}: ${body.error.message}`);
        return body.result;
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  getSlot() {
    return this.call('getSlot', [{ commitment: 'finalized' }]);
  }

  getBalance(pubkey) {
    return this.call('getBalance', [pubkey, { commitment: 'confirmed' }]).then((r) => r.value);
  }

  getTokenSupply(mint) {
    return this.call('getTokenSupply', [mint]).then((r) => r.value);
  }

  // Top 20 token accounts by balance. A holder with >=1% of supply will almost
  // always be in here; the full scan below covers the rest.
  getTokenLargestAccounts(mint) {
    return this.call('getTokenLargestAccounts', [mint]).then((r) => r.value);
  }

  async getMultipleAccounts(pubkeys, encoding = 'jsonParsed') {
    const out = [];
    for (let i = 0; i < pubkeys.length; i += 100) {
      const chunk = pubkeys.slice(i, i + 100);
      const r = await this.call('getMultipleAccounts', [chunk, { encoding }]);
      out.push(...r.value);
    }
    return out;
  }

  // Every token account for a mint, for both SPL Token and Token-2022.
  // Heavy on big coins: needs an RPC that allows getProgramAccounts (Helius, Triton, QuickNode).
  async getAllTokenAccounts(mint) {
    const programs = [
      ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]],
      ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', [{ memcmp: { offset: 0, bytes: mint } }]],
    ];
    const all = [];
    for (const [programId, filters] of programs) {
      const r = await this.call('getProgramAccounts', [programId, { encoding: 'jsonParsed', filters }]).catch(() => []);
      all.push(...r);
    }
    return all;
  }

  getLatestBlockhash() {
    return this.call('getLatestBlockhash', [{ commitment: 'finalized' }]).then((r) => r.value);
  }
}
