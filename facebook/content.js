// content_script.js
// Specialized Facebook Media Extractor & Button Injector.
// Supports: Watch, Reels, Stories, Theater Mode, News Feed Posts, Groups, Photo Albums, and Profile Timeline.

let toystallerBooted = false;

function bootToystaller() {
    if (toystallerBooted) return;
    toystallerBooted = true;

    // Inject platform config and page interceptor into the MAIN world
    // Dynamically handles both root and packaged subfolder directory structures
    const scriptsToInject = [];
    try {
        const manifest = chrome.runtime.getManifest();
        const resources = (manifest.web_accessible_resources && manifest.web_accessible_resources[0] && manifest.web_accessible_resources[0].resources) || [];
        if (resources.includes('platform.js')) {
            scriptsToInject.push('platform.js', 'core/interceptor_core.js');
        } else {
            scriptsToInject.push('platforms/facebook.js', 'page_interceptor.js');
        }
    } catch (e) {
        scriptsToInject.push('platforms/facebook.js', 'page_interceptor.js');
    }

    let currentScriptIdx = 0;
    const injectNext = () => {
        if (currentScriptIdx >= scriptsToInject.length) return;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL(scriptsToInject[currentScriptIdx]);
        script.onload = () => {
            script.remove();
            currentScriptIdx++;
            injectNext();
        };
        (document.head || document.documentElement).appendChild(script);
    };
    injectNext();

    injectDownloadButtons();
    setInterval(injectDownloadButtons, 1200);

    const mediaObserver = new MutationObserver(scheduleInject);
    if (document.documentElement) {
        mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
}

// --- Automated Background Reel Extraction Workflow ---
(function checkAutoExtractMode() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('toystaller_auto')) return;

    // Elegant status banner
    const banner = document.createElement('div');
    banner.id = 'toystaller-auto-loader';
    banner.style.cssText = `
        position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(18, 19, 23, 0.95); color: #fff; padding: 12px 28px;
        border-radius: 30px; z-index: 2147483647; font-family: -apple-system, sans-serif;
        font-size: 14px; font-weight: 600; box-shadow: 0 8px 32px rgba(0,0,0,0.8);
        display: flex; align-items: center; gap: 12px; border: 1px solid rgba(255,255,255,0.15);
    `;
    banner.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1877f2" stroke-width="2.5" style="animation: spin 0.8s linear infinite;">
            <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
            <path d="M12 2a10 10 0 0 1 10 10"></path>
        </svg>
        <span>Loading Master HD Video & Audio...</span>
        <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>
    `;
    document.documentElement.appendChild(banner);

    // Mute and pause native video so user doesn't hear double audio
    const silenceVideo = () => {
        document.querySelectorAll('video').forEach(v => {
            try { v.muted = true; v.pause(); } catch(e) {}
        });
    };
    silenceVideo();
    setInterval(silenceVideo, 300);

    let attempts = 0;
    const pollForStream = () => {
        attempts++;
        const video = document.querySelector('video');
        if (!video && attempts < 25) {
            setTimeout(pollForStream, 200);
            return;
        }

        const platform = PlatformManager.getPlatform();
        const currentId = platform.extractVideoId ? platform.extractVideoId(video) : null;

        const magicId = Math.random().toString(36).substring(2, 15);
        if (video) video.setAttribute('data-toystaller-active', magicId);

        let resolved = false;
        const handler = (e) => {
            if (!e.data || e.data.type !== 'magic_response_react_url_' + magicId) return;
            if (resolved) return;
            resolved = true;
            window.removeEventListener('message', handler);

            const videoUrl = cleanVideoUrl(e.data.url);
            const audioUrl = cleanVideoUrl(e.data.audioUrl);

            if (videoUrl && isValidVideoUrl(videoUrl)) {
                banner.innerHTML = `<span>Ready! Opening Player...</span>`;
                chrome.runtime.sendMessage({
                    action: 'autoExtractDone',
                    url: videoUrl,
                    audioUrl: audioUrl
                });
            } else if (attempts < 25) {
                setTimeout(pollForStream, 300);
            }
        };

        window.addEventListener('message', handler);
        window.postMessage({ type: 'magic_get_react_url', id: magicId, isVideo: true, videoId: currentId }, '*');

        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                window.removeEventListener('message', handler);
                if (attempts < 25) {
                    setTimeout(pollForStream, 300);
                }
            }
        }, 500);
    };

    setTimeout(pollForStream, 500);
})();

const pageInterceptedVideoUrls = new Set();
window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'toystaller_video_urls' && Array.isArray(e.data.urls)) {
        e.data.urls.forEach(url => {
            if (isValidVideoUrl(url)) {
                pageInterceptedVideoUrls.add(url);
            }
        });
    } else if (e.data.type === 'toystaller_url_changed') {
        // User scrolled to another Reel or navigated via SPA!
        // Clear all cached resolutions on open buttons so each button maps to the active video
        document.querySelectorAll('.magic-open-btn').forEach(btn => {
            delete btn.__resolvedVideoUrl;
            delete btn.__resolvedVideoId;
        });
        if (window.magicOverlayManager) {
            window.magicOverlayManager.updateAllPositions();
        }
        setTimeout(injectDownloadButtons, 120);
    }
});

// Throttled scroll listener to invalidate stale button caches as user scrolls
let lastKnownHref = window.location.href;
window.addEventListener('scroll', () => {
    if (window.location.href !== lastKnownHref) {
        lastKnownHref = window.location.href;
        document.querySelectorAll('.magic-open-btn').forEach(btn => {
            delete btn.__resolvedVideoUrl;
            delete btn.__resolvedVideoId;
        });
    }
}, { passive: true });

// Safe wrapper for chrome.runtime.sendMessage to prevent
// "Extension context invalidated" errors after extension reload
function safeSendMessage(msg, callback) {
    try {
        if (!chrome.runtime || !chrome.runtime.id) return;
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('Toystaller: extension context invalidated, please reload page.');
                return;
            }
            if (callback) callback(response);
        });
    } catch (e) {
        console.warn('Toystaller: extension context invalidated, please reload page.');
    }
}

function triggerDownload(url) {
    safeSendMessage({ action: 'downloadMedia', url: url }, (response) => {
        if (!response || !response.success) {
            console.error("Download failed or was rejected.");
        }
    });
}

function cleanVideoUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let clean = url;
    clean = clean.replace(/\\\//g, '/');
    clean = clean.replace(/&amp;/g, '&')
                 .replace(/\\u0026/g, '&')
                 .replace(/\u0026/g, '&')
                 .replace(/\\u002526/g, '&');
    clean = clean.replace(/([?&])bytestart=\d+&?/g, '$1')
                 .replace(/([?&])byteend=\d+&?/g, '$1');
    clean = clean.replace(/[?&]$/, '');
    return clean.trim().replace(/^["']|["']$/g, '');
}

function isValidVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (lower.startsWith('blob:') || lower.startsWith('data:')) return false;
    if (lower.includes('facebook.com') || lower.includes('messenger.com') || lower.includes('instagram.com')) return false;
    if (lower.includes('unified_cvc')) return false;
    if (lower.includes('.m3u8') || lower.includes('.mpd') || lower.includes('stream_type=dash')) return false;
    
    // Reject audio-only streams
    if (lower.includes('dash_audio') || lower.includes('_audio_')) return false;

    // Reject image extensions & covers
    if (lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') || lower.includes('.webp') || lower.includes('videocover') || lower.includes('/t15.')) {
        return false;
    }

    const isCdn = lower.includes('fbcdn.net') || lower.includes('fbsbx.com');
    const isVideoExt = lower.includes('.mp4') || lower.includes('.m4v') || lower.includes('.webm');
    const isVideoPath = lower.includes('/v/t42.') || lower.includes('/v/t64.') || lower.includes('/video/') || lower.includes('mime=video');

    return isCdn && (isVideoExt || isVideoPath);
}

function parseStreamMetadata(url) {
    if (!url || typeof url !== 'string') return null;
    let videoId = null;
    let vencodeTag = '';
    let bitrate = 0;
    try {
        const m = url.match(/[?&]efg=([^&]+)/);
        if (m) {
            let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            const decoded = JSON.parse(atob(b64));
            if (decoded) {
                if (decoded.video_id) videoId = String(decoded.video_id).trim();
                if (decoded.vencode_tag) vencodeTag = String(decoded.vencode_tag).toLowerCase();
                if (decoded.bitrate) bitrate = Number(decoded.bitrate) || 0;
            }
        }
    } catch(e) {}

    const lower = url.toLowerCase();
    const isAudio = vencodeTag.includes('audio') || 
                    vencodeTag.includes('dash_a') || 
                    lower.includes('dash_audio') || 
                    lower.includes('_audio_') || 
                    (bitrate > 0 && bitrate < 200000 && !vencodeTag.includes('baseline') && !vencodeTag.includes('video'));

    const isVideo = !isAudio && (
        vencodeTag.includes('baseline') || 
        vencodeTag.includes('video') || 
        vencodeTag.includes('dash_v') || 
        bitrate >= 200000 || 
        lower.includes('.mp4') || 
        lower.includes('.m4v')
    );

    return { videoId, vencodeTag, bitrate, isAudio, isVideo };
}

function isProgressiveStream(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    const meta = parseStreamMetadata(url);
    if (meta) {
        if (meta.isAudio) return false;
        if (meta.vencodeTag.includes('dash_v') || meta.vencodeTag.includes('dash_baseline')) return false;
        if (meta.vencodeTag.includes('baseline') && !meta.vencodeTag.includes('dash')) return true;
    }
    if (!lower.includes('bytestart=') && !lower.includes('stream_type=dash') && (lower.includes('/v/t64.') || lower.includes('/v/t39.'))) {
        return true;
    }
    return false;
}

async function fetchMasterProgressiveUrl(videoId) {
    if (!videoId) return null;
    try {
        const targetUrl = `https://www.facebook.com/reel/${videoId}/`;
        const resp = await fetch(targetUrl, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        if (!resp.ok) return null;
        const html = await resp.text();

        // 1. High definition progressive master stream (audio + video combined)
        const hdRegex = /"(?:playable_url_quality_hd|browser_native_hd_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/;
        const hdMatch = html.match(hdRegex);
        if (hdMatch && hdMatch[1]) {
            const raw = JSON.parse('"' + hdMatch[1] + '"');
            const clean = cleanVideoUrl(raw);
            if (clean && isValidVideoUrl(clean)) {
                return clean;
            }
        }

        // 2. Standard definition progressive master stream (audio + video combined)
        const sdRegex = /"(?:playable_url|browser_native_sd_url)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/;
        const sdMatch = html.match(sdRegex);
        if (sdMatch && sdMatch[1]) {
            const raw = JSON.parse('"' + sdMatch[1] + '"');
            const clean = cleanVideoUrl(raw);
            if (clean && isValidVideoUrl(clean)) {
                return clean;
            }
        }
    } catch(e) {
        console.warn('[Toystaller] fetchMasterProgressiveUrl error:', e);
    }
    return null;
}

