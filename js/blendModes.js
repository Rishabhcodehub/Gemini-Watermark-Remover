const ALPHA_THRESHOLD = 0.002;
const MAX_ALPHA = 0.99;
const LOGO_VALUE = 255;

/**
 * Mathematical Reverse Alpha Blending for Gemini AI Images.
 */
export function removeWatermark(imageData, alphaMap, position) {
    const { x, y, width, height } = position;

    for (let row = 0; row < height; row++) {
        const curY = y + row;
        if (curY < 0 || curY >= imageData.height) continue;
        for (let col = 0; col < width; col++) {
            const curX = x + col;
            if (curX < 0 || curX >= imageData.width) continue;

            const imgIdx = (curY * imageData.width + curX) * 4;
            const alphaIdx = row * width + col;
            
            let alpha = alphaMap[alphaIdx];
            if (alpha < ALPHA_THRESHOLD) continue;
            alpha = Math.min(alpha, MAX_ALPHA);

            for (let c = 0; c < 3; c++) {
                const watermarked = imageData.data[imgIdx + c];
                // Reverse Alpha Blending Formula
                const original = (watermarked - alpha * LOGO_VALUE) / (1.0 - alpha);
                imageData.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
            }
        }
    }
}

/**
 * High-performance edge-preserving anisotropic isophote reconstruction for Video Watermarks (Veo).
 * Confined strictly to watermark letter strokes: 0% blur on background pixels, 100% original texture preserved.
 */
