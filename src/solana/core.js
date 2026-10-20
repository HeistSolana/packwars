// Metaplex Core: the NFT standard Collector Crypt cards use.
// Transferring one is a single instruction (TransferV1), no token accounts needed.

export const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TRANSFER_V1 = 14; // MplCoreInstruction::TransferV1

/** @param {{asset:string, collection?:string|null, payer:string, newOwner:string}} p */
export function transferV1Ix({ asset, collection, payer, newOwner }) {
  const none = { pubkey: MPL_CORE, isSigner: false, isWritable: false }; // "not provided" placeholder
  return {
    programId: MPL_CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },             // asset
      collection ? { pubkey: collection, isSigner: false, isWritable: false } : none, // collection
      { pubkey: payer, isSigner: true, isWritable: true },              // payer (also the current owner/authority)
      none,                                                             // authority -> defaults to payer
      { pubkey: newOwner, isSigner: false, isWritable: false },         // new owner
      none,                                                             // system program (not needed)
      none,                                                             // log wrapper (not needed)
    ],
    data: Uint8Array.from([TRANSFER_V1, 0]), // compression_proof: None
  };
}

/** Reads owner + collection for a Core asset via DAS getAsset. */
export async function getCoreAsset(rpc, mint) {
  const a = await rpc.call('getAsset', [{ id: mint }]);
  return {
    owner: a.ownership?.owner,
    collection: a.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null,
    isCore: (a.interface ?? '').toLowerCase().includes('core'),
    interface: a.interface,
  };
}