function scoreVideoUrl(url) {
    let score = 0;
    const lower = (url || '').toLowerCase();
    
    // Explicit audio track check: audio streams must NEVER be chosen as video!
    const meta = parseStreamMetadata(url);
    if (meta && meta.isAudio) return -10000;
    if (lower.includes('dash_audio') || lower.includes('_audio_')) return -10000;

    // Master HD Progressive Streams (/v/t64. or /v/t39.) with high bitrate
    if (lower.includes('/v/t64.') || lower.includes('/v/t39.')) score += 350;
    if (lower.includes('video.fbcdn.net')) score += 30;

    // DASH Master Video Stream with bitrate evaluation
    if (meta && meta.isVideo) {
        score += 100 + Math.min((meta.bitrate || 0) / 20000, 70);
    }

    // Explicit resolution markers
    if (lower.includes('1080')) score += 60;
    else if (lower.includes('720')) score += 40;
    else if (lower.includes('480')) score += 10;
    else if (lower.includes('360')) score += 2;

    // Standard definition progressive stream
    if (lower.includes('.mp4') || lower.includes('.m4v')) score += 20;
    
    // Low-bitrate preview stream (/v/t42.)
    if (lower.includes('/v/t42.')) score -= 120;
    
    // Segmented DASH chunks with bytestart/byteend
    if (lower.includes('bytestart=') || lower.includes('byteend=')) score -= 80;
    
    // DASH manifests & segmented playlists
    if (lower.includes('.m3u8') || lower.includes('.mpd') || lower.includes('/playlist/') || lower.includes('/manifest/') || lower.includes('stream_type=dash')) {
        score -= 500;
    }
    
    // Image thumbnails & covers
    if (lower.includes('videocover') || lower.includes('/image/') || lower.includes('.jpg') || lower.includes('.png') || lower.includes('.webp') || lower.includes('/t15.')) {
        score -= 1000;
    }

    score += Math.min((url || '').length / 100, 5);
    return score;
}

