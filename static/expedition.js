'use strict';

function mapPosition(player, screenshotA, screenshotB, mapA, mapB) {
  return LeonidaTracker.mapPoint(player, screenshotA, screenshotB, mapA, mapB);
}

class ExpeditionView {
  constructor(map, fog) {
    this.map = map;
    this.fog = fog;
    this.wells = [];
    this.position = null;
    this.markerLayer = L.layerGroup().addTo(map);
    const pane = map.createPane('storyFog');
    pane.style.zIndex = '350';
    pane.style.pointerEvents = 'none';
    this.mask = pane.appendChild(node('canvas', null, 'story-fog'));
    this.mask.setAttribute('aria-hidden', 'true');
    this.context = this.mask.getContext('2d');
    map.on('move zoom resize', () => this.scheduleFog());
    map.on('click', event => this.mapClick(event.latlng));
    this.wire();
    window.addEventListener('pagehide', () => this.stopTracking());
  }

  wire() {
    $('toggle-fog').onclick = () => {
      this.fog = !this.fog;
      savePreferences();
      this.redraw();
    };
    $('story-form').onsubmit = event => {
      event.preventDefault();
      this.saveStory({checkpoint: $('mission-name').value});
    };
    $('use-psn').onclick = () => this.saveStory({checkpoint: ''});
    $('kenton-stage').onchange = event => this.saveStory({kenton: Number(event.target.value)});
    $('player-location').onclick = () => {
      this.stopTracking();
      this.resetCalibration();
      closeDetail();
      $('position-dialog').showModal();
    };
    $('pick-position').onclick = () => {
      this.trackPending = false;
      this.stopTracking();
      this.startMapping('map', 'Tap your current location on Leonida.');
    };
    $('close-position').onclick = () => $('position-dialog').close();
    $('cancel-position').onclick = () => {
      this.trackPending = false;
      this.stopTracking();
      this.resetCalibration();
    };
    $('center-position').onclick = () => {
      $('position-dialog').close();
      this.focus(this.position);
    };
    $('clear-position').onclick = async () => {
      if (!window.confirm('Clear the saved player position and visited map areas?')) return;
      this.stopTracking();
      try {
        await api('/api/player-position', {clear: true});
        await refreshMap();
      } catch (error) { notify(error.message); }
    };
    $('upload-position').onclick = () => $('position-file').click();
    $('position-file').onchange = async event => {
      this.stopTracking();
      this.trackPending = false;
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) {
        this.captureError('Choose an image smaller than 20 MB.');
        return;
      }
      try {
        this.loadImage(await createImageBitmap(file));
      } catch {
        this.captureError('This image could not be opened. Try a PNG, JPEG or WebP screenshot.');
      }
    };
    $('capture-position').hidden = !navigator.mediaDevices?.getDisplayMedia;
    $('capture-position').onclick = () => this.captureFrame();
    $('track-position').hidden = !navigator.mediaDevices?.getDisplayMedia;
    $('track-position').onclick = () => this.startTrackingSetup();
    $('stop-tracking').onclick = () => this.stopTracking();
    $('position-screenshot').onclick = event => this.screenshotClick(event);
    $('position-dialog').addEventListener('close', () => {
      if (this.closingForMapping) { this.closingForMapping = false; return; }
      this.resetCalibration();
      this.stopTracking();
    });
    this.redraw();
  }

  async saveStory(value) {
    try {
      await api('/api/story', value);
      $('mission-name').value = '';
      await refreshMap();
      notify('Map updated for your saved progress.');
    } catch (error) {
      $('kenton-stage').value = this.story?.kenton ?? 0;
      notify(error.message);
    }
  }

  update(data) {
    this.story = data.story;
    if (this.story) {
      $('story-checkpoint').textContent = this.story.name
        ? this.story.name + ' · Chapter ' + this.story.chapter
        : (this.story.chapter ? 'PSN confirmed Chapter ' + this.story.chapter : 'No story checkpoint recorded');
      const missions = this.story.completedMissions || [];
      const checklist = $('completed-missions');
      checklist.hidden = !missions.length;
      checklist.querySelector('ul').replaceChildren(...missions.map(name => node('li', '✓ ' + name)));
      $('use-psn').hidden = !this.story.name;
      $('kenton-label').hidden = !this.story.canKenton;
      $('kenton-stage').value = this.story.kenton;
    }
    this.position = data.position;
    $('last-position').textContent = this.position
      ? (this.position.source === 'map' ? 'Map pin' : this.position.source === 'video' ? 'Live position' : 'Estimated position') + ' · ' + date(this.position.updated)
      : 'No saved player position';
    $('center-position').hidden = !this.position;
    $('clear-position').hidden = !this.position && !data.visited?.length;
    this.wells = data.markers.filter(marker => marker.availability === 'available')
      .map(marker => ({x: marker.x, y: marker.y, radius: 33}));
    for (const point of data.visited || []) this.wells.push({...point, radius: 26});
    this.renderPosition();
    this.redraw();
  }

  showFog() {
    return this.fog && !$('full-map').checked && !this.mode;
  }

  isRevealed(latlng) {
    return !this.showFog() || this.wells.some(point =>
      Math.hypot(latlng.lng - point.x, -latlng.lat - point.y) < point.radius);
  }

  redraw() {
    $('toggle-fog').setAttribute('aria-pressed', String(this.fog));
    this.scheduleFog();
    this.map.fire('fogchange');
  }

  scheduleFog() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.drawFog();
    });
  }

  drawFog() {
    this.mask.hidden = !this.showFog();
    if (this.mask.hidden || !this.context) return;
    const size = this.map.getSize();
    const density = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(size.x * density);
    const height = Math.round(size.y * density);
    if (this.mask.width !== width || this.mask.height !== height) {
      this.mask.width = width;
      this.mask.height = height;
      this.mask.style.width = size.x + 'px';
      this.mask.style.height = size.y + 'px';
    }
    L.DomUtil.setPosition(this.mask, this.map.containerPointToLayerPoint([0, 0]));
    const context = this.context;
    context.setTransform(density, 0, 0, density, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, size.x, size.y);
    context.fillStyle = 'rgba(14, 18, 31, 0.93)';
    context.fillRect(0, 0, size.x, size.y);
    context.globalCompositeOperation = 'destination-out';
    const scale = this.map.options.crs.scale(this.map.getZoom());
    for (const point of this.wells) {
      const center = this.map.latLngToContainerPoint([-point.y, point.x]);
      const radius = point.radius * scale;
      if (center.x < -radius || center.x > size.x + radius ||
          center.y < -radius || center.y > size.y + radius) continue;
      const haze = context.createRadialGradient(center.x, center.y, radius * .72, center.x, center.y, radius);
      haze.addColorStop(0, '#fff');
      haze.addColorStop(1, '#fff0');
      context.fillStyle = haze;
      context.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
    }
  }

  renderPosition() {
    this.markerLayer.clearLayers();
    const point = this.candidate || this.position;
    if (!point) return;
    const marker = L.marker([-point.y, point.x], {
      icon: L.divIcon({className: 'player-dot' + (point.source === 'map' ? '' : point.source === 'video' ? ' live' : ' estimated'),
        iconSize: [18, 18], iconAnchor: [9, 9]}),
      title: this.candidate ? 'Estimated player position' : point.source === 'video' ? 'Live player location' : 'Last known player location',
      zIndexOffset: 1800,
    }).addTo(this.markerLayer);
    if (!this.candidate) marker.on('click', () => $('player-location').click());
  }

  focus(point) {
    if (point) this.map.setView([-point.y, point.x], Math.max(this.map.getZoom(), 2.5),
      {animate: !reducedMotion.matches});
  }

  resetImage() {
    this.image?.close?.();
    this.image = null;
    $('position-screenshot').hidden = true;
    $('screenshot-instructions').hidden = true;
    $('tracking-help').hidden = true;
  }

  resetCalibration() {
    this.cancelMapping();
    this.screenshotPoints = [];
    this.mapPoints = [];
    this.resetImage();
  }

  captureError(message) {
    $('screenshot-instructions').textContent = message;
    $('screenshot-instructions').hidden = false;
  }

  async captureFrame() {
    this.stopTracking();
    this.trackPending = false;
    const button = $('capture-position');
    let stream, timeout;
    button.disabled = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false});
      const video = node('video');
      video.muted = true;
      video.srcObject = stream;
      const snapshot = await Promise.race([
        video.play().then(() => createImageBitmap(video)),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Capture timed out')), 4000); }),
      ]);
      if ($('position-dialog').open) this.loadImage(snapshot);
      else snapshot.close();
    } catch {
      if ($('position-dialog').open) this.captureError('Screen capture did not return a frame. You can open a saved map screenshot.');
    } finally {
      clearTimeout(timeout);
      stream?.getTracks().forEach(track => track.stop());
      button.disabled = false;
    }
  }

  async startTrackingSetup() {
    if (this.tracking || this.trackPending) return;
    const button = $('track-position');
    let stream, video, timer;
    button.disabled = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: false});
      video = node('video');
      video.muted = true;
      video.playsInline = true;
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none';
      video.srcObject = stream;
      document.body.append(video);
      await video.play();
      if (!video.videoWidth) {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Capture timed out')), 4000);
          video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, {once: true});
        });
      }
      const snapshot = await createImageBitmap(video);
      if (!$('position-dialog').open) throw Error('Capture cancelled');
      this.trackStream = stream;
      this.trackVideo = video;
      this.trackPending = true;
      this.trackSource = {width: video.videoWidth, height: video.videoHeight};
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopTracking('Screen sharing ended.'));
      this.loadImage(snapshot);
      $('tracking-help').hidden = false;
      this.captureError('Keep the in-game map still. Click the player arrow, then two landmarks.');
    } catch {
      if (stream) stream.getTracks().forEach(track => track.stop());
      video?.remove();
      this.trackStream = null;
      this.trackVideo = null;
      this.trackSource = null;
      this.trackPending = false;
      if ($('position-dialog').open) this.captureError('Screen capture did not start. Choose a window and try again.');
    } finally {
      clearTimeout(timer);
      button.disabled = false;
    }
  }

  beginTracking() {
    const stream = this.trackStream, video = this.trackVideo;
    const canvas = $('position-screenshot');
    if (!stream || !video || !this.image || this.screenshotPoints.length < 3 ||
        this.mapPoints.length < 2 || !this.trackSource) {
      this.stopTracking();
      notify('Live tracking needs a fresh capture and calibration.');
      return;
    }
    if (video.videoWidth !== this.trackSource.width || video.videoHeight !== this.trackSource.height) {
      this.stopTracking('The captured window changed size. Recalibrate before tracking.');
      return;
    }
    const width = canvas.width, height = canvas.height;
    const context = canvas.getContext('2d');
    let arrow, landmarks;
    try {
      context.clearRect(0, 0, width, height);
      context.drawImage(this.image, 0, 0, width, height);
      const frame = context.getImageData(0, 0, width, height);
      const gray = LeonidaTracker.grayscale(frame.data, width, height);
      arrow = LeonidaTracker.crop(gray, width, height, this.screenshotPoints[0].x, this.screenshotPoints[0].y, 13);
      landmarks = [1, 2].map(index => ({
        template: LeonidaTracker.crop(gray, width, height,
          this.screenshotPoints[index].x, this.screenshotPoints[index].y, 33),
        home: {...this.screenshotPoints[index]},
      }));
    } catch (error) {
      this.stopTracking();
      this.captureError(error.message + ' Recalibrate with points farther from the edge.');
      notify('Choose the player arrow and landmarks away from the screen edge.');
      return;
    }
    const calibration = {
      screenshotA: {...this.screenshotPoints[1]},
      screenshotB: {...this.screenshotPoints[2]},
      mapA: {...this.mapPoints[0]},
      mapB: {...this.mapPoints[1]},
    };
    this.trackPending = false;
    this.tracking = {
      stream, video, canvas, context, width, height, arrow, landmarks, calibration,
      last: {...this.screenshotPoints[0]},
      misses: 0, savedAt: 0, busy: false, timer: null,
    };
    this.resetImage();
    $('tracking-status').hidden = false;
    $('tracking-text').textContent = 'Tracking live position — keep the in-game map still';
    this.tracking.timer = setInterval(() => this.trackFrame(), 1000);
    this.trackFrame();
  }

  async trackFrame() {
    const tracking = this.tracking;
    if (!tracking || tracking.busy || document.hidden) return;
    const {video, context, width, height, arrow, landmarks, calibration} = tracking;
    if (!video.videoWidth || video.readyState < 2) return;
    if (video.videoWidth !== this.trackSource.width || video.videoHeight !== this.trackSource.height) {
      this.stopTracking('The captured window changed size. Recalibrate.');
      return;
    }
    tracking.busy = true;
    try {
      context.drawImage(video, 0, 0, width, height);
      const gray = LeonidaTracker.grayscale(context.getImageData(0, 0, width, height).data, width, height);
      const stable = landmarks.some(({template, home}) => {
        const fixed = LeonidaTracker.match(gray, width, height, template, {
          center: home, radius: 10, rotations: 1,
        });
        return fixed.score >= 0.55 && Math.hypot(fixed.x - home.x, fixed.y - home.y) <= 4;
      });
      if (!stable) {
        this.stopTracking('The in-game map moved. Keep it still and recalibrate.');
        return;
      }
      let found = LeonidaTracker.match(gray, width, height, arrow, {
        center: tracking.last, radius: 96, rotations: 8, stride: 2,
      });
      if (found.score > 0.45) {
        const fine = LeonidaTracker.match(gray, width, height, arrow, {
          center: found, radius: 5, rotations: 8,
        });
        if (fine.score > found.score) found = fine;
      }
      if (found.score < 0.5) {
        tracking.misses++;
        if (tracking.misses >= 3) this.stopTracking('Lost the player arrow. Recalibrate while the map is open.');
        else $('tracking-text').textContent = 'Tracking live position — looking for the player arrow';
        return;
      }
      tracking.misses = 0;
      const point = mapPosition(found, calibration.screenshotA, calibration.screenshotB,
        calibration.mapA, calibration.mapB);
      if (![point.x, point.y].every(value => value >= 0 && value <= 1024)) {
        this.stopTracking('Tracked point fell outside the map. Recalibrate.');
        return;
      }
      tracking.last = {x: found.x, y: found.y};
      const previous = this.position;
      const moved = !previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 0.4;
      if (moved || Date.now() - tracking.savedAt > 5000) {
        const saved = {...point, source: 'video'};
        await api('/api/player-position', saved);
        if (this.tracking !== tracking) return;
        tracking.savedAt = Date.now();
        this.position = {...saved, updated: new Date().toISOString()};
        mapPayload.position = this.position;
        this.candidate = null;
        this.renderPosition();
        $('last-position').textContent = 'Live position · ' + date(this.position.updated);
      }
      $('tracking-text').textContent = 'Tracking live position · confidence ' + Math.round(found.score * 100) + '%';
    } catch (error) {
      this.stopTracking(error.message || 'Live tracking stopped.');
    } finally {
      if (this.tracking === tracking) tracking.busy = false;
    }
  }

  stopTracking(message) {
    const tracking = this.tracking;
    const stream = this.trackStream;
    const video = this.trackVideo;
    this.tracking = null;
    this.trackPending = false;
    this.trackStream = null;
    this.trackVideo = null;
    this.trackSource = null;
    if (tracking?.timer) clearInterval(tracking.timer);
    stream?.getTracks().forEach(track => track.stop());
    if (video) {
      video.pause?.();
      video.srcObject = null;
      video.remove?.();
    }
    if ($('tracking-status')) $('tracking-status').hidden = true;
    $('tracking-help').hidden = true;
    if (message) notify(message);
  }

  loadImage(image) {
    if (!$('position-dialog').open) {
      image.close();
      return;
    }
    this.resetImage();
    this.image = image;
    this.screenshotPoints = [];
    this.mapPoints = [];
    const canvas = $('position-screenshot');
    const scale = Math.min(1, 1280 / image.width, 900 / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.hidden = false;
    this.paintImage();
  }

  paintImage() {
    const canvas = $('position-screenshot');
    const context = canvas.getContext('2d');
    context.drawImage(this.image, 0, 0, canvas.width, canvas.height);
    this.screenshotPoints.forEach((point, index) => {
      context.beginPath();
      context.arc(point.x, point.y, 12, 0, Math.PI * 2);
      context.fillStyle = ['#247fca', '#84456d', '#84456d'][index];
      context.fill();
      context.fillStyle = '#fff';
      context.font = 'bold 13px system-ui';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(['●', 'A', 'B'][index], point.x, point.y);
    });
    this.captureError(['Click the player arrow in the paused map screenshot.',
      'Click a road junction or landmark near the player. This is A.',
      'Click a second landmark farther away. This is B.'][this.screenshotPoints.length]);
  }

  screenshotClick(event) {
    if (!this.image || this.screenshotPoints.length >= 3) return;
    const canvas = $('position-screenshot');
    const box = canvas.getBoundingClientRect();
    const point = {x: (event.clientX - box.left) * canvas.width / box.width,
      y: (event.clientY - box.top) * canvas.height / box.height};
    this.screenshotPoints.push(point);
    if (this.screenshotPoints.length === 3) {
      this.startMapping('calibrate', 'Tap landmark A on Leonida.');
    } else {
      this.paintImage();
    }
  }

  startMapping(mode, message) {
    setWaypointMode(false);
    if (mobile.matches) showView(null);
    this.closingForMapping = true;
    $('position-dialog').close();
    this.mode = mode;
    $('position-step').hidden = false;
    $('position-instruction').replaceChildren(node('span', message));
    this.redraw();
  }

  cancelMapping() {
    this.mode = null;
    this.candidate = null;
    $('position-step').hidden = true;
    this.renderPosition();
    this.redraw();
  }

  mapClick(latlng) {
    const point = {x: latlng.lng, y: -latlng.lat};
    if (!['map', 'calibrate'].includes(this.mode)) return;
    if (this.mode === 'map') {
      this.preview({...point, source: 'map'});
      return;
    }
    this.mapPoints.push(point);
    if (this.mapPoints.length === 1) {
      $('position-instruction').textContent = 'Tap landmark B on Leonida.';
      return;
    }
    try {
      this.preview({...mapPosition(...this.screenshotPoints, ...this.mapPoints), source: 'screenshot'});
    } catch (error) {
      this.trackPending = false;
      this.stopTracking();
      this.cancelMapping();
      notify(error.message);
    }
  }

  preview(point) {
    if (![point.x, point.y].every(value => value >= 0 && value <= 1024)) {
      this.trackPending = false;
      this.stopTracking();
      this.cancelMapping();
      notify('The estimated point is outside the map. Try again with two clear landmarks.');
      return;
    }
    this.candidate = point;
    this.mode = 'confirm';
    this.renderPosition();
    this.focus(point);
    $('position-instruction').replaceChildren(actions('Save this location', async () => {
      const tracking = this.trackPending;
      try {
        await api('/api/player-position', point);
        this.cancelMapping();
        await refreshMap();
        if (tracking) this.beginTracking();
        else {
          this.resetCalibration();
          notify('Player location saved.');
        }
      } catch (error) {
        if (tracking) this.stopTracking();
        throw error;
      }
    }, 'primary'));
  }
}