export function removeVideoWatermark(imageData, mask, position) {
    const { x, y, width, height } = position;
    const data = imageData.data;
    const imgWidth = imageData.width;
    const imgHeight = imageData.height;

    const pad = 3;
    const x0 = Math.max(0, x - pad);
    const y0 = Math.max(0, y - pad);
    const x1 = Math.min(imgWidth, x + width + pad);
    const y1 = Math.min(imgHeight, y + height + pad);

    const roiW = x1 - x0;
    const roiH = y1 - y0;
    if (roiW <= 0 || roiH <= 0) return;

    // Buffer allocations
    const size = roiW * roiH;
    const uR = new Float32Array(size);
    const uG = new Float32Array(size);
    const uB = new Float32Array(size);
    const nxtR = new Float32Array(size);
    const nxtG = new Float32Array(size);
    const nxtB = new Float32Array(size);
    const isHole = new Uint8Array(size);

    let holeCount = 0;

    // 1. Copy initial ROI and mark hole region ONLY for masked letter pixels
    for (let r = 0; r < roiH; r++) {
        const maskRow = r - (y - y0);
        for (let c = 0; c < roiW; c++) {
            const idx = r * roiW + c;
            const imgIdx = ((y0 + r) * imgWidth + (x0 + c)) * 4;
            uR[idx] = data[imgIdx];
            uG[idx] = data[imgIdx + 1];
            uB[idx] = data[imgIdx + 2];

            const maskCol = c - (x - x0);
            if (maskRow >= 0 && maskRow < height && maskCol >= 0 && maskCol < width) {
                const maskIdx = maskRow * width + maskCol;
                if (mask && mask[maskIdx] > 0.08) {
                    isHole[idx] = 1;
                    holeCount++;
                }
            }
        }
    }

    if (holeCount === 0) return;

    // 2. Initialize hole pixels from closest unmasked boundary in 4 directions
    for (let r = 0; r < roiH; r++) {
        for (let c = 0; c < roiW; c++) {
            const idx = r * roiW + c;
            if (!isHole[idx]) continue;

            let rUp = r; while (rUp > 0 && isHole[rUp * roiW + c]) rUp--;
            let rDn = r; while (rDn < roiH - 1 && isHole[rDn * roiW + c]) rDn++;
            let cLf = c; while (cLf > 0 && isHole[r * roiW + cLf]) cLf--;
            let cRt = c; while (cRt < roiW - 1 && isHole[r * roiW + cRt]) cRt++;

            const dUp = Math.max(1, r - rUp);
            const dDn = Math.max(1, rDn - r);
            const dLf = Math.max(1, c - cLf);
            const dRt = Math.max(1, cRt - c);

            const wU = 1.0 / dUp;
            const wD = 1.0 / dDn;
            const wL = 1.0 / dLf;
            const wR = 1.0 / dRt;
            const wTot = wU + wD + wL + wR;

            const idxUp = rUp * roiW + c;
            const idxDn = rDn * roiW + c;
            const idxLf = r * roiW + cLf;
            const idxRt = r * roiW + cRt;

            uR[idx] = (wU * uR[idxUp] + wD * uR[idxDn] + wL * uR[idxLf] + wR * uR[idxRt]) / wTot;
            uG[idx] = (wU * uG[idxUp] + wD * uG[idxDn] + wL * uG[idxLf] + wR * uG[idxRt]) / wTot;
            uB[idx] = (wU * uB[idxUp] + wD * uB[idxDn] + wL * uB[idxLf] + wR * uB[idxRt]) / wTot;
        }
    }

    // 3. 30 Iterations of Anisotropic Isophote Relaxation on HOLE pixels only
    const wx = new Float32Array(size);
    const wy = new Float32Array(size);

    for (let iter = 0; iter < 30; iter++) {
        for (let r = 1; r < roiH - 1; r++) {
            for (let c = 1; c < roiW - 1; c++) {
                const idx = r * roiW + c;
                const lumL = 0.299 * uR[idx - 1] + 0.587 * uG[idx - 1] + 0.114 * uB[idx - 1];
                const lumR = 0.299 * uR[idx + 1] + 0.587 * uG[idx + 1] + 0.114 * uB[idx + 1];
                const lumT = 0.299 * uR[idx - roiW] + 0.587 * uG[idx - roiW] + 0.114 * uB[idx - roiW];
                const lumB = 0.299 * uR[idx + roiW] + 0.587 * uG[idx + roiW] + 0.114 * uB[idx + roiW];

                const gx = Math.abs((lumR - lumL) * 0.5);
                const gy = Math.abs((lumB - lumT) * 0.5);
                const gSum = gx + gy + 0.001;

                wx[idx] = 1.0 + 4.0 * (gy / gSum);
                wy[idx] = 1.0 + 4.0 * (gx / gSum);
            }
        }

        for (let r = 1; r < roiH - 1; r++) {
            for (let c = 1; c < roiW - 1; c++) {
                const idx = r * roiW + c;
                if (!isHole[idx]) continue;

                const topIdx = idx - roiW;
                const botIdx = idx + roiW;
                const leftIdx = idx - 1;
                const rightIdx = idx + 1;

                const topW = wy[topIdx] * (!isHole[topIdx] ? 4.0 : 1.0);
                const botW = wy[botIdx] * (!isHole[botIdx] ? 4.0 : 1.0);
                const leftW = wx[leftIdx] * (!isHole[leftIdx] ? 4.0 : 1.0);
                const rightW = wx[rightIdx] * (!isHole[rightIdx] ? 4.0 : 1.0);
                const totalW = topW + botW + leftW + rightW;

                nxtR[idx] = (topW * uR[topIdx] + botW * uR[botIdx] + leftW * uR[leftIdx] + rightW * uR[rightIdx]) / totalW;
                nxtG[idx] = (topW * uG[topIdx] + botW * uG[botIdx] + leftW * uG[leftIdx] + rightW * uG[rightIdx]) / totalW;
                nxtB[idx] = (topW * uB[topIdx] + botW * uB[botIdx] + leftW * uB[leftIdx] + rightW * uB[rightIdx]) / totalW;
            }
        }

        for (let r = 1; r < roiH - 1; r++) {
            for (let c = 1; c < roiW - 1; c++) {
                const idx = r * roiW + c;
                if (!isHole[idx]) continue;
                uR[idx] = nxtR[idx];
                uG[idx] = nxtG[idx];
                uB[idx] = nxtB[idx];
            }
        }
    }

    // 4. Write back ONLY the hole pixels to ImageData (0% blur on background!)
    for (let r = 0; r < roiH; r++) {
        for (let c = 0; c < roiW; c++) {
            const idx = r * roiW + c;
            if (!isHole[idx]) continue;
            const imgIdx = ((y0 + r) * imgWidth + (x0 + c)) * 4;
            data[imgIdx] = Math.max(0, Math.min(255, Math.round(uR[idx])));
            data[imgIdx + 1] = Math.max(0, Math.min(255, Math.round(uG[idx])));
            data[imgIdx + 2] = Math.max(0, Math.min(255, Math.round(uB[idx])));
        }
    }
}