function pickBestVideoUrl(urls) {
    if (!urls || urls.length === 0) return null;
    const cleaned = urls.map(cleanVideoUrl).filter(Boolean);
    let playable = cleaned.filter(u => isValidVideoUrl(u));
    if (playable.length === 0) return null;
    const sorted = [...playable].sort((a, b) => scoreVideoUrl(b) - scoreVideoUrl(a));
    return sorted[0];
}

function isRawMediaTab() {
    if (document.contentType && (document.contentType.startsWith('video/') || document.contentType.startsWith('image/'))) {
        return true;
    }
    if (document.body && document.body.children.length === 1) {
        const child = document.body.firstElementChild;
        if (child && (child.tagName === 'VIDEO' || child.tagName === 'IMG')) {
            return true;
        }
    }
    return false;
}

const FALLBACK_PLATFORM = {
    name: 'fallback',
    hasActiveModal() { return false; },
    isInsideModal() { return false; },
    isThumbnail(media) {
        if (media.tagName.toLowerCase() !== 'img') return false;
        const rect = media.getBoundingClientRect();
        const naturalW = media.naturalWidth || media.width;
        const naturalH = media.naturalHeight || media.height;
        if (naturalW >= 200 && naturalH >= 200) return false;
        if (naturalW < 100 || naturalH < 100) return true;
        if (rect.width < 100 || rect.height < 100) return true;
        return false;
    },
    getButtonScale() { return 1; },
    filterBackgroundUrls(candidates) { return candidates.filter(isValidVideoUrl); }
};

