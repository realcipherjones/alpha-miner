# Alpha Miner payout service

Standard library Python only, so there are no third-party packages on the box that holds the wallet key.

| Part | What it does | Can read the seed? |
|---|---|---|
| `app.py` | IGN registration, run seeds, replay verification, leaderboard | No |
| `payer.py` | Pays verified cash-outs and enforces the caps | Yes |
| `receipts.py` | Signs a receipt for each payout it can match to a verified cash-out, with its own key | No |
| `tools/replay_run.mjs` + `dist/bundle.js` | Replays a run in the real game code | No |

## The rules

- A run is payable only if the server issued its seed, it starts with an empty bank and no free lobs, it replays to a
  matching result, and it took at least as long as it claims. One run per player at a time.
- Payouts come only from the replay's cash-outs. Each stage of a run pays once.
- Per IGN: 1000 KII a UTC day. Whole game: min(1000 x players cashing out, 0.25% of the wallet at the start of the UTC day).
- Over a limit, KII stays queued and is paid oldest-first on later days.
- An IGN and wallet are bound permanently. The token proves who is asking but can't change where KII goes.

## Tests

    node build.mjs
    NODE=/path/to/node python3 -W ignore server/test_server.py   # includes a full run in real Chrome
    python3 server/rehearse_testnet.py                           # real nodes, throwaway keys, local containers
    node tools/test_replay.mjs                                   # uneven frame timing, forged logs
    node tools/test_replay_chrome.mjs                            # every tick, real Chrome against Node

## Deploying on the game box (64.177.14.13)

Never expose `app.py` directly: put a TLS reverse proxy in front of it (`APP_TRUST_PROXY=yes` trusts the proxy's
`X-Forwarded-For`), and open only 443 (and 80 for certificates). The node's RPC stays on loopback with control off.

1. Create users `alpha-web` and `alpha-payer`, plus the group `alpha-shared` that both belong to.
2. Copy `server/`, `tools/replay_*.mjs` and `dist/bundle.js` to `/opt/alpha-miner` (owned by root), keeping the
   same folder layout (`tools/` and `dist/` side by side), and Node 24 to `/opt/alpha-miner/node`.
3. Create `/var/lib/alpha-miner/shared` (`alpha-web:alpha-shared`, 2770) and `/var/lib/alpha-miner/payer`
   (`alpha-payer`, 700). The payer's database and seed live only in the second one.
4. Install `deploy/*.service`. Both start in dry-run mode, and no seed is needed for that.
5. Put the server address in the `apiBaseMeta` tag in `index.html`, then rebuild the exe. The exe's content security
   policy allows that one address and nothing else.

The verifier must use the same `dist/bundle.js` the shipped exe was built from. Bump `REPLAY_VERSION` (in
`src/scenes/RunReplay.ts`, `tools/replay_lib.mjs` and `server/app.py`) whenever gameplay changes.

## Go-live (real KII)

Confirmed sends can't be reversed. Run this once, as the operator, after installing the current release:

    ssh -t kii@64.177.14.13 'cd ~/alpha-miner && sudo server/deploy/go_live.sh'

It asks for the phrase `GO LIVE` and the wallet seed (hidden, never in chat, git or a command line), and checks the seed
against the alpha wallet before changing anything. It then erases **both** databases, so test cash-outs can't be paid as
real KII, installs the seed (`alpha-payer`, mode 600), and turns on live mode with a systemd drop-in that later installs
keep. It refuses to run a second time, because that would erase real payment records.

## Receipts

Each payout gets a signed record, indexed by its block hash. The signer reads sends from the chain rather than asking
the payer, and only signs ones that match a replay-verified cash-out. Anything else is published as unmatched, shows as a
warning on the leaderboard, and gets no receipt. Anyone can check them:

    python3 server/receipts.py verify https://miner.murderfacerecords.com

The key is created on the box on first start, in `/var/lib/alpha-miner/receipts`, readable only by `alpha-receipts`. It
shares a box with the payout seed for now, so this protects against the seed leaking or the payer being compromised, not
against a full takeover of the box. Replacing a key means publishing the new public key.

## Operating it

- Paused: `status.json` and the leaderboard say so, and the reason is in the journal. Something unexpected happened, such
  as another spend from the wallet, so look before resuming.
- After you deliberately move the wallet yourself (including receiving a top-up):
  `PAYER_ACCEPT_FRONTIER=<new frontier hash> python3 payer.py resume`
- Otherwise: `python3 payer.py resume`
- Stop payouts now: `systemctl stop alpha-payer`. Verification and the queue keep working.
