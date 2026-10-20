# Hosting wa-inbox

Needs an always-on Linux server (not serverless): one Chrome per linked user (~300-500 MB RAM each) and a disk that persists.
For ~10 users: **2 GB RAM minimum, 4 GB+ comfortable**. Free option: Oracle Cloud Always Free (Ampere A1: 2 OCPU / 12 GB).

## 1. Create the server
Ubuntu 22.04/24.04, open ports **22, 80, 443** (Oracle: add ingress rules in the VCN security list, *and* allow them in the
instance firewall: `sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT` then save with `sudo netfilter-persistent save`).

## 2. Install Docker and get the code
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in
git clone https://github.com/kapman600-glitch/what-if-i-make-it.git wa-inbox && cd wa-inbox
cp .env.example .env && nano .env     # set DOMAIN, DEFAULT_COUNTRY_CODE, MAX_CLIENTS
```
(For a private repo, clone with a GitHub token or deploy key.)

## 3a. With HTTPS (recommended)
Point a domain's A record at the server's public IP, set `DOMAIN` in `.env`, then:
```bash
sed -i 's/"${APP_PORT:-3000}:3000"/"127.0.0.1:3000:3000"/' docker-compose.yml   # keep the app behind Caddy
docker compose --profile https up -d --build
```
Open `https://your-domain`. Caddy gets the certificate automatically.

## 3b. Quick test without a domain
```bash
docker compose up -d --build
```
Open `http://SERVER-IP:3000` (open port 3000 in the firewall). Use plain http only for testing.

## 4. After everyone has registered
Set `ALLOW_SIGNUP=false` in `.env`, then `docker compose up -d`.

## Operations
- Logs: `docker compose logs -f app`  (look for `link code attempt` lines if phone-code linking fails)
- Update: `git pull && docker compose up -d --build`
- Backup: copy `data/` and `tokens/` (private! anyone with `tokens/` can act as your users on WhatsApp)
- Memory: `docker stats`; lower `MAX_CLIENTS` if the server swaps. Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
- Inventory app: set `ALLOW_ORIGIN=https://your-inventory-app` and call `POST /api/send` with the user's `X-Api-Key`.