const PlatformManager = {
    getPlatform() {
        const platforms = window.ToystallerPlatforms;
        if (platforms && platforms['facebook']) return platforms['facebook'];
        if (window.ToystallerActivePlatform) return window.ToystallerActivePlatform;
        return FALLBACK_PLATFORM;
    }
};

function injectDownloadButtons() {
    if (isRawMediaTab()) return;

    // Purge any foreign generic Toystaller overlays to prevent 2px blurry duplicate button rendering
    document.querySelectorAll('.magic-dl-overlay:not([data-toystaller-fb])').forEach(ov => ov.remove());

    const platform = PlatformManager.getPlatform();
    const hasModal = platform.hasActiveModal();

    // Re-sync existing overlay displays when modal state changes
    if (window.magicOverlayManager) {
        window.magicOverlayManager.updateAllPositions();
    }

    const mediaElements = Array.from(document.querySelectorAll('video, img, svg image, image, div[role="img"]')).filter(media => {
        // Skip background divs that contain real img or video elements
        if (media.tagName.toLowerCase() === 'div') {
            if (media.querySelector('img, video, svg image, image')) return false;
            const bg = window.getComputedStyle(media).backgroundImage;
            if (!bg || bg === 'none' || !bg.startsWith('url(')) return false;
        }

        // Strict DOM-level attribute check: prevents duplicate overlay attachments across cycles or scripts
        if (media.getAttribute('data-toystaller-bound') === 'true') return false;
        if (media.closest('[data-toystaller-bound="true"]')) return false;

        return true;
    });

    mediaElements.forEach(media => {
        if (platform.isThumbnail(media)) return;
        
        // If a modal is open, strictly ignore any media not inside the modal
        if (hasModal && !platform.isInsideModal(media)) return;

        const isVideo = media.tagName.toLowerCase() === 'video';

        // 1. Photo tile deduplication: strictly 1 media element per individual photo container
        if (!isVideo) {
            const tile = media.closest ? media.closest(
                'a[href*="/photo"], a[href*="/photos/"], a[href*="photo.php"], ' +
                'div[data-visualcompletion*="media"], div[data-visualcompletion="ignore-dynamic-extra-coverage"], ' +
                'div[role="button"][tabindex]'
            ) : null;
            if (tile) {
                const innerImgs = tile.querySelectorAll('img, div[role="img"]');
                if (innerImgs.length <= 1) {
                    if (tile.__toystallerBoundMedia && tile.__toystallerBoundMedia.isConnected && tile.__toystallerBoundMedia !== media) {
                        return; // Tile already has an active media element
                    }
                    tile.__toystallerBoundMedia = media;
                }
            }

            // Exclude blur placeholders if a non-blurred sibling exists
            const cls = (media.className && typeof media.className === 'string') ? media.className.toLowerCase() : '';
            if (cls.includes('blur') || (media.getAttribute('aria-hidden') === 'true')) {
                if (media.parentElement && media.parentElement.querySelector('img:not([aria-hidden="true"])')) {
                    return;
                }
            }
        }

        // 3. Skip if overlay already exists for this media element
        if (window.magicOverlayManager && window.magicOverlayManager.hasOverlay(media)) {
            return;
        }

        if (window.magicOverlayManager && !window.magicOverlayManager.overlays.has(media)) {
            media.setAttribute('data-toystaller-bound', 'true');
            if (media.parentElement && (media.parentElement.getAttribute('role') === 'img' || media.parentElement.tagName.toLowerCase() === 'div')) {
                media.parentElement.setAttribute('data-toystaller-bound', 'true');
            }

            const magicId = Math.random().toString(36).substring(2, 15);
            if (isVideo) {
                media.dataset.magicId = magicId;
            }

            const scale = platform.getButtonScale(media);

            const createButtonsFn = () => {
                const buttons = [];

                const makeBtnStyle = (bgColor) => `
                    padding: ${Math.round(7 * scale)}px;
                    background-color: ${bgColor};
                    color: white;
                    border: 1.5px solid rgba(255,255,255,0.85);
                    border-radius: 7px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: auto;
                    opacity: 0.65;
                    transition: opacity 0.15s ease, background-color 0.15s ease, transform 0.1s ease;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.45);
                    transform: scale(${scale});
                    transform-origin: center;
                    margin: 0 3px;
                `;

                const iconSize = Math.round(16 * scale);

                const getHighResImageUrl = () => {
                    let finalUrl = media.currentSrc || media.src;
                    if (!finalUrl && (media.tagName.toLowerCase() === 'image' || media.tagName.toLowerCase() === 'svg')) {
                        finalUrl = media.getAttribute('xlink:href') || 
                                   media.getAttribute('href') || 
                                   (media.href && media.href.baseVal ? media.href.baseVal : null);
                    }
                    if (!finalUrl && (media.tagName.toLowerCase() === 'div' || media.getAttribute('role') === 'img')) {
                        const bg = window.getComputedStyle(media).backgroundImage;
                        if (bg && bg.startsWith('url(')) {
                            finalUrl = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
                        }
                    }
                    
                    if (media.srcset) {
                        const srcsetItems = media.srcset.split(',').map(s => s.trim().split(' '));
                        if (srcsetItems.length > 0) {
                            const largest = srcsetItems.sort((a, b) => {
                                const wA = parseInt(a[1] || '0');
                                const wB = parseInt(b[1] || '0');
                                return wB - wA;
                            })[0];
                            if (largest && largest[0]) {
                                finalUrl = largest[0];
                            }
                        }
                    }
                    
                    if (finalUrl) {
                        const lower = finalUrl.toLowerCase();
                        if (lower.startsWith('blob:') || lower.startsWith('data:')) return null;
                        if (lower.includes('//www.facebook.com') || lower.includes('//facebook.com') || lower.includes('//web.facebook.com')) return null;
                    }
                    
                    return finalUrl;
                };

                // Blue Button: Open Video/Image in new tab (Blue hover)
                const openBtn = document.createElement('button');
                openBtn.className = 'magic-open-btn';
                openBtn.title = isVideo ? 'Open HD Video / Reel in new tab' : 'Open photo in new tab';
                openBtn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
                openBtn.style.cssText = makeBtnStyle('rgba(30, 30, 30, 0.75)');

                openBtn.addEventListener('mouseenter', () => {
                    openBtn.style.opacity = '1';
                    openBtn.style.backgroundColor = 'rgba(52, 152, 219, 0.95)';
                    openBtn.style.transform = `scale(${scale * 1.08})`;
                });
                openBtn.addEventListener('mouseleave', () => {
                    openBtn.style.opacity = '0.65';
                    openBtn.style.backgroundColor = 'rgba(30, 30, 30, 0.75)';
                    openBtn.style.transform = `scale(${scale})`;
                });

                openBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    if (!isVideo) {
                        const imgMagicId = Math.random().toString(36).substring(2, 15);
                        media.setAttribute('data-toystaller-active', imgMagicId);
                        let resolved = false;
                        const handler = (ev) => {
                            if (!ev.data || ev.data.type !== 'magic_response_react_url_' + imgMagicId) return;
                            if (resolved) return;
                            resolved = true;
                            window.removeEventListener('message', handler);
                            safeSendMessage({ action: 'openInNewTab', url: ev.data.url || getHighResImageUrl() });
                        };
                        window.addEventListener('message', handler);
                        window.postMessage({ type: 'magic_get_react_url', id: imgMagicId, isVideo: false }, '*');
                        setTimeout(() => {
                            if (resolved) return;
                            resolved = true;
                            window.removeEventListener('message', handler);
                            safeSendMessage({ action: 'openInNewTab', url: getHighResImageUrl() });
                        }, 250);
                        return;
                    }

                    // --- Video / Reel Extraction ---
                    const openVideo = (url, audioUrl) => {
                        const clean = cleanVideoUrl(url);
                        const cleanAudio = cleanVideoUrl(audioUrl);
                        if (clean && isValidVideoUrl(clean)) {
                            safeSendMessage({ action: 'openInNewTab', url: clean, audioUrl: cleanAudio, isVideo: true });
                        } else {
                            alert('Could not find the HD video URL yet.\n\nTip: Make sure the video has started playing, then click the button again.');
                        }
                    };

                    const currentId = platform.extractVideoId ? platform.extractVideoId(media) : null;
                    console.log(`[Toystaller] Clicked Video/Reel element. Extracted target ID: [${currentId}]`);

                    // Check if cached video resolution matches the currently active video/reel
                    if (openBtn.__resolvedVideoUrl && isValidVideoUrl(openBtn.__resolvedVideoUrl)) {
                        if (!currentId || !openBtn.__resolvedVideoId || openBtn.__resolvedVideoId === currentId) {
                            console.log(`[Toystaller] Opening from validated cache for Reel [${currentId}]:`, openBtn.__resolvedVideoUrl);
                            openVideo(openBtn.__resolvedVideoUrl, openBtn.__resolvedAudioUrl);
                            return;
                        } else {
                            delete openBtn.__resolvedVideoUrl;
                            delete openBtn.__resolvedAudioUrl;
                            delete openBtn.__resolvedVideoId;
                        }
                    }

                    // Loading indicator on button
                    openBtn.style.opacity = '0.35';
                    openBtn.style.pointerEvents = 'none';

                    let resolved = false;

                    // Fast-path: Fetch master progressive stream with synchronized audio directly via same-origin fetch
                    if (currentId) {
                        fetchMasterProgressiveUrl(currentId).then(masterUrl => {
                            if (resolved) return;
                            if (masterUrl && isValidVideoUrl(masterUrl)) {
                                resolved = true;
                                openBtn.style.opacity = '1';
                                openBtn.style.pointerEvents = 'auto';
                                openBtn.__resolvedVideoUrl = masterUrl;
                                openBtn.__resolvedAudioUrl = null;
                                openBtn.__resolvedVideoId = currentId;
                                console.log(`[Toystaller] Fast-path master progressive stream resolved with audio for [${currentId}]!`);
                                openVideo(masterUrl, null);
                            }
                        }).catch(() => {});
                    }

                    // Safe extraction with retry loop
                    let attempts = 0;
                    const maxAttempts = 6;

                    const tryExtract = () => {
                        if (resolved) return;
                        attempts++;
                        getMediaUrl((url, audioUrl, returnedVideoId, isMaster) => {
                            if (resolved) return;

                            // If a specific Reel ID is expected, reject mismatching streams
                            if (currentId && returnedVideoId && returnedVideoId !== currentId) {
                                console.warn(`[Toystaller] Returned ID (${returnedVideoId}) does not match active Reel (${currentId}), retrying...`);
                                url = null;
                            }

                            const isMasterProgressive = isMaster || isProgressiveStream(url);

                            if (url && isValidVideoUrl(url) && (audioUrl || isMasterProgressive)) {
                                resolved = true;
                                openBtn.style.opacity = '1';
                                openBtn.style.pointerEvents = 'auto';
                                openBtn.__resolvedVideoUrl = url;
                                openBtn.__resolvedAudioUrl = audioUrl;
                                openBtn.__resolvedVideoId = currentId || returnedVideoId;
                                console.log(`[Toystaller] Successfully resolved Reel [${currentId || returnedVideoId}]:`, {
                                    video: url,
                                    audio: audioUrl,
                                    isMasterProgressive: isMasterProgressive
                                });
                                openVideo(url, audioUrl);
                                return;
                            }

                            if (attempts < maxAttempts) {
                                console.log(`[Toystaller] Stream buffering (attempt ${attempts}/${maxAttempts}), retrying in 350ms...`);
                                if (media.paused && media.currentTime === 0) {
                                    try { media.play().catch(() => {}); } catch(e) {}
                                }
                                setTimeout(tryExtract, 350);
                            } else {
                                if (resolved) return;
                                openBtn.style.opacity = '1';
                                openBtn.style.pointerEvents = 'auto';

                                // Automatic seamless background reload extraction:
                                // Reloads the Reel URL in backend pipeline to extract master progressive stream with audio
                                const reelUrl = currentId ? `https://www.facebook.com/reel/${currentId}` : (window.location.href.includes('/reel/') ? window.location.href : null);
                                if (reelUrl) {
                                    console.log(`[Toystaller] Launching seamless reload extraction for [${currentId}]...`);
                                    safeSendMessage({
                                        action: 'autoReloadReelAndOpen',
                                        reelUrl: reelUrl,
                                        videoId: currentId
                                    });
                                } else if (url && isValidVideoUrl(url)) {
                                    openVideo(url, audioUrl);
                                } else {
                                    alert('Toystaller: Could not load the media stream for this Reel.\n\nTip: Please let the Reel play for a second, then click the button again.');
                                }
                            }
                        }, true, currentId);
                    };

                    tryExtract();
                });

                buttons.push(openBtn);

                // Red Button: Open Thumbnail/Poster/Photo in new tab (Red hover)
                const imgBtn = document.createElement('button');
                imgBtn.className = 'magic-img-btn';
                imgBtn.title = isVideo ? 'Open thumbnail in new tab' : 'Open photo in new tab';
                imgBtn.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
                imgBtn.style.cssText = makeBtnStyle('rgba(30, 30, 30, 0.75)');

                imgBtn.addEventListener('mouseenter', () => {
                    imgBtn.style.opacity = '1';
                    imgBtn.style.backgroundColor = 'rgba(231, 76, 60, 0.95)';
                    imgBtn.style.transform = `scale(${scale * 1.08})`;
                });
                imgBtn.addEventListener('mouseleave', () => {
                    imgBtn.style.opacity = '0.65';
                    imgBtn.style.backgroundColor = 'rgba(30, 30, 30, 0.75)';
                    imgBtn.style.transform = `scale(${scale})`;
                });

                imgBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    if (isVideo) {
                        let poster = media.getAttribute('poster');
                        if (!poster) {
                            let current = media;
                            for (let i = 0; i < 4 && current && !poster; i++) {
                                const img = current.querySelector ? current.querySelector('img') : null;
                                if (img && img.src && !img.src.startsWith('data:')) {
                                    poster = img.src;
                                }
                                current = current.parentElement;
                            }
                        }
                        if (poster) {
                            safeSendMessage({ action: 'openInNewTab', url: poster });
                        } else {
                            alert('No thumbnail image available for this video.');
                        }
                    } else {
                        safeSendMessage({ action: 'openInNewTab', url: getHighResImageUrl() });
                    }
                });

                buttons.push(imgBtn);

                return buttons;
            };

            // Pre-resolve video URL to conditionally show/hide the blue button
            const preResolveVideoUrl = (openBtn) => {
                if (!isVideo) return;
                const currentId = platform.extractVideoId ? platform.extractVideoId(media) : null;
                getMediaUrl((url, audioUrl) => {
                    const clean = cleanVideoUrl(url);
                    if (clean && isValidVideoUrl(clean)) {
                        openBtn.__resolvedVideoUrl = clean;
                        openBtn.__resolvedAudioUrl = cleanVideoUrl(audioUrl);
                        openBtn.__resolvedVideoId = currentId;
                        openBtn.style.display = 'flex';
                    }
                }, true, currentId);
            };

            const getMediaUrl = (callback, silent = false, videoId = null) => {
                if (isVideo) {
                    let resolved = false;
                    const currentId = videoId || (platform.extractVideoId ? platform.extractVideoId(media) : null);
                    const handler = (e) => {
                        if (!e.data || e.data.type !== 'magic_response_react_url_' + magicId) return;
                        if (resolved) return;
                        resolved = true;
                        window.removeEventListener('message', handler);
                        const clean = cleanVideoUrl(e.data.url);
                        const cleanAudio = cleanVideoUrl(e.data.audioUrl);
                        if (clean && isValidVideoUrl(clean)) {
                            callback(clean, cleanAudio, e.data.videoId, e.data.isMasterProgressive);
                        } else {
                            getMediaUrlFallback(callback, silent, currentId);
                        }
                    };
                    window.addEventListener('message', handler);
                    // Mark element so main-world interceptor finds the exact clicked element
                    media.setAttribute('data-toystaller-active', magicId);
                    window.postMessage({ type: 'magic_get_react_url', id: magicId, isVideo: isVideo, videoId: currentId }, '*');

                    setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        window.removeEventListener('message', handler);
                        getMediaUrlFallback(callback, silent, currentId);
                    }, 400);
                    return;
                }

                getMediaUrlFallback(callback, silent, null);
            };

            const getMediaUrlFallback = (callback, silent = false, videoId = null) => {
                const candidates = [];

                // 1. Direct scan of document <script> tags matching videoId
                if (isVideo) {
                    const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
                    const cdnRegex = /"(https:(?:\\\/\\\/|\/\/)[^"]+?(?:fbcdn\.net|fbsbx\.com)[^"]+?\.(?:mp4|m4v)[^"]*)"/g;
                    
                    if (videoId) {
                        for (const s of scripts) {
                            const text = s.textContent;
                            if (text && text.includes(videoId)) {
                                let m;
                                while ((m = cdnRegex.exec(text)) !== null) {
                                    try {
                                        const u = cleanVideoUrl(JSON.parse('"' + m[1] + '"'));
                                        if (u && isValidVideoUrl(u)) candidates.push(u);
                                    } catch(e) {
                                        const u = cleanVideoUrl(m[1]);
                                        if (u && isValidVideoUrl(u)) candidates.push(u);
                                    }
                                }
                            }
                        }
                    }

                    // If no candidate was found for videoId and no specific videoId was requested, scan scripts
                    if (candidates.length === 0 && !videoId) {
                        for (const s of scripts) {
                            const text = s.textContent;
                            if (text && (text.includes('playable_url_quality_hd') || text.includes('browser_native_hd_url') || text.includes('playable_url'))) {
                                let m;
                                while ((m = cdnRegex.exec(text)) !== null) {
                                    try {
                                        const u = cleanVideoUrl(JSON.parse('"' + m[1] + '"'));
                                        if (u && isValidVideoUrl(u)) candidates.push(u);
                                    } catch(e) {
                                        const u = cleanVideoUrl(m[1]);
                                        if (u && isValidVideoUrl(u)) candidates.push(u);
                                    }
                                }
                            }
                        }
                    }
                }

                // 2. Check in-memory intercepted video URLs from live fetch/XHR
                if (isVideo && pageInterceptedVideoUrls.size > 0) {
                    for (const u of pageInterceptedVideoUrls) {
                        const clean = cleanVideoUrl(u);
                        if (clean && isValidVideoUrl(clean)) {
                            if (videoId) {
                                const meta = parseStreamMetadata(clean);
                                if (meta && meta.videoId === videoId) {
                                    candidates.push(clean);
                                }
                            } else {
                                candidates.push(clean);
                            }
                        }
                    }
                }

                if (candidates.length > 0) {
                    const best = pickBestVideoUrl(candidates);
                    if (best && isValidVideoUrl(best)) {
                        callback(best, null, videoId);
                        return;
                    }
                }

                // 3. Fallback to background script webRequest
                safeSendMessage({ action: 'getMediaUrls', mediaType: isVideo ? 'video' : 'img' }, (response) => {
                    if (response && response.urls && response.urls.length > 0) {
                        const cleaned = response.urls.map(cleanVideoUrl).filter(Boolean);
                        const bgCandidates = cleaned.filter(isValidVideoUrl).filter(u => {
                            if (!videoId) return true;
                            const meta = parseStreamMetadata(u);
                            return meta && meta.videoId === videoId;
                        });
                        if (bgCandidates.length > 0) {
                            const best = pickBestVideoUrl(bgCandidates);
                            if (best && isValidVideoUrl(best)) {
                                callback(best, null, videoId);
                                return;
                            }
                        }
                    }
                    callback(null, null, videoId);
                });
            };

            if (window.magicOverlayManager) {
                window.magicOverlayManager.addOverlay(media, createButtonsFn);
                if (isVideo) {
                    const doPreResolve = () => {
                        const overlay = window.magicOverlayManager.overlays.get(media);
                        if (overlay && overlay.container) {
                            const openBtn = overlay.container.querySelector('.magic-open-btn');
                            if (openBtn) {
                                preResolveVideoUrl(openBtn);
                            }
                        }
                    };
                    setTimeout(doPreResolve, 200);
                    media.addEventListener('play', doPreResolve, { passive: true });
                    media.addEventListener('playing', doPreResolve, { passive: true });
                }
            }
        }
    });
}

