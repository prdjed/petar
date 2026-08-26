/**
 * Pixelation filter.
 *
 * level = how many blocks per side of the image.
 *   level 1 -> whole image becomes 1 pixel (1x1 grid)
 *   level 2 -> image divided into 2x2 = 4 blocks
 *   level 3 -> image divided into 3x3 = 9 blocks
 *   ...and so on
 *
 * source: an image-like object (HTMLImageElement, HTMLCanvasElement, HTMLVideoElement)
 * outputCanvas: the <canvas> to draw the pixelated result into (its width/height define the output size)
 */
function createDownscaledSource(source, level) {
  const small = document.createElement("canvas");
  small.width = level;
  small.height = level;

  const smallCtx = small.getContext("2d");
  smallCtx.drawImage(source, 0, 0, level, level);

  return small;
}

function pixelate(source, level, outputCanvas) {
  level = Math.max(1, Math.floor(level));

  const width = outputCanvas.width;
  const height = outputCanvas.height;

  // Downscale the source into a level x level canvas, letting the browser's
  // image smoothing average each block's color, then blow it back up with
  // smoothing off so each block renders as a single flat-colored square.
  const small = createDownscaledSource(source, level);

  const ctx = outputCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(small, 0, 0, level, level, 0, 0, width, height);
}

/**
 * Same block grid as pixelate(), but instead of keeping each block's
 * average color, it computes that block's darkness (from luminance) and
 * fills it with the matching shade of black/gray - dark areas of the
 * photo become near-black squares, bright areas stay near-white.
 */
function pixelateDarkness(source, level, outputCanvas) {
  level = Math.max(1, Math.floor(level));

  const width = outputCanvas.width;
  const height = outputCanvas.height;

  // Same downscale trick to get one averaged color per block.
  const small = createDownscaledSource(source, level);
  const smallCtx = small.getContext("2d");

  // Replace each block's color with a gray shade matching its darkness.
  const imageData = smallCtx.getImageData(0, 0, level, level);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b; // 0 = black, 255 = white
    data[i] = data[i + 1] = data[i + 2] = luminance;
  }
  smallCtx.putImageData(imageData, 0, 0);

  const ctx = outputCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(small, 0, 0, level, level, 0, 0, width, height);
}

/**
 * Darkness -> line-pattern lookup table for pixelateHatch().
 *
 * `max` is the upper bound (inclusive) of the darkness percentage
 * (0 = pure white, 100 = pure black) that this entry applies to.
 * `vertical` / `horizontal` are how many lines get drawn in the block.
 *
 * TWEAK HERE: edit the `max` thresholds or the vertical/horizontal counts
 * to change which pattern shows up for which darkness range, or add/remove
 * rows entirely.
 */
const HATCH_LEVELS = [
  { max: 10, vertical: 0, horizontal: 0 },
  { max: 20, vertical: 1, horizontal: 0 },
  { max: 30, vertical: 2, horizontal: 0 },
  { max: 40, vertical: 3, horizontal: 0 },
  { max: 50, vertical: 4, horizontal: 0 },
  { max: 60, vertical: 4, horizontal: 1 },
  { max: 70, vertical: 4, horizontal: 2 },
  { max: 80, vertical: 4, horizontal: 3 },
  { max: 100, vertical: 4, horizontal: 4 },
];

function getHatchLevelIndex(darkness) {
  for (let i = 0; i < HATCH_LEVELS.length; i++) {
    if (darkness <= HATCH_LEVELS[i].max) return i;
  }
  return HATCH_LEVELS.length - 1;
}

// Draws one pattern (transparent background + N vertical/horizontal black
// lines) into a real PNG (via canvas.toDataURL) and returns it as an <img>.
function createHatchPatternImage(vertical, horizontal, size, lineWidth, color) {
  const stamp = document.createElement("canvas");
  stamp.width = size;
  stamp.height = size;
  const ctx = stamp.getContext("2d");
  ctx.clearRect(0, 0, size, size); // stays transparent where no line is drawn

  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (let i = 1; i <= vertical; i++) {
    const x = (size * i) / (vertical + 1);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
  }
  for (let j = 1; j <= horizontal; j++) {
    const y = (size * j) / (horizontal + 1);
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
  }
  ctx.stroke();

  const img = new Image();
  img.src = stamp.toDataURL("image/png");
  return img;
}

/**
 * Generates one transparent PNG per row of HATCH_LEVELS, ready to be used
 * by pixelateHatch(). Call this once (it's async because <img> decoding
 * from a data URL happens off the main thread) and reuse the resulting
 * array across renders.
 *
 * TWEAK HERE: `size` (pixel resolution of each stamp before it's scaled
 * into a block), `lineWidth`, and `color` of the drawn lines.
 */
function generateHatchPatternImages(options) {
  options = options || {};
  const size = options.size || 100;
  const lineWidth = options.lineWidth || 4;
  const color = options.color || "#000000";

  const images = HATCH_LEVELS.map((level) =>
    createHatchPatternImage(level.vertical, level.horizontal, size, lineWidth, color)
  );

  return Promise.all(
    images.map(
      (img) =>
        new Promise((resolve) => {
          if (img.complete) resolve();
          else img.onload = () => resolve();
        })
    )
  ).then(() => images);
}

/**
 * Same block grid as pixelate()/pixelateDarkness(), but each block is
 * painted with crisp, pixel-aligned hatch lines chosen by that block's
 * darkness, looking up the range in HATCH_LEVELS. Transparent blocks and
 * blocks below the first threshold are left empty.
 */
function pixelateHatch(source, level, outputCanvas) {
  level = Math.max(1, Math.floor(level));

  const width = outputCanvas.width;
  const height = outputCanvas.height;

  const small = createDownscaledSource(source, level);
  const smallCtx = small.getContext("2d");

  const imageData = smallCtx.getImageData(0, 0, level, level);
  const data = imageData.data;

  const ctx = outputCanvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  for (let row = 0; row < level; row++) {
    for (let col = 0; col < level; col++) {
      const i = (row * level + col) * 4;
      if (data[i + 3] === 0) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b; // 0 black - 255 white
      const darkness = ((255 - luminance) / 255) * 100; // 0 white - 100 black

      const idx = getHatchLevelIndex(darkness);
      const pattern = HATCH_LEVELS[idx];
      if (pattern.vertical === 0 && pattern.horizontal === 0) continue; // leave empty

      const x = Math.round((col * width) / level);
      const y = Math.round((row * height) / level);
      const nextX = Math.round(((col + 1) * width) / level);
      const nextY = Math.round(((row + 1) * height) / level);

      drawHatchCell(ctx, x, y, nextX - x, nextY - y, pattern.vertical, pattern.horizontal);
    }
  }
}

function drawHatchCell(ctx, x, y, width, height, vertical, horizontal) {
  const lineWidth = Math.max(1, Math.min(4, Math.round(Math.min(width, height) * 0.06)));

  ctx.fillStyle = "#000000";

  for (let i = 1; i <= vertical; i++) {
    const lineX = Math.round(x + (width * i) / (vertical + 1) - lineWidth / 2);
    ctx.fillRect(lineX, y, lineWidth, height);
  }

  for (let j = 1; j <= horizontal; j++) {
    const lineY = Math.round(y + (height * j) / (horizontal + 1) - lineWidth / 2);
    ctx.fillRect(x, lineY, width, lineWidth);
  }
}
