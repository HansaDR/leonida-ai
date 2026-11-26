# Leonida AI v0.5

The Sydney A1 service runs at **http://127.0.0.1:8766/** through SSH port forwarding. It uses the existing 4,344 locations, 1,021 named places and GTADB daytime tiles at their original coordinates.

## Open the private map

Start this in a terminal and leave it running while you use the map.

    ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8766:127.0.0.1:8766 loco-ai-oci

On Windows, run this in a second PowerShell window to copy the application password without printing it.

    (ssh loco-ai-oci 'sudo -n cat /etc/leonida/http-password').Trim() | Set-Clipboard

Open http://127.0.0.1:8766/ and sign in as **leonida**. The browser remembers Basic authentication for its session. The same SSH tunnel can be used on a device with an SSH client. Preferences, favorites, waypoints and progress share one SQLite database.

Strict mode shows locations reviewed for your recorded story and activity progress. Chapter-only locations you can no longer visit are labeled **Chapter window closed**. Expand **Temporarily reveal categories** to see names and positions with unknown unlock requirements during the page session. Their descriptions and screenshots stay hidden. The GTADB repository contains licensed photos, and the app supports a verified availability and licensed-media manifest. Publishing a photo in the app requires a documented location ID, chapter availability and image attribution.

## Mission progress and player location

Enter a supported mission or save checkpoint in **Explore → Mission progress**. It takes precedence over PSN's completed-chapter trophy. Use **Use PSN chapter** to return to chapter-based filtering. Checkpoint rules cover a reviewed subset of the catalog. Confirm Kenton’s assignments only when he has sent the relevant locations in-game. A trophy or mission checkpoint alone cannot confirm those optional assignments.

**My location** accepts a pin picked on Leonida or a paused in-game map screenshot. In a screenshot, select the player arrow and two widely separated landmarks. Then select the same two landmarks in order on Leonida and confirm the estimate. Supported desktop browsers can also capture one frame from an existing screen or window you select. The browser stops the capture tracks after the frame and processes screenshots locally. Only the confirmed in-game position and its timestamp are saved.

### Live position tracking

The **Track live position** button captures a local window and follows the player arrow on a paused in-game map. The game can run on a PS5, but the browser cannot capture the console directly: start **PS Remote Play** on the PC (or a capture-card preview) and select that window. PSN API provides trophies and playtime, not video or coordinates. If the selected window captures black, use a capture-card preview instead.

After one calibration, keep the in-game map view still. Leonida compares each frame with the player-arrow and landmark templates locally, stops if the map moves, and sends only the mapped position and timestamp. Video frames never leave the browser. Changing the map zoom, pan or captured-window size requires recalibration. Tracking is approximate; the pause/full map is the supported surface, not the rotating minimap.

**Fog** shades areas outside the vicinity of reviewed available locations and your saved positions. It approximates what this companion knows about your progress. The game’s exploration mask is unavailable to Leonida. The companion retains the most recent 120 position cells. **Clear saved locations** removes the last position and those cells.

**Explore → Nearby finds** lists reviewed weapons, collectibles, treasure and side missions close to your saved location. Select a find to open its map details. Indoor pins at Starlet Motel use the building as their reference point. **Guides** searches reviewed story and side-mission titles and aliases, gives short instructions, and links to the full walkthrough. An exact search for a later mission shows its lock status. Searches outside the reviewed set offer a web lookup.

## Connect PlayStation

