import { calculateAlphaMap } from './alphaMap.js?v=7';
import { removeWatermark, removeVideoWatermark } from './blendModes.js?v=7';
import { VideoProcessor } from './videoProcessor.js?v=7';

export class WatermarkEngine {
    constructor(bg48, bg96, bgVeo720, bgVeo1080, bgOmni720, bgOmni1080) {
        this.bg48 = bg48;
        this.bg96 = bg96;
        this.bgVeo720 = bgVeo720;
        this.bgVeo1080 = bgVeo1080;
        this.bgOmni720 = bgOmni720;
        this.bgOmni1080 = bgOmni1080;
        this.videoModel = 'omniflash';
        this.alphaMaps = {};
        this.videoAlphaMaps = {};
        this.videoProcessor = new VideoProcessor(this);
    }

    setVideoModel(model) {
        if (model === 'veo' || model === 'omniflash') {
            this.videoModel = model;
        }
    }

    static async create() {
        const loadImage = (src) => new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => {
                console.warn(`Could not load asset: ${src}`);
                resolve(null);
            };
            img.src = src;
        });

        try {
            const [bg48, bg96, bgVeo720, bgVeo1080, bgOmni720, bgOmni1080] = await Promise.all([
                loadImage('./assets/bg_48.png'),
                loadImage('./assets/bg_96.png'),
                loadImage('./assets/bg_veo_720.png'),
                loadImage('./assets/bg_veo_1080.png'),
                loadImage('./assets/bg_omni_720.png'),
                loadImage('./assets/bg_omni_1080.png')
            ]);
            return new WatermarkEngine(bg48, bg96, bgVeo720, bgVeo1080, bgOmni720, bgOmni1080);
        } catch (e) {
            console.error("Failed to load assets:", e);
            throw e;
        }
    }

    // Image Watermark Info (Gemini Sparkle)
    getWatermarkInfo(width, height) {
        const isLarge = width > 1024 && height > 1024;
        const size = isLarge ? 96 : 48;
        const margin = isLarge ? 64 : 32;
        
        return {
            size,
            x: width - margin - size,
            y: height - margin - size,
            width: size, 
            height: size
        };
    }

    // Video Watermark Info (OmniFlash Sparkle Logo or Veo Text)
    // Supports landscape (16:9), portrait/vertical (9:16), and square (1:1) videos
    getVideoWatermarkInfo(width, height, model = this.videoModel) {
        const baseDimension = Math.min(width, height);
        const scale = baseDimension / 720.0;
        if (model === 'veo') {
            const wmWidth = Math.round(54 * scale);
            const wmHeight = Math.round(26 * scale);
            const marginR = Math.round(20 * scale);
            const marginB = Math.round(25 * scale);

            return {
                width: wmWidth,
                height: wmHeight,
                x: width - marginR - wmWidth,
                y: height - marginB - wmHeight
            };
        } else {
            // OmniFlash: 48x48 sparkle star symbol with 96px margin
            const size = Math.round(48 * scale);
            const margin = Math.round(96 * scale);

            return {
                width: size,
                height: size,
                x: width - margin - size,
                y: height - margin - size
            };
        }
    }

    async getAlphaMap(size) {
        if (this.alphaMaps[size]) return this.alphaMaps[size];
        
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(size === 48 ? this.bg48 : this.bg96, 0, 0);
        
        const map = calculateAlphaMap(ctx.getImageData(0, 0, size, size));
        this.alphaMaps[size] = map;
        return map;
    }

    async getVideoAlphaMap(wmWidth, wmHeight, model = this.videoModel) {
        const key = `${model}_${wmWidth}x${wmHeight}`;
        if (this.videoAlphaMaps[key]) return this.videoAlphaMaps[key];

        const canvas = document.createElement('canvas');
        canvas.width = wmWidth;
        canvas.height = wmHeight;
        const ctx = canvas.getContext('2d');

        let baseImg;
        if (model === 'veo') {
            baseImg = (wmHeight <= 32 && this.bgVeo720) ? this.bgVeo720 : (this.bgVeo1080 || this.bgVeo720);
        } else {
            baseImg = (wmHeight <= 60 && this.bgOmni720) ? this.bgOmni720 : (this.bgOmni1080 || this.bgOmni720);
        }

        if (baseImg) {
            ctx.drawImage(baseImg, 0, 0, wmWidth, wmHeight);
        }

        const map = calculateAlphaMap(ctx.getImageData(0, 0, wmWidth, wmHeight));
        this.videoAlphaMaps[key] = map;
        return map;
    }

    async process(imageFile) {
        const objectUrl = URL.createObjectURL(imageFile);

        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = (e) => reject(new Error("Image load failed"));
                i.src = objectUrl;
            });

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            
            URL.revokeObjectURL(objectUrl);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const config = this.getWatermarkInfo(canvas.width, canvas.height);
            
            const alphaMap = await this.getAlphaMap(config.size);
            removeWatermark(imageData, alphaMap, config);
            
            ctx.putImageData(imageData, 0, 0);
            
            return {
                blob: await new Promise(r => canvas.toBlob(r, 'image/png')),
                width: img.width,
                height: img.height
            };

        } catch (error) {
            URL.revokeObjectURL(objectUrl);
            throw error;
        }
    }

    async processVideo(videoFile, onProgress = () => {}) {
        return await this.videoProcessor.process(videoFile, onProgress);
    }
}