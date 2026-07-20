# Database UI — Drizzle Gateway (private access)

A self-hosted **Drizzle Studio** (Drizzle Gateway) for browsing tables, running
SQL, and editing data in sharp's Postgres — without exposing the database to the
internet.

## The security model (why it's set up this way)

Drizzle Gateway is a full read/write DB admin panel. If it were on a public
domain, the **only** barrier between the internet and your entire database would
be one password — a permanent brute-force and credential-leak target.

Instead:

- The `db-studio` container publishes its port to the **VPS loopback only**
  (`127.0.0.1:4983` in `docker-compose.dokploy.yml`), so it is unreachable from
  outside the host even while running.
- You reach the UI through an **SSH tunnel** from your laptop.
- A second gate, **`MASTERPASS`**, protects the UI itself.

Net effect: an attacker must already hold an SSH session on the VPS *before* the
DB UI is even visible. Near-zero standing internet exposure.

## One-time setup (Dokploy)

1. In the Dokploy **Environment** tab set a long, unique master password:

   ```env
   MASTERPASS=<long unique string>
   ```

   (Generate one: `LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40; echo`)

2. Deploy the compose stack. `db-studio` starts automatically. **Do not** add a
   domain for it in the Domains tab — it stays private.

## Connect (every time you need the DB UI)

### 1. Open the SSH tunnel

From your laptop, using your SSH shortcut (`Host hostinger` in `~/.ssh/config`):

```bash
ssh -N -L 4983:127.0.0.1:4983 hostinger
```

- `-L 4983:127.0.0.1:4983` — opens port `4983` on your laptop and forwards it to
  `127.0.0.1:4983` **on the VPS** (where the container is bound).
- `-N` — no remote shell, just the tunnel. Leave this terminal open while you work.

Run it in the background instead (frees the terminal):

```bash
ssh -fN -L 4983:127.0.0.1:4983 hostinger   # start
pkill -f 4983:127.0.0.1:4983               # stop later
```

Without the SSH alias, use the full form:

```bash
ssh -N -L 4983:127.0.0.1:4983 <user>@<vps-host>   # e.g. root@sharp.davideghiotto.it
```

If your laptop's `4983` is busy, pick another local port and use it in the URL:

```bash
ssh -N -L 5983:127.0.0.1:4983 hostinger    # then browse http://127.0.0.1:5983
```

### 2. Open the UI and log in

Browse to:

```
http://127.0.0.1:4983
```

Log in with **`MASTERPASS`**.

### 3. Add the database connection (first time only — it persists)

Inside the Gateway UI, add a Postgres connection. Connection string:

```
postgres://sharp:<POSTGRES_PASSWORD>@postgres:5432/sharp
```

Or as separate fields:

| Field    | Value                                    |
| -------- | ---------------------------------------- |
| Host     | `postgres`                               |
| Port     | `5432`                                   |
| User     | `sharp`                                  |
| Database | `sharp`                                  |
| Password | your `POSTGRES_PASSWORD` (Dokploy env)   |
| SSL      | off                                      |

**Important:** the host is `postgres` (the compose service name), **not**
`localhost` or `127.0.0.1`. The SSH tunnel only carries the *UI* (port 4983) to
your laptop. The DB connection itself is container-to-container inside the
compose `default` network, so it resolves Postgres by service name.

The connection saves into the `drizzle_gateway` Docker volume, so you only do
this once.

## Troubleshooting

- **Can't reach `http://127.0.0.1:4983`** — the tunnel isn't up. Check the SSH
  command is still running; re-run it.
- **Verify the container is serving** — SSH into the VPS and run
  `curl -I http://127.0.0.1:4983` (expect an HTTP response).
- **`postgres` host not found in the UI** — the connection host must be the
  service name `postgres`, not localhost.
- **Non-standard SSH port** — add `-p <port>` to the `ssh` command (or set it in
  `~/.ssh/config`).

## Do NOT

- Change the port binding to `0.0.0.0:4983` — that exposes the DB UI publicly.
- Add a `db.sharp.davideghiotto.it` (or any) domain for `db-studio` in Dokploy —
  same effect.

## Upgrade path

Install **Tailscale** or **WireGuard** on the VPS to reach the tunnel over a
private network without SSH each time. Everything else stays the same.
