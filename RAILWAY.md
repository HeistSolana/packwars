# PACKWARS on Railway

No secrets in this repo. They go in Railway > your service > Variables:

| Variable | Value |
|---|---|
| BOT_WALLET_SECRET | the text inside bot-wallet.json |
| RPC_URL | your Helius RPC URL |
| ADMIN_PASSWORD | a password you choose, for yourdomain/admin |
| PULLDUEL_MODE | live |
| DATA_DIR | /data |

Add a Volume mounted at `/data` (keeps duels, deposits and /admin settings across redeploys).
Start command is `npm start`. Railway sets PORT automatically.
Coin CA, ticker and dev wallet: set at yourdomain/admin, no redeploy needed.
