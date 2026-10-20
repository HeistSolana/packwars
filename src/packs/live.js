// Live pack opener: buys and opens real packs with the bot wallet, then sends
// cards to winners. Every step saves progress (through `save`) so a crash or
// restart picks up where it left off instead of paying twice or losing a card.

import { Gacha } from '../live/gacha.js';
import { readCard } from './cards.js';
import { signWire, buildTx, simulate, sendAndConfirm } from '../solana/tx.js';
import { transferV1Ix, getCoreAsset } from '../solana/core.js';

export class LivePackOpener {
  /** @param {{rpc, wallet, machine, network?:string, dryRun?:boolean, log?:Function}} o */
  constructor({ rpc, wallet, machine, network = 'mainnet', dryRun = false, log = console.log }) {
    this.rpc = rpc;
    this.wallet = wallet;
    this.machine = machine;
    this.gacha = new Gacha({ network });
    this.dryRun = dryRun;
    this.log = log;
  }

  /**
   * @param {{forWallet:string, state?:object, save?:(state:object)=>void}} p
   * state moves through: {} -> {memo, tx} -> {memo, paid, paySig} -> {memo, paid, card}
   */
  async openPack({ forWallet, pack, state = {}, save = () => {} }) {
    const st = { ...state };
    const short = forWallet.slice(0, 4);

    // 1. Buy (skip if this pack was already paid for before a restart)
    if (!st.paid) {
      const gen = await this.gacha.generatePack({ playerAddress: this.wallet.publicKey, packType: pack ?? this.machine.code });
      const signed = signWire(gen.transaction, this.wallet);
      if (this.dryRun) {
        const sim = await simulate(this.rpc, signed);
        this.log(`  [dry run] pack for ${short}: payment ${sim.ok ? 'simulated OK' : 'would FAIL ' + JSON.stringify(sim.err)}, not sent`);
        throw Object.assign(new Error('dry run stops before paying'), { dryRun: true, simOk: sim.ok, logs: sim.logs });
      }
      st.memo = gen.memo;
      save(st);
      const sub = await this.gacha.submitTransaction(signed);
      st.paid = true; st.paySig = sub.signature;
      save(st);
      this.log(`  paid pack for ${short} (${sub.confirmationStatus}) ${sub.signature}`);
    }

    // 2. Open (safe to repeat: the API never sends a second card for the same memo)
    if (!st.card) {
      const opened = await this.gacha.openPack(st.memo);
      const mint = opened.nft_address;
      let card;
      try {
        card = await readCard(this.rpc, mint);
      } catch {
        // RPC without DAS support: fall back to what openPack returned
        const attrs = opened.nftWon?.content?.metadata?.attributes ?? [];
        const iv = attrs.find((a) => a.trait_type === 'Insured Value')?.value;
        card = { name: opened.nftWon?.content?.metadata?.name, insuredValueUsd: Number(iv), image: null, nftMint: mint };
      }
      if (!(card.insuredValueUsd > 0)) throw new Error(`Card ${mint} has no insured value. Can't score it.`);
      st.card = { ...card, rarity: opened.rarity ?? card.rarity, openTx: opened.transactionSignature };
      save(st);
      this.log(`  ${short} pulled ${st.card.name} ($${st.card.insuredValueUsd})`);
    }
    return { txSig: st.paySig, card: st.card };
  }

  /**
   * Opens a pack someone else already paid for (a player's duel seat), with the
   * card going to the bot's holding wallet. Safe to repeat for the same memo.
   */
  async openPaid({ memo }) {
    const opened = await this.gacha.openPack(memo);
    const mint = opened.nft_address;
    let card;
    try { card = await readCard(this.rpc, mint); }
    catch {
      const attrs = opened.nftWon?.content?.metadata?.attributes ?? [];
      const iv = attrs.find((a) => a.trait_type === 'Insured Value')?.value;
      card = { name: opened.nftWon?.content?.metadata?.name, insuredValueUsd: Number(iv), image: null, nftMint: mint };
    }
    if (!(card.insuredValueUsd > 0)) throw new Error(`Card ${mint} has no insured value. Can't score it.`);
    return { card: { ...card, rarity: opened.rarity ?? card.rarity, openTx: opened.transactionSignature } };
  }

  /** Sends one card NFT (Metaplex Core) from the bot wallet to a player. */
  async transferCard(card, toWallet) {
    const asset = await getCoreAsset(this.rpc, card.nftMint);
    if (asset.owner === toWallet) return 'already-delivered';
    if (asset.owner !== this.wallet.publicKey) {
      throw new Error(`Card ${card.nftMint} is owned by ${asset.owner}, not the bot wallet.`);
    }
    const { blockhash } = await this.rpc.getLatestBlockhash();
    const tx = buildTx({
      payer: this.wallet,
      recentBlockhash: blockhash,
      instructions: [transferV1Ix({ asset: card.nftMint, collection: asset.collection, payer: this.wallet.publicKey, newOwner: toWallet })],
    });
    if (this.dryRun) {
      const sim = await simulate(this.rpc, tx);
      this.log(`  [dry run] transfer of ${card.nftMint} ${sim.ok ? 'simulated OK' : 'would FAIL ' + JSON.stringify(sim.err)}`);
      return 'dry-run';
    }
    return sendAndConfirm(this.rpc, tx, { log: this.log });
  }
}

// Common/Uncommon/Rare/Epic from a value, using the machine's tier ranges.
export function tierFromValue(usd, machine) {
  const names = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic' };
  for (const [k, [lo, hi]] of Object.entries(machine.tiers)) if (usd >= lo && usd < hi) return names[k] ?? k;
  return usd >= machine.tiers.epic?.[0] ? 'Epic' : 'Common';
}
