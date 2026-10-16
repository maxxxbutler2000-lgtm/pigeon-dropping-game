# Pigeon Patrol

Full-window pigeon arcade game with upgrades, four worlds, colored targets, rare VIPs, accounts, cloud saves, and a top-50 leaderboard.

## Run

Node.js 22+ and PostgreSQL are required. Install dependencies with `pnpm install --frozen-lockfile`, set `DATABASE_URL`, then run `npm start`. The server binds to `0.0.0.0` and Railway's `PORT`. `/health` checks the database.

## Railway

Deploy the Dockerfile. Add PostgreSQL and set the game service variable `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`. Tables are created automatically at startup. Production sessions use Secure, HttpOnly, SameSite cookies; passwords are salted and hashed with scrypt. No credentials belong in this repository.

## Accounts and saves

Guests save locally. Signing in loads that account's cloud save, independently of the guest game. New accounts begin fresh. Sign out to restore the device's guest game. Progress syncs every 15 seconds; simultaneous save conflicts ask the player to reload instead of overwriting another tab. New Game resets the current run but the account's all-time leaderboard best remains. Usernames are public; passwords are private. Password recovery is not implemented.

The leaderboard is casual: client-reported scores are validated for structure and limits but are not cheat-proof. Browser saves on the original ChatGPT Site do not automatically transfer to this domain.