Get your own NPSSO in a signed-in PlayStation browser session using the steps in the [psn-api authentication documentation](https://github.com/achievements-app/psn-api#how-to-obtain-an-authentication-token). Store it through the hidden terminal prompt on Sydney.

    ssh -t loco-ai-oci /opt/leonida/v05/provision-psn.sh

Choose **Sync now**. A successful manual sync unlocks the optional **Sync every 30 minutes** setting. The app exchanges the bootstrap credential for refreshable tokens in the private service state directory. It removes the bootstrap after exchange. Renew through the same prompt if authentication expires.

PSN integration uses an unofficial library and can stop working if Sony changes authentication, response shapes or rate limits. The app keeps the last valid snapshot and spaces out retries. Trophy 13 supplies completion. The separate played-games endpoint supplies playtime when it includes the exact GTA VI title ID. The verified milestone mapping covers Chapters 1–4 through trophies 2–5.

Counter increases produce history entries. Only objectives with a mapped category of individual locations offer **Choose on map**. Confirming, unlinking and undoing map completions leave the original trophy count intact. Automatic location completion requires unique location evidence. The current PSN source supplies aggregate counts, so it queues choices and performs no automatic location assignments.

## Sydney service commands

Run on Sydney after connecting with `ssh loco-ai-oci`.

    sudo systemctl status leonida.service leonida-backup.timer
    sudo journalctl -u leonida.service -u leonida-backup.service -n 50 --no-pager
    sudo systemctl restart leonida.service
    sudo systemctl start leonida-backup.service
    sudo systemctl list-timers leonida-backup.timer

`/opt/leonida/v05` contains the app and isolated Node runtime. `/opt/leonida/data` and `/opt/leonida/tiles` are copied from the v0.4 dataset. `/var/lib/leonida/progress.sqlite3` is the migrated v0.5 copy. The backup timer retains 14 daily SQLite snapshots, scheduled around 04:10 Asia/Colombo. PSN tokens and the app password live separately from the database backups.

## Rollback

The pre-upgrade SQLite copy, data and v0.4 scripts are in `/home/ubuntu/leonida-ai/.v05-preupgrade-caRPtW`. The original v0.4 files and database are still at `/home/ubuntu/leonida-ai/`.

Take a backup of v0.5 and disable its two units. This preserves any new v0.5 map progress on disk.

    sudo systemctl start leonida-backup.service
    sudo systemctl disable --now leonida.service leonida-backup.timer
    python3 /home/ubuntu/leonida-ai/leonida_preview_v4.py --port 8765

Use an SSH forward to port 8765 for v0.4. Edits made in v0.5 after migration remain in the v0.5 database. To return to that version, exit the v0.4 preview and run `sudo systemctl enable --now leonida.service leonida-backup.timer`.

## Singapore ingress review

Singapore E2 currently uses Nginx stream SNI routing on public port 443. `dialog-xray.locoai.qzz.io` goes to the TLS listener on loopback port 1443 and other SNI names go to the existing default on port 2443. Nginx and Xray were active during inspection. The proposed HTTPS virtual host uses loopback port 1444 and proxies to a loopback SSH forward on port 18766. Sydney keeps port 8766 on loopback. E2 could reach the Sydney SSH port at `100.110.4.76` over Tailscale.

The candidate virtual host and tunnel unit are staged as source files. On E2, the virtual host passed a standalone syntax check and HTTPS tests for authentication, host validation and browser-origin forwarding against the disposable Sydney backend. The test used a temporary certificate. [Deployment files](deploy/)

Any future activation needs a certificate specific to `gta6.locoai.qzz.io`, the intended DNS record, and an exact SNI map entry of `gta6.locoai.qzz.io 127.0.0.1:1444;`. The proposed SSH unit requires a dedicated E2 key, a pinned Sydney host key, and a Sydney account confined to local forwarding to `127.0.0.1:8766` from the E2 Tailscale IP. Confirm the existing SNI mapping and default route with the final configuration before reload, then test both the new host and the existing Xray routes.

## Reproduce the tests

    python3 -m unittest -v test_leonida
    node test_tracker.mjs
    for test in success refresh partial auth limit; do node test_psn_worker.mjs "$test"; done

Run the PSN worker fixtures on Linux with Node 22. The Chromium suite uses `test_browser.py`, Playwright and a disposable Sydney preview. Its checks cover marker coordinates, clustering and filters, strict spoiler state on reload, search, favorites, completion, waypoints, fullscreen, and mobile layout. Test credentials and progress belong in the disposable preview.