let injectTimer = null;
function scheduleInject() {
    if (injectTimer) return;
    injectTimer = setTimeout(() => {
        injectTimer = null;
        injectDownloadButtons();
    }, 150);
}

// Automatically boot for Facebook
bootToystaller();

// --- Dashboard UI Injection ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggleDashboard') {
        toggleDashboardOverlay();
        sendResponse({ success: true });
    }
});

let dashboardHost = null;

function toggleDashboardOverlay() {
    if (dashboardHost) {
        dashboardHost.remove();
        dashboardHost = null;
        return;
    }

    dashboardHost = document.createElement('div');
    dashboardHost.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 2147483647;';
    document.body.appendChild(dashboardHost);

    const shadow = dashboardHost.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
        <style>
            :host {
                all: initial;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .dashboard {
                width: 320px;
                background: rgba(20, 20, 20, 0.85);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 16px;
                padding: 20px;
                color: #fff;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                animation: slideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            }
            @keyframes slideIn {
                from { opacity: 0; transform: translateY(-20px) scale(0.95); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }
            .header h2 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                background: linear-gradient(135deg, #1877f2 0%, #00f2fe 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            .close-btn {
                background: none;
                border: none;
                color: #aaa;
                cursor: pointer;
                font-size: 20px;
                transition: color 0.2s;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                border-radius: 4px;
            }
            .close-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
            .info-row {
                font-size: 13px;
                color: #aaa;
                text-align: center;
                padding: 8px 0;
            }
            .specialization {
                margin-top: 10px;
                padding: 12px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                font-size: 12px;
                line-height: 1.5;
                color: #ddd;
                border-left: 3px solid #1877f2;
            }
        </style>
        
        <div class="dashboard">
            <div class="header">
                <h2>Toystaller v6 — Facebook</h2>
                <button class="close-btn" id="closeBtn" title="Close">&times;</button>
            </div>
            <div class="info-row">
                Active on Facebook
            </div>
            <div class="specialization">
                <strong>Features:</strong><br/>
                • Watch & Reels HD Video Extraction<br/>
                • Theater Mode Full-Resolution Photo Downloads<br/>
                • News Feed & Group Media Downloads<br/>
                • Zero Overlay Bleed & Instant Dialog Isolation
            </div>
        </div>
    `;

    shadow.getElementById('closeBtn').addEventListener('click', toggleDashboardOverlay);
}
