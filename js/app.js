import { WatermarkEngine } from './engine.js?v=7';

document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const previewSection = document.getElementById('previewSection');
    
    // Images & Video Elements
    const originalImage = document.getElementById('originalImage');
    const processedImage = document.getElementById('processedImage');
    const originalVideo = document.getElementById('originalVideo');
    const processedVideo = document.getElementById('processedVideo');
    
    const originalHeading = document.getElementById('originalHeading');
    const processedHeading = document.getElementById('processedHeading');
    const videoSyncControls = document.getElementById('videoSyncControls');
    const syncPlayBtn = document.getElementById('syncPlayBtn');
    const syncPauseBtn = document.getElementById('syncPauseBtn');

    const originalContainer = originalImage.closest('.rounded-2xl'); 
    const processedContainer = processedImage.closest('.rounded-2xl');

    // Metadata Fields
    const originalSize = document.getElementById('originalSize');
    const resultSize = document.getElementById('resultSize');
    const resultStatus = document.getElementById('resultStatus');
    
    // Buttons & Overlay
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const progressStageTitle = document.getElementById('progressStageTitle');
    const progressStatusDetail = document.getElementById('progressStatusDetail');
    const progressBarFill = document.getElementById('progressBarFill');
    const progressPercentText = document.getElementById('progressPercentText');
    const progressEtaText = document.getElementById('progressEtaText');

    // Video Watermark Model Selector
    const modelOmniBtn = document.getElementById('modelOmniBtn');
    const modelVeoBtn = document.getElementById('modelVeoBtn');
    let currentVideoModel = 'omniflash';

    function setActiveModel(model) {
        currentVideoModel = model;
        if (engine) engine.setVideoModel(model);

        if (model === 'omniflash') {
            if (modelOmniBtn) modelOmniBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary text-white shadow-sm transition-all';
            if (modelVeoBtn) modelVeoBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all';
        } else {
            if (modelVeoBtn) modelVeoBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-primary text-white shadow-sm transition-all';
            if (modelOmniBtn) modelOmniBtn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all';
        }
    }

    let engine = null;
    let activeObjectUrls = [];

    function trackUrl(url) {
        activeObjectUrls.push(url);
        return url;
    }

    function revokeAllUrls() {
        activeObjectUrls.forEach(url => {
            try { URL.revokeObjectURL(url); } catch(e) {}
        });
        activeObjectUrls = [];
    }

    function updateProgress(title, detail, percent, eta = '') {
        if (progressStageTitle) progressStageTitle.textContent = title;
        if (progressStatusDetail) progressStatusDetail.textContent = detail;
        if (progressBarFill) progressBarFill.style.width = `${percent}%`;
        if (progressPercentText) progressPercentText.textContent = `${percent}%`;
        if (progressEtaText) progressEtaText.textContent = eta;
    }

    // --- Init Engine ---
    try {
        engine = await WatermarkEngine.create();
        if (engine) engine.setVideoModel(currentVideoModel);
    } catch (e) {
        alert("Notice: Could not load some watermark reference assets from 'assets/'. Ensure the local server is running.");
    }

    if (modelOmniBtn) {
        modelOmniBtn.addEventListener('click', () => setActiveModel('omniflash'));
    }
    if (modelVeoBtn) {
        modelVeoBtn.addEventListener('click', () => setActiveModel('veo'));
    }

    // --- Event Listeners ---
    uploadArea.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    uploadArea.addEventListener('dragover', () => uploadArea.classList.add('border-brand-primary', 'bg-indigo-50/40'));
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('border-brand-primary', 'bg-indigo-50/40'));
    
    uploadArea.addEventListener('drop', (e) => {
        uploadArea.classList.remove('border-brand-primary', 'bg-indigo-50/40');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    resetBtn.addEventListener('click', () => {
        previewSection.classList.add('hidden');
        uploadArea.classList.remove('hidden');
        fileInput.value = '';
        
        // Stop & reset video elements
        originalVideo.pause();
        originalVideo.src = '';
        originalVideo.classList.add('hidden');
        
        processedVideo.pause();
        processedVideo.src = '';
        processedVideo.classList.add('hidden');
        
        originalImage.src = '';
        originalImage.classList.remove('hidden');
        
        processedImage.src = '';
        processedImage.classList.remove('hidden');

        if (videoSyncControls) videoSyncControls.classList.add('hidden');
        
        if (originalContainer) originalContainer.classList.remove('hidden');
        if (processedContainer) processedContainer.classList.remove('hidden');
        
        revokeAllUrls();
        
        updateProgress("Processing...", "Analyzing file...", 0);
        resultStatus.textContent = "...";
        originalSize.textContent = "...";
        resultSize.textContent = "...";
    });

    // Synchronized Video Playback
    if (syncPlayBtn) {
        syncPlayBtn.addEventListener('click', () => {
            originalVideo.currentTime = processedVideo.currentTime;
            originalVideo.play();
            processedVideo.play();
        });
    }

    if (syncPauseBtn) {
        syncPauseBtn.addEventListener('click', () => {
            originalVideo.pause();
            processedVideo.pause();
        });
    }

    // Keep videos in sync during scrubbing
    processedVideo.addEventListener('seeked', () => {
        if (Math.abs(originalVideo.currentTime - processedVideo.currentTime) > 0.05) {
            originalVideo.currentTime = processedVideo.currentTime;
        }
    });

    processedVideo.addEventListener('play', () => {
        originalVideo.currentTime = processedVideo.currentTime;
        originalVideo.play().catch(() => {});
    });

    processedVideo.addEventListener('pause', () => {
        originalVideo.pause();
    });

    // --- Processing Logic ---
    async function handleFiles(files) {
        if (!files || !files.length) return;
        
        if (!engine) engine = await WatermarkEngine.create();

        const firstFile = files[0];
        const isVideo = firstFile.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(firstFile.name);

        loadingOverlay.classList.remove('hidden');
        loadingOverlay.classList.add('flex');

        try {
            // ==========================================
            // VIDEO MODE
            // ==========================================
            if (isVideo) {
                originalImage.classList.add('hidden');
                processedImage.classList.add('hidden');
                originalVideo.classList.remove('hidden');
                processedVideo.classList.remove('hidden');
                if (videoSyncControls) videoSyncControls.classList.remove('hidden');

                if (originalHeading) originalHeading.textContent = "Original Video (With Watermark)";
                if (processedHeading) processedHeading.textContent = `Processed Video (${currentVideoModel === 'veo' ? 'Veo' : 'OmniFlash'} Removed)`;

                updateProgress("Analyzing Video...", "Checking FPS, frame count, and audio streams...", 5);

                const startTime = performance.now();
                if (engine) engine.setVideoModel(currentVideoModel);

                const result = await engine.processVideo(firstFile, (progress) => {
                    const elapsed = (performance.now() - startTime) / 1000;
                    let eta = '';
                    if (progress.percent > 10 && progress.percent < 95) {
                        const totalEstimated = (elapsed / progress.percent) * 100;
                        const remaining = Math.max(0, Math.round(totalEstimated - elapsed));
                        eta = `ETA: ~${remaining}s`;
                    }
                    updateProgress(
                        progress.stage === 'processing_frames' ? 'Removing Watermark From Frames' : 'Processing Video',
                        progress.message || `Processing frame ${progress.frame || 0}...`,
                        progress.percent || 0,
                        eta
                    );
                });

                // 1. Setup Video Sources
                const origUrl = trackUrl(URL.createObjectURL(firstFile));
                const processedUrl = trackUrl(URL.createObjectURL(result.blob));

                originalVideo.src = origUrl;
                processedVideo.src = processedUrl;

                // 2. Update Metadata
                const modelLabel = (result.model === 'veo' || currentVideoModel === 'veo') ? 'Veo' : 'OmniFlash';
                originalSize.textContent = `${result.width} × ${result.height} px • ${result.fps} FPS`;
                resultSize.textContent = `${result.totalFrames} Frames Cleaned • ${result.duration.toFixed(2)}s • ${result.hasAudio ? 'Audio Synced 🎵' : 'Audio Track'}`;
                resultStatus.textContent = `${modelLabel} Watermark Removed`;

                // 3. Setup Download
                downloadBtn.onclick = () => {
                    const a = document.createElement('a');
                    a.href = processedUrl;
                    a.download = `${firstFile.name.replace(/\.[^/.]+$/, "")}_clean.mp4`;
                    a.click();
                };

                const downloadSpan = downloadBtn.querySelector('div.relative span') || downloadBtn.querySelector('div.relative');
                if (downloadSpan) {
                    downloadSpan.textContent = "Download Clean Video (MP4)";
                }

            }
            // ==========================================
            // BATCH IMAGE MODE
            // ==========================================
            else if (files.length > 1) {
                originalVideo.classList.add('hidden');
                processedVideo.classList.add('hidden');
                if (videoSyncControls) videoSyncControls.classList.add('hidden');
                
                originalImage.classList.remove('hidden');
                processedImage.classList.remove('hidden');

                if (originalHeading) originalHeading.textContent = "Original";
                if (processedHeading) processedHeading.textContent = "Processed Result";

                const zip = new JSZip();
                let processedCount = 0;
                const failedFiles = [];

                if (originalContainer) originalContainer.classList.add('hidden');
                if (processedContainer) processedContainer.classList.add('hidden');

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (!file.type.match('image.*')) continue;

                    const percent = Math.round(((i + 1) / files.length) * 90);
                    updateProgress("Batch Processing...", `Processing ${i + 1} / ${files.length} images...`, percent);

                    try {
                        const result = await engine.process(file);
                        const finalName = `${file.name.replace(/\.[^/.]+$/, "")}_clean.png`;
                        zip.file(finalName, result.blob);
                        processedCount++;
                    } catch (err) {
                        console.error(`Failed to process ${file.name}:`, err);
                        failedFiles.push(file.name);
                    }
                }

                updateProgress("Zipping Files...", "Creating download archive...", 95);
                const zipBlob = await zip.generateAsync({ type: "blob" });
                const zipUrl = trackUrl(URL.createObjectURL(zipBlob));

                resultStatus.textContent = "Batch Ready";
                resultSize.textContent = `${processedCount} Success, ${failedFiles.length} Errors`;
                originalSize.textContent = "Batch Process"; 

                downloadBtn.onclick = () => {
                    const a = document.createElement('a');
                    a.href = zipUrl;
                    a.download = "processed_images.zip";
                    a.click();
                };
                
                const downloadSpan = downloadBtn.querySelector('div.relative span') || downloadBtn.querySelector('div.relative');
                if (downloadSpan) {
                    downloadSpan.textContent = "Download ZIP";
                }

                if (failedFiles.length > 0) {
                    alert(`Processing complete with errors.\n\nFailed files:\n${failedFiles.join('\n')}`);
                }
            } 
            // ==========================================
            // SINGLE IMAGE MODE
            // ==========================================
            else {
                const file = files[0];
                if (!file.type.match('image.*')) {
                    alert("Please upload a valid image (PNG, JPG, WebP) or video (MP4, WebM, MOV)");
                    return;
                }

                originalVideo.classList.add('hidden');
                processedVideo.classList.add('hidden');
                if (videoSyncControls) videoSyncControls.classList.add('hidden');

                originalImage.classList.remove('hidden');
                processedImage.classList.remove('hidden');

                if (originalContainer) originalContainer.classList.remove('hidden');
                if (processedContainer) processedContainer.classList.remove('hidden');

                if (originalHeading) originalHeading.textContent = "Original Image";
                if (processedHeading) processedHeading.textContent = "Processed Result (Clean)";

                updateProgress("Processing Image...", "Applying Reverse Alpha Blending...", 40);

                const result = await engine.process(file);
                
                const origUrl = trackUrl(URL.createObjectURL(file));
                const processedUrl = trackUrl(URL.createObjectURL(result.blob));

                originalImage.src = origUrl;
                processedImage.src = processedUrl;
                
                const sizeText = `${result.width} × ${result.height} px`;
                originalSize.textContent = sizeText;
                resultSize.textContent = sizeText;
                resultStatus.textContent = "Watermark Removed";
                
                downloadBtn.onclick = () => {
                    const a = document.createElement('a');
                    a.href = processedUrl;
                    a.download = `${file.name.replace(/\.[^/.]+$/, "")}_clean.png`;
                    a.click();
                };

                const downloadSpan = downloadBtn.querySelector('div.relative span') || downloadBtn.querySelector('div.relative');
                if (downloadSpan) {
                    downloadSpan.textContent = "Download Clean Image (PNG)";
                }
            }

            uploadArea.classList.add('hidden');
            previewSection.classList.remove('hidden');

        } catch (error) {
            console.error("Processing Error:", error);
            alert(`An error occurred while processing: ${error.message || error}`);
        } finally {
            loadingOverlay.classList.add('hidden');
            loadingOverlay.classList.remove('flex');
            updateProgress("Processing...", "Analyzing file...", 0);
        }
    }
});