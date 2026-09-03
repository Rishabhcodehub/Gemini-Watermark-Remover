import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.mjs';
import { removeVideoWatermark, removeWatermark } from './blendModes.js?v=7';

export class VideoProcessor {
    constructor(watermarkEngine) {
        this.engine = watermarkEngine;
    }

    /**
     * Inspect video metadata (FPS, duration, total frames, resolution, audio presence).
     */
    static async getMetadata(file) {
        const buffer = await file.arrayBuffer();
        let mp4Info = null;
        let mp4boxfile = null;

        if (window.MP4Box) {
            try {
                await new Promise((resolve) => {
                    const box = MP4Box.createFile();
                    box.onReady = (info) => {
                        mp4Info = info;
                        mp4boxfile = box;
                        resolve();
                    };
                    box.onError = () => resolve();
                    const copyBuf = buffer.slice(0);
                    copyBuf.fileStart = 0;
                    box.appendBuffer(copyBuf);
                    box.flush();
                    // Fallback resolve
                    setTimeout(resolve, 300);
                });
            } catch (e) {
                console.warn("MP4Box metadata parsing warning:", e);
            }
        }

        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            const url = URL.createObjectURL(file);
            video.src = url;

            video.onloadedmetadata = () => {
                let duration = video.duration || 1;
                let width = video.videoWidth || 1280;
                let height = video.videoHeight || 720;
                URL.revokeObjectURL(url);

                let fps = 24.0;
                let totalFrames = Math.round(duration * fps);
                let hasAudio = false;

                if (mp4Info && mp4Info.videoTracks && mp4Info.videoTracks.length > 0) {
                    const vt = mp4Info.videoTracks[0];
                    if (vt.video && vt.video.width && vt.video.height) {
                        width = vt.video.width;
                        height = vt.video.height;
                    }
                    if (vt.nb_samples && vt.duration && vt.timescale) {
                        const trackDuration = vt.duration / vt.timescale;
                        if (trackDuration > 0) {
                            duration = trackDuration;
                            fps = Math.round((vt.nb_samples / trackDuration) * 100) / 100;
                            totalFrames = vt.nb_samples;
                        }
                    }
                }

                if (mp4Info && mp4Info.audioTracks && mp4Info.audioTracks.length > 0) {
                    hasAudio = true;
                }

                if (!fps || fps < 1 || isNaN(fps)) fps = 24.0;
                if (!totalFrames || totalFrames < 1 || isNaN(totalFrames)) {
                    totalFrames = Math.max(1, Math.round(duration * fps));
                }

                resolve({
                    width,
                    height,
                    duration,
                    fps,
                    totalFrames,
                    hasAudio,
                    buffer,
                    mp4Info,
                    mp4boxfile
                });
            };

            video.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("Failed to load video metadata"));
            };
        });
    }

    /**
     * Helper to configure AudioEncoder safely
     */
    async setupAudioEncoder(muxer, audioBuffer) {
        if (!window.AudioEncoder || !audioBuffer) return null;
        try {
            const config = {
                codec: 'mp4a.40.2',
                numberOfChannels: audioBuffer.numberOfChannels,
                sampleRate: audioBuffer.sampleRate,
                bitrate: 128000
            };

            const support = await AudioEncoder.isConfigSupported(config);
            if (!support || !support.supported) {
                console.warn("AudioEncoder not supported for rate:", audioBuffer.sampleRate);
                return null;
            }

            const encoder = new AudioEncoder({
                output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                error: (e) => console.error("AudioEncoder error:", e)
            });

            await encoder.configure(config);
            return encoder;
        } catch (e) {
            console.warn("Could not initialize AudioEncoder:", e);
            return null;
        }
    }

    /**
     * Helper to encode AudioBuffer into AudioEncoder
     */
    async encodeAudioTrack(audioEncoder, audioBuffer) {
        if (!audioEncoder || !audioBuffer) return;
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const totalLength = audioBuffer.length;
        const chunkSize = 1024;

        let offset = 0;
        while (offset < totalLength) {
            const framesToCopy = Math.min(chunkSize, totalLength - offset);
            const pcmData = new Float32Array(framesToCopy * numChannels);

            for (let ch = 0; ch < numChannels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < framesToCopy; i++) {
                    pcmData[i * numChannels + ch] = channelData[offset + i];
                }
            }

            const audioData = new AudioData({
                format: 'f32',
                sampleRate,
                numberOfFrames: framesToCopy,
                numberOfChannels: numChannels,
                timestamp: Math.round((offset * 1000000) / sampleRate),
                data: pcmData
            });

            audioEncoder.encode(audioData);
            audioData.close();
            offset += framesToCopy;
        }

        await audioEncoder.flush();
        audioEncoder.close();
    }

    /**
     * Process video: extract frames, remove watermark, preserve audio, and encode MP4.
     */
    async process(file, onProgress = () => {}) {
        onProgress({ stage: 'metadata', message: 'Analyzing video metadata, FPS, and frame count...', percent: 3 });
        const meta = await VideoProcessor.getMetadata(file);

        onProgress({
            stage: 'metadata_ready',
            message: `Detected ${meta.width}×${meta.height} @ ${meta.fps} FPS (${meta.totalFrames} frames, ${meta.duration.toFixed(2)}s)`,
            percent: 6,
            meta
        });

        // 1. Extract audio if present
        let audioBuffer = null;
        try {
            onProgress({ stage: 'audio', message: 'Extracting and decoding audio stream...', percent: 10 });
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                const audioCtx = new AudioCtx();
                try {
                    audioBuffer = await audioCtx.decodeAudioData(meta.buffer.slice(0));
                    meta.hasAudio = audioBuffer && audioBuffer.numberOfChannels > 0 && audioBuffer.length > 0;
                } catch (audioErr) {
                    console.warn("No decodable audio track found:", audioErr);
                    meta.hasAudio = false;
                } finally {
                    try { audioCtx.close(); } catch(e) {}
                }
            }
        } catch (e) {
            console.warn("Audio extraction skipped:", e);
            meta.hasAudio = false;
        }

        // 2. Prepare watermark alpha map and position
        const wmInfo = this.engine.getVideoWatermarkInfo(meta.width, meta.height);
        const alphaMap = await this.engine.getVideoAlphaMap(wmInfo.width, wmInfo.height);

        // 3. Setup offscreen canvas
        const canvas = document.createElement('canvas');
        canvas.width = meta.width;
        canvas.height = meta.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // 4. Setup MP4 Muxer & Video/Audio Encoders
        const target = new ArrayBufferTarget();
        let testAudioConfig = null;

        if (meta.hasAudio && audioBuffer && window.AudioEncoder) {
            try {
                const conf = {
                    codec: 'mp4a.40.2',
                    numberOfChannels: audioBuffer.numberOfChannels,
                    sampleRate: audioBuffer.sampleRate,
                    bitrate: 128000
                };
                const supp = await AudioEncoder.isConfigSupported(conf);
                if (supp && supp.supported) {
                    testAudioConfig = {
                        codec: 'aac',
                        numberOfChannels: audioBuffer.numberOfChannels,
                        sampleRate: audioBuffer.sampleRate
                    };
                }
            } catch (e) {}
        }

        const muxer = new Muxer({
            target,
            video: {
                codec: 'avc',
                width: meta.width,
                height: meta.height
            },
            audio: testAudioConfig || undefined,
            firstTimestampBehavior: 'offset',
            fastStart: 'in-memory'
        });

        const videoEncoder = new VideoEncoder({
            output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
            error: (e) => console.error("VideoEncoder error:", e)
        });

        await videoEncoder.configure({
            codec: 'avc1.4d002a', // H.264 Main Profile Level 4.2
            width: meta.width,
            height: meta.height,
            bitrate: Math.min(12000000, Math.round(meta.width * meta.height * meta.fps * 0.20)),
            framerate: meta.fps,
            avc: { format: 'avc' }
        });

        let audioEncoder = null;
        if (testAudioConfig) {
            audioEncoder = await this.setupAudioEncoder(muxer, audioBuffer);
        }

        // 5. Sequential Frame-Accurate Extraction, Watermark Removal & Encoding
        const fps = meta.fps;
        const totalFrames = meta.totalFrames;
        const duration = meta.duration;
        const frameDurationUs = Math.round(1000000 / fps);

        let processedFramesCount = 0;
        let decoderSuccess = false;

        // Try WebCodecs Hardware VideoDecoder with MP4Box
        if (window.VideoDecoder && meta.mp4Info && meta.mp4Info.videoTracks && meta.mp4Info.videoTracks.length > 0) {
            try {
                const vt = meta.mp4Info.videoTracks[0];
                const trak = (meta.mp4boxfile && meta.mp4boxfile.getTrackById(vt.id)) || null;
                
                let description = undefined;
                if (trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd && trak.mdia.minf.stbl.stsd.entries && trak.mdia.minf.stbl.stsd.entries[0]) {
                    const entry = trak.mdia.minf.stbl.stsd.entries[0];
                    const avcC = entry.avcC;
                    const DS = (window.MP4Box && window.MP4Box.DataStream) || window.DataStream;
                    if (avcC && DS) {
                        const stream = new DS(undefined, 0, DS.BIG_ENDIAN !== undefined ? DS.BIG_ENDIAN : DataStream.BIG_ENDIAN);
                        avcC.write(stream);
                        // Skip 8 bytes box header (size + type)
                        description = new Uint8Array(stream.buffer, 8);
                    }
                }

                const decoderConfig = {
                    codec: vt.codec,
                    codedWidth: vt.video.width,
                    codedHeight: vt.video.height,
                    description: description
                };

                const isSupported = await VideoDecoder.isConfigSupported(decoderConfig);
                if (isSupported && isSupported.supported) {
                    onProgress({ stage: 'decoding_stream', message: 'Extracting all video frames via hardware decoder...', percent: 12 });

                    // Collect ALL sample chunks with 100% completion check
                    const sampleQueue = [];
                    const mp4box = MP4Box.createFile();
                    let trackId = null;
                    let expectedSamples = vt.nb_samples || 0;

                    await new Promise((res, rej) => {
                        let completed = false;
                        const finish = () => {
                            if (!completed) {
                                completed = true;
                                res();
                            }
                        };

                        mp4box.onReady = (info) => {
                            const vTrack = info.videoTracks[0];
                            trackId = vTrack.id;
                            expectedSamples = vTrack.nb_samples || expectedSamples;
                            mp4box.setExtractionOptions(trackId, null, { nbSamples: 100000 });
                            mp4box.start();
                        };

                        mp4box.onSamples = (id, user, samples) => {
                            sampleQueue.push(...samples);
                            if (expectedSamples > 0 && sampleQueue.length >= expectedSamples) {
                                finish();
                            }
                        };

                        mp4box.onError = rej;

                        const buf = meta.buffer.slice(0);
                        buf.fileStart = 0;
                        mp4box.appendBuffer(buf);
                        mp4box.flush();

                        // Complete once buffer is flushed
                        setTimeout(finish, 800);
                    });

                    if (sampleQueue.length > 0) {
                        let frameIndex = 0;
                        const totalSamples = sampleQueue.length;

                        const videoDecoder = new VideoDecoder({
                            output: (videoFrame) => {
                                const curIdx = frameIndex++;
                                
                                // Draw frame to canvas
                                ctx.drawImage(videoFrame, 0, 0, meta.width, meta.height);
                                
                                // Maintain exact frame presentation timestamp
                                const timestampUs = videoFrame.timestamp;
                                const durationUs = videoFrame.duration || frameDurationUs;
                                videoFrame.close();

                                // Clean watermark from frame
                                const frameImageData = ctx.getImageData(0, 0, meta.width, meta.height);
                                if (this.engine.videoModel === 'omniflash') {
                                    removeWatermark(frameImageData, alphaMap, wmInfo);
                                } else {
                                    removeVideoWatermark(frameImageData, alphaMap, wmInfo);
                                }
                                ctx.putImageData(frameImageData, 0, 0);

                                // Encode cleaned frame
                                const encodedFrame = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
                                const isKeyFrame = (curIdx % Math.round(fps * 2) === 0) || curIdx === 0;
                                videoEncoder.encode(encodedFrame, { keyFrame: isKeyFrame });
                                encodedFrame.close();

                                processedFramesCount++;
                                const percent = Math.min(90, Math.round(10 + (processedFramesCount / totalSamples) * 80));
                                onProgress({
                                    stage: 'processing_frames',
                                    frame: processedFramesCount,
                                    totalFrames: totalSamples,
                                    percent,
                                    message: `Cleaned frame ${processedFramesCount} / ${totalSamples} (${percent}%)`
                                });
                            },
                            error: (e) => console.error("Hardware VideoDecoder error:", e)
                        });

                        await videoDecoder.configure(decoderConfig);

                        // Feed all sample chunks sequentially
                        for (let s of sampleQueue) {
                            const chunk = new EncodedVideoChunk({
                                type: s.is_sync ? 'key' : 'delta',
                                timestamp: Math.round((s.cts * 1000000) / s.timescale),
                                duration: Math.round((s.duration * 1000000) / s.timescale),
                                data: s.data
                            });
                            videoDecoder.decode(chunk);
                        }

                        await videoDecoder.flush();
                        videoDecoder.close();
                        decoderSuccess = true;
                    }
                }
            } catch (hwErr) {
                console.warn("Hardware decoder fallback:", hwErr);
                decoderSuccess = false;
            }
        }

        // Fallback: Frame-Accurate Video Stream Extraction
        if (!decoderSuccess) {
            onProgress({ stage: 'fallback_decoding', message: 'Extracting video frames sequentially...', percent: 12 });

            const video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            const objectUrl = URL.createObjectURL(file);
            video.src = objectUrl;

            await new Promise((res) => {
                video.onloadeddata = res;
            });

            const total = totalFrames;
            for (let i = 0; i < total; i++) {
                const targetTime = (i / total) * duration;
                video.currentTime = Math.min(duration - 0.0001, Math.max(0, targetTime));

                await new Promise((resolve) => {
                    let done = false;
                    const onSeeked = () => {
                        if (!done) {
                            done = true;
                            video.removeEventListener('seeked', onSeeked);
                            resolve();
                        }
                    };
                    video.addEventListener('seeked', onSeeked, { once: true });
                    setTimeout(onSeeked, 250);
                });

                // Draw frame to canvas
                ctx.drawImage(video, 0, 0, meta.width, meta.height);

                // Clean watermark from frame
                const frameImageData = ctx.getImageData(0, 0, meta.width, meta.height);
                removeVideoWatermark(frameImageData, alphaMap, wmInfo);
                ctx.putImageData(frameImageData, 0, 0);

                // Encode frame with precise linear timestamp
                const timestampUs = Math.round(i * frameDurationUs);
                const videoFrame = new VideoFrame(canvas, { timestamp: timestampUs, duration: frameDurationUs });
                const isKeyFrame = (i % Math.round(fps * 2) === 0) || i === 0;
                videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame });
                videoFrame.close();

                processedFramesCount++;
                const percent = Math.min(90, Math.round(10 + ((i + 1) / total) * 80));
                onProgress({
                    stage: 'processing_frames',
                    frame: i + 1,
                    totalFrames: total,
                    percent,
                    message: `Cleaned frame ${i + 1} / ${total} (${percent}%)`
                });
            }

            URL.revokeObjectURL(objectUrl);
        }

        // 6. Flush video encoder
        onProgress({ stage: 'encoding', message: 'Finalizing video stream encoding...', percent: 91 });
        await videoEncoder.flush();
        videoEncoder.close();

        // 7. Encode audio track if available
        if (audioEncoder && audioBuffer) {
            onProgress({ stage: 'encoding_audio', message: 'Encoding synchronized audio stream...', percent: 94 });
            await this.encodeAudioTrack(audioEncoder, audioBuffer);
        }

        // 8. Finalize MP4 Muxer
        onProgress({ stage: 'muxing', message: 'Reassembling final MP4 video...', percent: 98 });
        muxer.finalize();

        const outputBlob = new Blob([target.buffer], { type: 'video/mp4' });
        onProgress({ stage: 'complete', message: 'Video watermark removal complete!', percent: 100 });

        return {
            blob: outputBlob,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            duration: meta.duration,
            totalFrames: processedFramesCount || totalFrames,
            hasAudio: meta.hasAudio,
            model: this.engine.videoModel
        };
    }
}
