"""Chromium tests against a disposable Sydney preview behind an SSH tunnel."""
import argparse
import base64
import re
import subprocess
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def verify(args):
    password = subprocess.check_output(
        ["ssh", "-o", "BatchMode=yes", "loco-ai-oci", "cat", args.staging_password],
        text=True,
    ).strip()
    credentials = {"username": "leonida", "password": password}
    output = Path(args.output)
    output.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium)
        desktop = browser.new_context(viewport={"width": 1420, "height": 920}, http_credentials=credentials,
                                      reduced_motion="reduce")
        page = desktop.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        expect(page.locator("#top-completion")).to_have_text("16%")
        expect(page.locator("#full-map")).to_be_checked()
        expect(page.locator("#count")).to_have_text(re.compile(r"5,3\d\d markers"))
        page.locator("#full-map").uncheck()
        expect(page.locator("#count")).to_have_text("40 markers")
        expect(page.locator("img.leaflet-tile-loaded").first).to_be_visible()
        page.screenshot(path=str(output / "chapter-map.png"))
        page.locator("#search").fill("Jason's House Meditation")
        page.locator("#results button").first.click()
        expect(page.locator("#detail-content")).to_contain_text("Chapter window closed")
        page.get_by_role("button", name="Close location details").click()
        page.locator("#search").clear()
        full_map = page.evaluate("""async () => {
          for (const key of categories.keys()) revealed.add(key);
          const started = performance.now();
          await refreshMap();
          const result = {count: mapMarkers.size, milliseconds: Math.round(performance.now() - started)};
          revealed.clear();
          await refreshMap();
          return result;
        }""")
        assert full_map["count"] == 5340, full_map
        print(f"All revealable markers clustered in {full_map['milliseconds']} ms")
        page.locator("#search").fill("Vice City")
        expect(page.get_by_role("button", name="Vice City · District")).to_be_visible()
        page.locator("#search").clear()
        page.locator("#spoiler-controls summary").click()
        page.locator("#reveal-category").select_option("meditation")
        expect(page.locator("#count")).to_have_text("40 markers")
        page.locator("#reveal-category").select_option("stunt")
        expect(page.locator("#count")).to_have_text("170 markers")
        expect(page.locator(".map-cluster").first).to_be_visible()
        page.get_by_role("button", name="Hide all", exact=True).click()
        expect(page.locator("#count")).to_have_text("0 markers")
        page.get_by_role("button", name="Select all", exact=True).click()
        expect(page.locator("#count")).to_have_text("170 markers")
        page.locator("#reveal-category").select_option("bank")
        page.locator("#reveal-category").select_option("race")
        expect(page.locator("#count")).to_have_text("247 markers")
        page.locator("#spoiler-controls summary").click()
        page.screenshot(path=str(output / "desktop.png"))
        marker = page.evaluate("""() => {
          const item = mapPayload.markers.find(marker => marker.kind === 'meditation');
          const layer = mapMarkers.get(item.id).layer;
          const p = layer.getLatLng();
          return {id: item.id, x: item.x, y: item.y, lat: p.lat, lng: p.lng};
        }""")
        assert marker["x"] == marker["lng"] and marker["y"] == -marker["lat"]
        page.locator("#search").fill("meditation")
        expect(page.locator("#results button").first).to_be_visible()
        page.locator("#results button").first.click()
        expect(page.locator("#detail")).to_be_visible()
        expect(page.locator("#detail-content")).to_contain_text(re.compile("Available|Chapter window closed"))
        page.get_by_role("button", name="Favorite", exact=True).click()
        expect(page.get_by_role("button", name="Remove favorite")).to_be_visible()
        page.get_by_role("button", name="Mark completed", exact=True).click()
        expect(page.get_by_role("button", name="Undo completion")).to_be_visible()
        page.get_by_role("button", name="Close location details").click()
        page.locator("#hide-completed").check()
        expect(page.locator("#count")).to_have_text("8 markers")
        page.get_by_role("button", name="Add a waypoint").click()
        page.locator("#map").click(position={"x": 385, "y": 300})
        expect(page.locator("#waypoint-dialog")).to_be_visible()
        page.locator("#waypoint-name").fill("Browser test waypoint")
        page.get_by_role("button", name="Save", exact=True).click()
        expect(page.locator("#waypoint-dialog")).not_to_be_visible()
        page.get_by_role("button", name="Fullscreen map").click()
        expect(page.locator("#fullscreen")).to_have_attribute("aria-pressed", "true")
        page.get_by_role("button", name="Fullscreen map").click()
        expect(page.locator("#fullscreen")).to_have_attribute("aria-pressed", "false")
        page.get_by_role("button", name="Progress", exact=True).click()
        expect(page.locator("#summary")).to_contain_text("Chapter 1")
        expect(page.locator("#sync-status")).to_contain_text("imported snapshot")
        page.get_by_role("button", name="Sync now").click()
        expect(page.locator("#notice")).to_contain_text("PSN sign-in is required")
        assert not errors, errors
        desktop.close()

        mobile = browser.new_context(**playwright.devices["iPhone 13"], http_credentials=credentials,
                                     reduced_motion="reduce")
        page = mobile.new_page()
        page.goto(args.url)
        expect(page.locator("#map")).to_be_visible()
        expect(page.locator("#sidebar")).not_to_be_visible()
        expect(page.locator("img.leaflet-tile-loaded").first).to_be_visible()
        page.get_by_role("button", name="Open map filters").click()
        expect(page.locator("#hide-completed")).to_be_checked()
        expect(page.locator("#count")).to_have_text("39 markers")
        page.locator("#spoiler-controls summary").click()
        page.locator("#reveal-category").select_option("meditation")
        expect(page.locator("#count")).to_have_text("39 markers")
        page.get_by_role("button", name="Close sidebar").click()
        page.get_by_role("button", name="Open progress dashboard").click()
        expect(page.locator("#summary")).to_contain_text("Confirmed map locations")
        expect(page.locator("#summary .metric").filter(has_text=re.compile("Confirmed map locations"))).to_contain_text("1")
        assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
        page.screenshot(path=str(output / "mobile.png"))
        mobile.close()

        desktop = browser.new_context(viewport={"width": 1420, "height": 920}, http_credentials=credentials,
                                      reduced_motion="reduce")
        page = desktop.new_page()
        page.goto(args.url)
        expect(page.locator("#story-checkpoint")).to_contain_text("PSN confirmed Chapter 1")
        page.locator("#mission-name").fill("Reached Starlet Motel")
        page.locator("#story-form button[type=submit]").click()
        expect(page.locator("#story-checkpoint")).to_have_text("Reached Starlet Motel · Chapter 2")
        assert page.evaluate("""() => mapPayload.markers.some(row => row.id === 'safehouse-003') &&
          !mapPayload.markers.some(row => row.id === 'random-event-121') &&
          !mapPayload.markers.some(row => row.kind === 'treasure')""")
        page.locator("#kenton-stage").select_option("1")
        page.wait_for_function("""() => mapPayload.markers.filter(row => row.kind === 'treasure').length === 2""")
        page.locator("#kenton-stage").select_option("0")
        page.wait_for_function("""() => !mapPayload.markers.some(row => row.kind === 'treasure')""")
        expect(page.locator(".story-fog")).to_be_visible()
        page.locator("#toggle-fog").click()
        expect(page.locator(".story-fog")).not_to_be_visible()
        page.locator("#toggle-fog").click()
        expect(page.locator(".story-fog")).to_be_visible()

        page.get_by_role("button", name="My location").click()
        page.evaluate("""() => {
          navigator.mediaDevices.getDisplayMedia = async () => {
            const image = document.createElement('canvas');
            image.width = 400; image.height = 200;
            const context = image.getContext('2d');
            const stream = image.captureStream(15);
            window.testTrack = stream.getVideoTracks()[0];
            const timer = setInterval(() => {
              if (window.testTrack.readyState === 'ended') { clearInterval(timer); return; }
              context.fillStyle = '#347699'; context.fillRect(0, 0, 400, 200);
            }, 30);
            return stream;
          };
        }""")
        page.get_by_role("button", name="Capture one frame").click()
        expect(page.locator("#position-screenshot")).to_be_visible()
        page.wait_for_function("window.testTrack.readyState === 'ended'")
        screenshot = page.evaluate("""() => {
          const canvas = document.createElement('canvas');
          canvas.width = 400;
          canvas.height = 200;
          canvas.getContext('2d').fillRect(0, 0, 400, 200);
          return canvas.toDataURL().split(',')[1];
        }""")
        page.locator("#position-file").set_input_files({"name": "fixture.png", "mimeType": "image/png",
                                                        "buffer": base64.b64decode(screenshot)})
        canvas = page.locator("#position-screenshot")
        expect(canvas).to_be_visible()
        for x, y in ((150, 100), (50, 50), (250, 50)):
            canvas.click(position={"x": x, "y": y})
        expect(page.locator("#position-instruction")).to_have_text("Tap landmark A on Leonida.")
        page.evaluate("""() => {
          map.fire('click', {latlng: L.latLng(-400, 300)});
          map.fire('click', {latlng: L.latLng(-400, 380)});
        }""")
        page.get_by_role("button", name="Save this location").click()
        page.wait_for_function("""() => mapPayload.position?.source === 'screenshot'""")
        point = page.evaluate("mapPayload.position")
        assert abs(point["x"] - 340) < 0.01 and abs(point["y"] - 420) < 0.01, point
        page.reload()
        expect(page.locator(".player-dot.estimated")).to_be_visible()
        expect(page.locator(".story-fog")).to_be_visible()
        expect(page.locator("#story-checkpoint")).to_contain_text("Reached Starlet Motel")
        expect(page.locator("#nearby-list")).to_contain_text("Bat Batesaurio")
        expect(page.locator("#nearby-list")).to_contain_text("Victor Maravilla")
        flyer = page.locator("#nearby-list").get_by_role("button", name=re.compile("Pilot Wanted"))
        flyer.click()
        expect(page.locator("#detail-content")).to_contain_text("Read the Pilot Wanted flyer")
        page.get_by_role("button", name="Open mission guide").click()
        expect(page.locator("#guide-results")).to_contain_text("Check Out McKittrick Farm")
        page.locator("#guide-search").fill("Kingpin Bowling")
        expect(page.locator("#guide-results")).to_contain_text("Unlocks later than your saved checkpoint")
        expect(page.locator("#guide-results")).not_to_contain_text("pool table")
        page.locator("#guide-search").fill("Pilot Wanted")
        expect(page.locator("#guide-results")).to_contain_text("Check Out McKittrick Farm")
        expect(page.get_by_role("link", name="Full walkthrough")).to_be_visible()
        page.locator("#guide-search").fill("Assassin Pistol")
        expect(page.locator("#guide-results")).to_contain_text("Permit Keys rare weapons")
        page.get_by_role("button", name="Explore", exact=True).click()
        page.locator("#search").fill("Key Lento")
        page.get_by_role("button", name="Key Lento · District", exact=True).click()
        expect(page.locator("#search")).to_have_value("")
        assert page.evaluate("""() => map.getBounds().contains(L.latLng(-722.3, 338.5)) &&
          mapMarkers.has('weapon-spawn-002') && mapMarkers.has('weapon-spawn-003')""")
        page.screenshot(path=str(output / "story-fog.png"))
        desktop.close()
        browser.close()
    print("Desktop and mobile interaction tests passed. Verified same-coordinate markers, clusters, filters, protected reload, cross-device preferences, favorites, completion, waypoint, fullscreen and cached PSN.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18767")
    parser.add_argument("--staging-password", required=True)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--output", default="qa")
    verify(parser.parse_args())
