const FACE_NAMES = ["px", "nx", "py", "ny", "pz", "nz"];
const BASE_SIZE = 4096;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function wrap(v, max) {
  let out = v % max;
  if (out < 0) out += max;
  return out;
}

function getDir(face, a, b) {
  switch (face) {
    case "px": return [1, -b, -a];
    case "nx": return [-1, -b, a];
    case "py": return [a, 1, b];
    case "ny": return [a, -1, -b];
    case "pz": return [a, -b, 1];
    case "nz": return [-a, -b, -1];
    default: return [1, -b, -a];
  }
}

function normalize(vx, vy, vz) {
  const len = Math.hypot(vx, vy, vz) || 1;
  return [vx / len, vy / len, vz / len];
}

function sampleBilinear(src, sw, sh, u, v) {
  const x = u * (sw - 1);
  const y = v * (sh - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = wrap(x0 + 1, sw);
  const y1 = clamp(y0 + 1, 0, sh - 1);
  const wx = x - x0;
  const wy = y - y0;

  const i00 = (y0 * sw + wrap(x0, sw)) * 4;
  const i10 = (y0 * sw + x1) * 4;
  const i01 = (y1 * sw + wrap(x0, sw)) * 4;
  const i11 = (y1 * sw + x1) * 4;

  const out = [0, 0, 0, 255];
  for (let c = 0; c < 3; c++) {
    const v00 = src[i00 + c];
    const v10 = src[i10 + c];
    const v01 = src[i01 + c];
    const v11 = src[i11 + c];
    const v0 = v00 * (1 - wx) + v10 * wx;
    const v1 = v01 * (1 - wx) + v11 * wx;
    out[c] = Math.round(v0 * (1 - wy) + v1 * wy);
  }
  return out;
}

function sendProgress(overallPct, message, face, generatedFiles) {
  self.postMessage({
    type: "progress",
    overallPct,
    message,
    face,
    generatedFiles
  });
}

async function canvasToJpegBlob(canvas, quality) {
  return await canvas.convertToBlob({ type: "image/jpeg", quality });
}

async function sendFile(folder, name, blob) {
  self.postMessage({
    type: "file",
    folder,
    name,
    blob
  });
}

async function renderFaceCanvas(srcPixels, srcW, srcH, face, size, faceIndex, generatedFilesRef) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
  const out = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    const b = 2 * ((y + 0.5) / size) - 1;
    for (let x = 0; x < size; x++) {
      const a = 2 * ((x + 0.5) / size) - 1;
      const dir = getDir(face, a, b);
      const n = normalize(dir[0], dir[1], dir[2]);
      // Use right-handed yaw to avoid horizontal mirroring in output faces.
      const theta = Math.atan2(-n[2], n[0]);
      const phi = Math.asin(clamp(n[1], -1, 1));
      const u = (theta + Math.PI) / (2 * Math.PI);
      const v = (Math.PI / 2 - phi) / Math.PI;
      const rgb = sampleBilinear(srcPixels, srcW, srcH, u, v);
      const i = (y * size + x) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = 255;
    }

    if (y % 128 === 0 || y === size - 1) {
      const renderPart = (faceIndex + (y + 1) / size) / 6;
      const overallPct = Math.round(renderPart * 80);
      sendProgress(overallPct, "Rendering " + face + " (" + (y + 1) + "/" + size + ")", face, generatedFilesRef.value);
    }
  }

  ctx.putImageData(new ImageData(out, size, size), 0, 0);
  return canvas;
}

async function createResizedCanvas(srcCanvas, size) {
  const out = new OffscreenCanvas(size, size);
  const ctx = out.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, size, size);
  return out;
}

async function splitAndSendTiles(canvas, face, rows, cols, tileSize, folder, quality, generatedFilesRef) {
  const tileCanvas = new OffscreenCanvas(tileSize, tileSize);
  const tctx = tileCanvas.getContext("2d", { alpha: false });
  const sourceTileW = canvas.width / cols;
  const sourceTileH = canvas.height / rows;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tctx.clearRect(0, 0, tileSize, tileSize);
      tctx.drawImage(
        canvas,
        Math.round(col * sourceTileW),
        Math.round(row * sourceTileH),
        Math.round(sourceTileW),
        Math.round(sourceTileH),
        0,
        0,
        tileSize,
        tileSize
      );
      const blob = await canvasToJpegBlob(tileCanvas, quality);
      await sendFile(folder, face + "_" + row + "_" + col + ".jpeg", blob);
      generatedFilesRef.value += 1;
    }
  }
}

self.onmessage = async (event) => {
  try {
    const imageBitmap = event.data.imageBitmap;
    const quality = event.data.quality;
    const generatedFiles = { value: 0 };

    sendProgress(1, "Preparing source image data", "-", generatedFiles.value);

    const srcW = imageBitmap.width;
    const srcH = imageBitmap.height;
    const srcCanvas = new OffscreenCanvas(srcW, srcH);
    const srcCtx = srcCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    srcCtx.drawImage(imageBitmap, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

    for (let i = 0; i < FACE_NAMES.length; i++) {
      const face = FACE_NAMES[i];
      sendProgress(Math.round((i / 6) * 80), "Start face " + face, face, generatedFiles.value);

      const c4096 = await renderFaceCanvas(srcData, srcW, srcH, face, BASE_SIZE, i, generatedFiles);

      const b4096 = await canvasToJpegBlob(c4096, quality);
      await sendFile("4096", face + ".jpeg", b4096);
      generatedFiles.value += 1;

      const c2048 = await createResizedCanvas(c4096, 2048);
      const b2048 = await canvasToJpegBlob(c2048, quality);
      await sendFile("2048", face + ".jpeg", b2048);
      generatedFiles.value += 1;

      const c1024 = await createResizedCanvas(c4096, 1024);
      const b1024 = await canvasToJpegBlob(c1024, quality);
      await sendFile("1024", face + ".jpeg", b1024);
      generatedFiles.value += 1;

      await splitAndSendTiles(c4096, face, 4, 4, 1024, "4096_1024_tiles", quality, generatedFiles);
      await splitAndSendTiles(c2048, face, 2, 2, 1024, "2048_1024_tiles", quality, generatedFiles);

      sendProgress(
        80 + Math.round(((i + 1) / 6) * 10),
        "Finished face " + face,
        face,
        generatedFiles.value
      );
    }

    sendProgress(90, "All images generated, finalizing", "-", generatedFiles.value);
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error && error.message ? error.message : String(error)
    });
  }
};
