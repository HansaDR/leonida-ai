import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {crop, grayscale, match, mapPoint, rotate} = require('./static/tracker.js');

const WIDTH = 180;
const HEIGHT = 140;

function background() {
  const gray = new Uint8ClampedArray(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      gray[y * WIDTH + x] = 18 + ((x * 7 + y * 11 + x * y) % 37);
    }
  }
  return gray;
}

function stamp(gray, template, centerX, centerY, lift = 0) {
  const size = template.size;
  const half = (size - 1) / 2;
  const left = centerX - half;
  const top = centerY - half;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (template.mask && !template.mask[index]) continue;
      gray[(top + y) * WIDTH + left + x] = Math.max(0, Math.min(255, template.data[index] + lift));
    }
  }
}

function arrow(size = 15) {
  const data = new Uint8ClampedArray(size * size);
  const mask = new Uint8Array(size * size);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const vertical = Math.abs(dx) <= 1 && Math.abs(dy) <= 5;
      const horizontal = Math.abs(dy) <= 1 && dx >= -5 && dx <= 3;
      const tip = dx >= 3 && dx <= 5 && dy >= -5 && dy <= -3;
      const index = y * size + x;
      if (vertical || horizontal || tip) {
        data[index] = 235;
        mask[index] = 1;
      }
    }
  }
  return {data, mask, size};
}

// A cropped real template follows the arrow when it moves and brightness changes.
let first = new Uint8ClampedArray(WIDTH * HEIGHT).fill(40);
stamp(first, arrow(), 50, 60);
const cropped = crop(first, WIDTH, HEIGHT, 50, 60, 15);
let second = new Uint8ClampedArray(WIDTH * HEIGHT).fill(40);
stamp(second, {data: cropped.data, size: cropped.size}, 90, 70, 22);
let found = match(second, WIDTH, HEIGHT, cropped, {center: {x: 50, y: 60}, radius: 60, rotations: 1});
assert.ok(Math.abs(found.x - 90) <= 1, `x was ${found.x}`);
assert.ok(Math.abs(found.y - 70) <= 1, `y was ${found.y}`);
assert.ok(found.score > 0.94, `score was ${found.score}`);

// Rotation search finds the same center when the player arrow turns.
const shape = arrow();
const turned = rotate(shape, Math.PI / 2);
const rotatedFrame = background();
stamp(rotatedFrame, turned, 112, 76);
found = match(rotatedFrame, WIDTH, HEIGHT, shape, {
  center: {x: 112, y: 76}, radius: 10, rotations: 8,
});
assert.ok(Math.abs(found.x - 112) <= 1, `rotated x was ${found.x}`);
assert.ok(Math.abs(found.y - 76) <= 1, `rotated y was ${found.y}`);
assert.ok(found.score > 0.9, `rotated score was ${found.score}`);

// The projection used by the existing calibration flow still maps correctly.
assert.deepEqual(
  mapPoint({x: 150, y: 100}, {x: 50, y: 50}, {x: 250, y: 50}, {x: 300, y: 400}, {x: 380, y: 400}),
  {x: 340, y: 420},
);
assert.throws(() => mapPoint({x: 0, y: 0}, {x: 0, y: 0}, {x: 5, y: 5}, {x: 0, y: 0}, {x: 1, y: 0}),
  /landmarks farther apart/);

// Grayscale conversion keeps the expected luminance for a known pixel.
const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
assert.deepEqual([...grayscale(rgba, 2, 1)], [76, 149]);

// Cropping refuses a template that runs off the capture.
assert.throws(() => crop(first, WIDTH, HEIGHT, 2, 2, 15), /edge of the capture/);

console.log('Tracker fixtures passed');
