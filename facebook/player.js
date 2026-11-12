// player.js
// Handles video playback and direct download inside the Toystaller Player tab.

(function() {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const videoUrl = params.get('url');
    const audioUrl = params.get('audio');

    const player = document.getElementById('videoPlayer');
    const audioPlayer = document.getElementById('audioPlayer');
    const dlBtn = document.getElementById('dlBtn');
    const dlAudioBtn = document.getElementById('dlAudioBtn');
    const copyBtn = document.getElementById('copyBtn');
    const resText = document.getElementById('resolutionText');
    const qualityPill = document.getElementById('qualityPill');

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

    // Dual-stream DASH Audio Synchronization
    if (audioUrl && audioPlayer) {
        audioPlayer.src = audioUrl;
        if (dlAudioBtn) {
            dlAudioBtn.style.display = 'inline-flex';
        }

        const syncAudio = () => {
            if (Math.abs(audioPlayer.currentTime - player.currentTime) > 0.15) {
                audioPlayer.currentTime = player.currentTime;
            }
        };

        player.addEventListener('play', () => audioPlayer.play().catch(() => {}));
        player.addEventListener('pause', () => audioPlayer.pause());
        player.addEventListener('seeking', () => { audioPlayer.currentTime = player.currentTime; });
        player.addEventListener('seeked', () => { audioPlayer.currentTime = player.currentTime; });
        player.addEventListener('timeupdate', syncAudio);
        player.addEventListener('ratechange', () => { audioPlayer.playbackRate = player.playbackRate; });
        player.addEventListener('volumechange', () => {
            audioPlayer.volume = player.volume;
            audioPlayer.muted = player.muted;
        });

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
    }

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
                if (audioUrl) {
                    qualityPill.textContent = (w >= 1280 || h >= 1280) ? 'Master HD (Synced Audio)' : 'Direct Stream (Synced Audio)';
                } else {
                    qualityPill.textContent = (w >= 1280 || h >= 1280) ? 'Master HD' : 'Direct Stream';
                }
            }
        }
    });

    player.addEventListener('error', () => {
        // DO NOT redirect top-level window to Facebook CDN! (Meta CDN blocks document navigations)
        if (resText) {
            resText.textContent = 'Streaming preview restricted by CDN. Please click "Download HD Video" above to save the full file.';
            resText.style.color = '#e74c3c';
        }
    });

    dlBtn.addEventListener('click', () => {
        const idMatch = videoUrl.match(/\/(\d+_[^/?]+)/);
        const filename = idMatch ? `Facebook_${idMatch[1]}.mp4` : `Facebook_Video_${Date.now()}.mp4`;
        
        chrome.runtime.sendMessage({
            action: 'downloadMedia',
            url: videoUrl,
            filename: filename
        }, (response) => {
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
                        Download HD Video
                    `;
                }, 2500);
            } else {
                // Fallback to direct anchor download
                const a = document.createElement('a');
                a.href = videoUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            }
        });
    });

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
