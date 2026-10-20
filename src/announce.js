// Posts duel results to Telegram and/or Discord if their env vars are set.

export function makeAnnouncer() {
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (!tgToken && !discord) return null;

  return async (line, record) => {
    const proof = `Seed ${record.seed.slice(0, 16)}… from blockhash ${record.blockhash.slice(0, 10)}… (slot ${record.snapshotSlot})`;
    const text = `${line}\n${proof}`;
    const jobs = [];
    if (tgToken && tgChat) {
      jobs.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
      }));
    }
    if (discord) {
      jobs.push(fetch(discord, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }));
    }
    await Promise.all(jobs);
  };
}
