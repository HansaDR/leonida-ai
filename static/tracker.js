'use strict';

/*
 * Local-only template matching for Leonida live position tracking.
 *
 * The tracker receives frames from a user-selected window (PS Remote Play or a
 * capture-card preview), finds the player arrow and one fixed landmark, and
 * maps the arrow to Leonida coordinates. Nothing here uploads a frame.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LeonidaTracker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function grayscale(data, width, height) {
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return gray;
  }

  function crop(gray, width, height, centerX, centerY, size) {
    if (!Number.isInteger(size) || size < 3 || size % 2 === 0) {
      throw Error('Template size must be an odd integer.');
    }
    const half = (size - 1) / 2;
    const left = Math.round(centerX - half);
    const top = Math.round(centerY - half);
    if (left < 0 || top < 0 || left + size > width || top + size > height) {
      throw Error('Choose a point away from the edge of the capture.');
    }
    const data = new Uint8ClampedArray(size * size);
    for (let y = 0; y < size; y++) {
      const start = (top + y) * width + left;
      data.set(gray.subarray(start, start + size), y * size);
    }
    return {data, size, left, top};
  }

  function rotate(template, angle) {
    const size = template.size;
    const center = (size - 1) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const data = new Uint8ClampedArray(size * size);
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - center;
        const dy = y - center;
        const sx = Math.round(center + dx * cos + dy * sin);
        const sy = Math.round(center - dx * sin + dy * cos);
        if (sx < 0 || sy < 0 || sx >= size || sy >= size) continue;
        const index = y * size + x;
        data[index] = template.data[sy * size + sx];
        mask[index] = 1;
      }
    }
    return {data, mask, size};
  }

  function match(gray, width, height, template, options = {}) {
    const size = template.size;
    const half = (size - 1) / 2;
    const radius = options.radius ?? 48;
    const rotations = Math.max(1, Math.round(options.rotations ?? 1));
    const stride = Math.max(1, Math.round(options.stride ?? 1));
    const center = options.center;
    const minX = center ? Math.max(half, Math.floor(center.x - radius)) : half;
    const maxX = center ? Math.min(width - 1 - half, Math.ceil(center.x + radius)) : width - 1 - half;
    const minY = center ? Math.max(half, Math.floor(center.y - radius)) : half;
    const maxY = center ? Math.min(height - 1 - half, Math.ceil(center.y + radius)) : height - 1 - half;
    if (maxX < minX || maxY < minY) return {x: center?.x ?? 0, y: center?.y ?? 0, score: -1, angle: 0};

    let best = {x: center?.x ?? 0, y: center?.y ?? 0, score: -1, angle: 0};
    for (let rotation = 0; rotation < rotations; rotation++) {
      const angle = rotation * Math.PI * 2 / rotations;
      const candidate = rotation === 0 ? {data: template.data, mask: null, size} : rotate(template, angle);
      let templateSum = 0;
      let templateSquareSum = 0;
      let templateCount = 0;
      for (let i = 0; i < candidate.data.length; i++) {
        if (candidate.mask && !candidate.mask[i]) continue;
        const value = candidate.data[i];
        templateSum += value;
        templateSquareSum += value * value;
        templateCount++;
      }
      if (!templateCount) continue;

      for (let y = minY; y <= maxY; y += stride) {
        const top = y - half;
        for (let x = minX; x <= maxX; x += stride) {
          const left = x - half;
          let imageSum = 0;
          let imageSquareSum = 0;
          let productSum = 0;
          for (let ty = 0; ty < size; ty++) {
            const row = (top + ty) * width + left;
            const templateRow = ty * size;
            for (let tx = 0; tx < size; tx++) {
              const index = templateRow + tx;
              if (candidate.mask && !candidate.mask[index]) continue;
              const value = gray[row + tx];
              imageSum += value;
              imageSquareSum += value * value;
              productSum += value * candidate.data[index];
            }
          }
          const variance = (templateCount * imageSquareSum - imageSum * imageSum) *
            (templateCount * templateSquareSum - templateSum * templateSum);
          const score = variance > 0 ? (templateCount * productSum - imageSum * templateSum) / Math.sqrt(variance) : 0;
          if (score > best.score) best = {x, y, score, angle};
        }
      }
    }
    return best;
  }

  function mapPoint(player, screenshotA, screenshotB, mapA, mapB) {
    const dx = screenshotB.x - screenshotA.x;
    const dy = screenshotB.y - screenshotA.y;
    const vx = mapB.x - mapA.x;
    const vy = mapB.y - mapA.y;
    const length = dx * dx + dy * dy;
    if (length < 400 || Math.hypot(vx, vy) < 1) throw Error('Choose two landmarks farther apart.');
    const px = player.x - screenshotA.x;
    const py = player.y - screenshotA.y;
    const along = (px * dx + py * dy) / length;
    const across = (py * dx - px * dy) / length;
    return {x: mapA.x + along * vx - across * vy, y: mapA.y + along * vy + across * vx};
  }

  return {grayscale, crop, rotate, match, mapPoint};
});
