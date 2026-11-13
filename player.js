// player.js
// Handles video playback and direct download inside the Toystaller Player tab.
// Synchronizes separate DASH video & audio streams, unlocks browser autoplay audio,
// and provides merged or separate high-definition downloads.

(function() {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const videoUrl = params.get('url');
    const audioUrl = params.get('audio');

    const player = document.getElementById('videoPlayer');
    const audioPlayer = document.getElementById('audioPlayer');
    const dlMergedBtn = document.getElementById('dlMergedBtn');
    const dlBtn = document.getElementById('dlBtn');
    const dlBtnLabel = document.getElementById('dlBtnLabel');
    const dlAudioBtn = document.getElementById('dlAudioBtn');
    const copyBtn = document.getElementById('copyBtn');
    const resText = document.getElementById('resolutionText');
    const qualityPill = document.getElementById('qualityPill');
    const audioStatusText = document.getElementById('audioStatusText');
    const unmuteBanner = document.getElementById('unmuteBanner');
    const mergeToast = document.getElementById('mergeToast');
    const mergeStatus = document.getElementById('mergeStatus');

    if (!videoUrl) {
        document.body.innerHTML = `
            <div style="color:#e4e6eb;font-family:sans-serif;text-align:center;margin-top:25vh;">
                <h2>No video link specified</h2>
                <p style="margin-top:10px;color:#8a8d91;">Please close this tab and click the download button on a Facebook video or reel.</p>
            </div>
        `;
        return;
    }

    player.src = videoUrl;

    const showToast = (msg, duration = 3000) => {
        if (!mergeToast || !mergeStatus) return;
        mergeStatus.textContent = msg;
        mergeToast.style.display = 'flex';
        setTimeout(() => {
            mergeToast.style.display = 'none';
        }, duration);
    };

    // --- Dual-Stream DASH Audio Synchronization & Autoplay Policy Unlock ---
    if (audioUrl && audioPlayer) {
        audioPlayer.src = audioUrl;

        if (dlMergedBtn) dlMergedBtn.style.display = 'inline-flex';
        if (dlAudioBtn) dlAudioBtn.style.display = 'inline-flex';
        if (dlBtn) dlBtn.className = 'btn btn-secondary';
        if (dlBtnLabel) dlBtnLabel.textContent = 'Download Video (HD)';
        if (audioStatusText) audioStatusText.textContent = 'DASH Synchronized Audio';

        let audioUnlocked = false;

        const startAudio = () => {
            if (audioUnlocked) return;
            audioPlayer.currentTime = player.currentTime;
            audioPlayer.muted = false;
            audioPlayer.volume = player.volume;
            audioPlayer.playbackRate = player.playbackRate;

            audioPlayer.play().then(() => {
                audioUnlocked = true;
                if (unmuteBanner) unmuteBanner.style.display = 'none';
            }).catch((err) => {
                console.log('[Toystaller Player] Autoplay audio waiting for user gesture:', err);
                if (unmuteBanner) unmuteBanner.style.display = 'flex';
            });
        };

        const unlockAudioGesture = () => {
            startAudio();
            window.removeEventListener('click', unlockAudioGesture);
            window.removeEventListener('keydown', unlockAudioGesture);
            window.removeEventListener('pointerdown', unlockAudioGesture);
        };

        window.addEventListener('click', unlockAudioGesture);
        window.addEventListener('keydown', unlockAudioGesture);
        window.addEventListener('pointerdown', unlockAudioGesture);

        if (unmuteBanner) {
            unmuteBanner.addEventListener('click', (e) => {
                e.stopPropagation();
                unlockAudioGesture();
            });
        }

        // Strict lockstep sync with video
        player.addEventListener('play', () => {
            if (audioUnlocked) {
                audioPlayer.currentTime = player.currentTime;
                audioPlayer.play().catch(() => {});
            } else {
                startAudio();
            }
        });

        player.addEventListener('playing', () => {
            if (audioUnlocked) {
                audioPlayer.currentTime = player.currentTime;
                audioPlayer.play().catch(() => {});
            } else {
                startAudio();
            }
        });

        player.addEventListener('pause', () => {
            audioPlayer.pause();
        });

        const syncAudioTime = () => {
            if (Math.abs(audioPlayer.currentTime - player.currentTime) > 0.15) {
                audioPlayer.currentTime = player.currentTime;
            }
        };

        player.addEventListener('seeking', () => { audioPlayer.currentTime = player.currentTime; });
        player.addEventListener('seeked', () => { audioPlayer.currentTime = player.currentTime; });
        player.addEventListener('timeupdate', syncAudioTime);
        player.addEventListener('ratechange', () => { audioPlayer.playbackRate = player.playbackRate; });
        player.addEventListener('volumechange', () => {
            audioPlayer.volume = player.volume;
            audioPlayer.muted = player.muted;
        });

        // Download Audio Only
        if (dlAudioBtn) {
            dlAudioBtn.addEventListener('click', () => {
                const idMatch = audioUrl.match(/\/(\d+_[^/?]+)/);
                const filename = idMatch ? `Facebook_Audio_${idMatch[1]}.mp4` : `Facebook_Audio_${Date.now()}.mp4`;
                chrome.runtime.sendMessage({
                    action: 'downloadMedia',
                    url: audioUrl,
                    filename: filename
                }, (response) => {
                    if (response && response.success) {
                        dlAudioBtn.innerHTML = `
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                            Audio Downloaded
                        `;
                        setTimeout(() => {
                            dlAudioBtn.innerHTML = `
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                                Download Audio
                            `;
                        }, 2500);
                    } else {
                        const a = document.createElement('a');
                        a.href = audioUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                    }
                });
            });
        }

        // Download Merged (Video + Audio)
        if (dlMergedBtn) {
            dlMergedBtn.addEventListener('click', async () => {
                const idMatch = videoUrl.match(/\/(\d+_[^/?]+)/);
                const baseName = idMatch ? `Facebook_${idMatch[1]}` : `Facebook_Video_${Date.now()}`;

                // Try in-browser MediaRecorder muxing if video duration is reasonable (<= 180s)
                const canRecord = window.MediaRecorder && (player.captureStream || player.mozCaptureStream);
                if (canRecord && player.duration && player.duration <= 180 && player.duration > 0) {
                    showToast('Recording & merging video with sound...', 5000);
                    try {
                        const vStream = player.captureStream ? player.captureStream() : player.mozCaptureStream();
                        const aStream = audioPlayer.captureStream ? audioPlayer.captureStream() : (audioPlayer.mozCaptureStream ? audioPlayer.mozCaptureStream() : null);

                        let combinedStream;
                        if (aStream && aStream.getAudioTracks().length > 0) {
                            combinedStream = new MediaStream([
                                ...vStream.getVideoTracks(),
                                ...aStream.getAudioTracks()
                            ]);
                        } else {
                            // Web Audio API mix
                            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                            const source = audioCtx.createMediaElementSource(audioPlayer);
                            const dest = audioCtx.createMediaStreamDestination();
                            source.connect(dest);
                            source.connect(audioCtx.destination);
                            combinedStream = new MediaStream([
                                ...vStream.getVideoTracks(),
                                ...dest.stream.getAudioTracks()
                            ]);
                        }

                        let mime = 'video/webm';
                        if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
                            mime = 'video/mp4;codecs=avc1,mp4a.40.2';
                        } else if (MediaRecorder.isTypeSupported('video/mp4')) {
                            mime = 'video/mp4';
                        }

                        const recorder = new MediaRecorder(combinedStream, { mimeType: mime });
                        const chunks = [];
                        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
                        recorder.onstop = () => {
                            const blob = new Blob(chunks, { type: mime });
                            const blobUrl = URL.createObjectURL(blob);
                            const ext = mime.includes('mp4') ? 'mp4' : 'webm';
                            const a = document.createElement('a');
                            a.href = blobUrl;
                            a.download = `${baseName}_merged.${ext}`;
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                            showToast('Merged video downloaded successfully!', 4000);
                        };

                        // Rewind and play to record
                        player.currentTime = 0;
                        audioPlayer.currentTime = 0;
                        recorder.start();
                        await player.play();
                        await audioPlayer.play();

                        player.addEventListener('ended', () => {
                            if (recorder.state === 'recording') recorder.stop();
                        }, { once: true });

                        return;
                    } catch(err) {
                        console.warn('[Toystaller Player] In-browser merge fallback to direct stream downloads:', err);
                    }
                }

                // Direct paired downloads for long videos or fallback
                showToast('Downloading HD video and synchronized audio files...', 4000);
                chrome.runtime.sendMessage({
                    action: 'downloadMedia',
                    url: videoUrl,
                    filename: `${baseName}_video.mp4`
                });
                setTimeout(() => {
                    chrome.runtime.sendMessage({
                        action: 'downloadMedia',
                        url: audioUrl,
                        filename: `${baseName}_audio.mp4`
                    });
                }, 800);
            });
        }
    } else {
        if (audioStatusText) audioStatusText.textContent = 'Direct Master Audio + Video';
        if (dlBtnLabel) dlBtnLabel.textContent = 'Download HD Video (with Sound)';
    }

    // Video Aspect Ratio & Quality detection
    player.addEventListener('loadedmetadata', () => {
        const w = player.videoWidth;
        const h = player.videoHeight;
        if (w && h) {
            if (w > h * 1.15) {
                player.className = 'horizontal';
            } else if (h > w * 1.15) {
                player.className = 'vertical';
            } else {
                player.className = 'square';
            }

            let qualityTag = 'HD MP4';
            if (w >= 1920 || h >= 1920) qualityTag = 'Full HD (1080p)';
            else if (w >= 1280 || h >= 1280) qualityTag = 'HD (720p)';
            else if (w >= 850 || h >= 850) qualityTag = 'HQ (480p)';
            else qualityTag = 'SD MP4';

            if (resText) {
                resText.textContent = `${w} × ${h} • ${qualityTag}`;
                resText.style.color = '#8a8d91';
            }
            if (qualityPill) {
                qualityPill.textContent = (w >= 1280 || h >= 1280) ? 'Master HD' : 'Original Quality';
            }
        }
    });

    player.addEventListener('error', () => {
        if (resText) {
            resText.textContent = 'Preview stream restricted by CDN. Please click "Download Video" above to save the complete file.';
            resText.style.color = '#e74c3c';
        }
    });

    // Download Video (HD)
    dlBtn.addEventListener('click', () => {
        const idMatch = videoUrl.match(/\/(\d+_[^/?]+)/);
        const baseName = idMatch ? `Facebook_${idMatch[1]}` : `Facebook_Video_${Date.now()}`;
        
        // If separate companion audio URL exists and user clicked dlBtn, download both video and audio files together
        // so the user never gets left without sound!
        const isPaired = !!audioUrl;
        const filename = isPaired ? `${baseName}_video.mp4` : `${baseName}.mp4`;
        
        chrome.runtime.sendMessage({
            action: 'downloadMedia',
            url: videoUrl,
            filename: filename
        }, (response) => {
            if (isPaired) {
                setTimeout(() => {
                    chrome.runtime.sendMessage({
                        action: 'downloadMedia',
                        url: audioUrl,
                        filename: `${baseName}_audio.mp4`
                    });
                }, 600);
            }
            if (response && response.success) {
                dlBtn.innerHTML = `
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Download Started
                `;
                setTimeout(() => {
                    dlBtn.innerHTML = `
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        <span>${dlBtnLabel ? dlBtnLabel.textContent : 'Download HD Video'}</span>
                    `;
                }, 2500);
            } else {
                const a = document.createElement('a');
                a.href = videoUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        });
    });

    // Copy Link
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(videoUrl).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => {
                copyBtn.innerHTML = `
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    Copy Link
                `;
            }, 1800);
        });
    });
})();
