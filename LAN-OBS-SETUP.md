# LAN OBS setup (Web/Desktop hybrid)

Use this when local overlay opens on the host laptop but fails from another device.

## 1) Bind to all interfaces

Your local scoring server must listen on:

- host: `0.0.0.0`
- port: stable range `3000..3010`

This allows requests from LAN devices like:

- `http://192.168.x.x:3000/pages/overlay.html?...`

## 2) Windows Firewall steps (host machine)

1. Open `wf.msc`
2. Inbound Rules -> New Rule -> **Port**
3. TCP -> Specific local ports: `3000-3010`
4. Allow the connection
5. Profile: Private
6. Name: `SLCRICKPRO LAN OBS`
7. Do same for Outbound rules

PowerShell (Admin):

```powershell
New-NetFirewallRule -DisplayName "SLCRICKPRO LAN OBS In" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000-3010 -Profile Private
New-NetFirewallRule -DisplayName "SLCRICKPRO LAN OBS Out" -Direction Outbound -Action Allow -Protocol TCP -LocalPort 3000-3010 -Profile Private
```

## 3) Quick test

From another laptop:

- `http://<host-ip>:3000/api/live-match?tournament=<TOURN_ID>`

If this endpoint responds, OBS Browser Source should also work.

## 4) CORS-safe scorebar snippet

Use same-origin relative fetch paths from overlay page:

```html
<div id="score">Loading...</div>
<script>
  const params = new URLSearchParams(location.search);
  const tournamentId = params.get('tournament') || '';

  async function tick() {
    const res = await fetch(`/api/live-match?tournament=${encodeURIComponent(tournamentId)}&_=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const match = await res.json();
    if (!match || !match.innings?.length) return;
    const inn = match.innings[match.currentInnings || 0];
    document.getElementById('score').textContent =
      `${match.team1} vs ${match.team2}  ${inn.runs}/${inn.wickets}`;
  }

  setInterval(tick, 1000);
  tick();
</script>
```

